import { expect, test } from "bun:test";
import OpenAI from "openai";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { CredentialProvider, ProxyOptions } from "../src/shared/contracts";

const options: ProxyOptions = {
  baseUrl: "",
  defaultModel: "fixture-model",
  clientVersion: "fixture",
  translationMode: "minimal",
  timeoutMs: 1000,
  maxBodyBytes: 4096,
};

function request(body: Record<string, unknown>, headers?: Record<string, string>): Request {
  return new Request("http://local/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function fixture(
  message: (socket: Bun.ServerWebSocket<undefined>, body: Record<string, unknown>) => void,
  overrides: Partial<ProxyOptions> = {},
  credentials: CredentialProvider = async () => ({ accessToken: "fixture", accountId: "fixture" }),
) {
  const headers: Headers[] = [];
  const closed = Promise.withResolvers<void>();
  const upstream = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      headers.push(request.headers);
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket, frame) {
        message(socket, JSON.parse(String(frame)) as Record<string, unknown>);
      },
      close() {
        closed.resolve();
      },
    },
  });
  const gateway = createResponsesGateway(
    { ...options, ...overrides, baseUrl: `${upstream.url.origin}/backend-api/codex` },
    credentials,
  );
  return {
    headers,
    closed: closed.promise,
    gateway,
    close() {
      gateway.close();
      upstream.stop(true);
    },
  };
}

function completed(socket: Bun.ServerWebSocket<undefined>, id = "resp_first") {
  socket.send(JSON.stringify({ type: "response.completed", response: { id, output: [] } }));
}

test("integrated gateway preserves explicit session-id before deriving cache affinity", async () => {
  const local = fixture((socket) => completed(socket));
  try {
    const response = await local.gateway.forward(
      request({ input: "hello", prompt_cache_key: "derived" }, { "session-id": "explicit" }),
    );
    expect(response.status).toBe(200);
    expect(local.headers[0]?.get("session-id")).toBe("explicit");
  } finally {
    local.close();
  }
});

test("concurrent continuations cannot both pass a delayed credential lookup", async () => {
  let delayCredentials = false;
  let turns = 0;
  const local = fixture(
    (socket) => {
      turns++;
      if (turns === 1) completed(socket);
      else setTimeout(() => completed(socket, `resp_${turns}`), 20);
    },
    {},
    async () => {
      if (delayCredentials) await Bun.sleep(20);
      return { accessToken: "fixture", accountId: "fixture" };
    },
  );
  try {
    await local.gateway.forward(request({ input: "first" }));
    delayCredentials = true;
    const a = local.gateway.forward(request({ input: "a", previous_response_id: "resp_first" }));
    const b = local.gateway.forward(request({ input: "b", previous_response_id: "resp_first" }));
    const responses = await Promise.all([a, b]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(turns).toBe(2);
  } finally {
    local.close();
  }
});

test("gateway deadline includes a slow upload before lifecycle parsing", async () => {
  let turns = 0;
  const local = fixture(
    (socket) => {
      turns++;
      completed(socket);
    },
    { timeoutMs: 40 },
  );
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await Bun.sleep(120);
      if (cancelled) return;
      controller.enqueue(new TextEncoder().encode('{"input":"slow"}'));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    const response = await local.gateway.forward(
      new Request("http://local/v1/responses", { method: "POST", body }),
    );
    expect(response.status).toBe(504);
    expect(turns).toBe(0);
  } finally {
    local.close();
  }
});

test("gateway rejects an oversized native event before returning JSON", async () => {
  const local = fixture((socket) => {
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_large", output: [], extra: "x".repeat(5000) },
      }),
    );
  });
  try {
    const response = await local.gateway.forward(request({ input: "hello" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "body_too_large" } });
  } finally {
    local.close();
  }
});

test("gateway bounds the sum of completed output items, not just each event", async () => {
  const local = fixture((socket) => {
    for (let i = 0; i < 3; i++)
      socket.send(
        JSON.stringify({
          type: "response.output_item.done",
          output_index: i,
          item: { id: `msg_${i}`, text: "x".repeat(1600) },
        }),
      );
    completed(socket);
  });
  try {
    const response = await local.gateway.forward(request({ input: "hello" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "body_too_large" } });
  } finally {
    local.close();
  }
});

test("a stalled SSE consumer gets an explicit bounded-buffer error", async () => {
  const local = fixture((socket) => {
    for (let i = 0; i < 30; i++)
      socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(1000) }));
    completed(socket);
  });
  try {
    const response = await local.gateway.forward(request({ input: "hello", stream: true }));
    await Bun.sleep(30);
    const text = await response.text();
    expect(text).toContain('"code":"slow_consumer"');
    expect(text).not.toContain('"type":"response.completed"');
    await local.closed;
  } finally {
    local.close();
  }
});

test("minimal SSE omits identified native telemetry but preserves unknown extensions and terminal output", async () => {
  const local = fixture((socket) => {
    for (const type of [
      "codex.rate_limits",
      "codex.response.metadata",
      "responsesapi.websocket_timing",
      "vendor.future",
    ])
      socket.send(JSON.stringify({ type, sequence_number: 7, extra: "preserved" }));
    socket.send(
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "msg_done", type: "message" },
      }),
    );
    completed(socket);
  });
  try {
    const response = await local.gateway.forward(request({ input: "hello", stream: true }));
    const text = await response.text();
    expect(
      text.includes("codex.rate_limits") ||
        text.includes("codex.response.metadata") ||
        text.includes("responsesapi.websocket_timing"),
    ).toBe(false);
    expect(text).toContain('"type":"vendor.future","sequence_number":7,"extra":"preserved"');
    expect(text).toContain('"output":[{"id":"msg_done","type":"message"}]');
  } finally {
    local.close();
  }
});

test("an incomplete JSON terminal retains completed output and its error status", async () => {
  const local = fixture((socket) => {
    socket.send(
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "msg_partial", type: "message" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "response.incomplete",
        response: {
          id: "resp_partial",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
      }),
    );
  });
  try {
    const response = await local.gateway.forward(request({ input: "hello" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      status: "incomplete",
      output: [{ id: "msg_partial" }],
      incomplete_details: { reason: "max_output_tokens" },
    });
  } finally {
    local.close();
  }
});

test("gateway rejects an oversized upload before waiting for EOF", async () => {
  const local = fixture((socket) => completed(socket), { timeoutMs: 100 });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    const response = await local.gateway.forward(
      new Request("http://local/v1/responses", { method: "POST", body }),
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(local.headers).toHaveLength(0);
  } finally {
    local.close();
  }
});

test("credential lookup is inside the gateway deadline", async () => {
  const local = fixture(
    (socket) => completed(socket),
    { timeoutMs: 30 },
    async () => {
      await Bun.sleep(100);
      return { accessToken: "fixture", accountId: "fixture" };
    },
  );
  try {
    const response = await local.gateway.forward(request({ input: "hello" }));
    expect(response.status).toBe(504);
    await Bun.sleep(110);
    expect(local.headers).toHaveLength(0);
  } finally {
    local.close();
  }
});

test("the deadline is not restarted between upload and credential phases", async () => {
  const local = fixture(
    (socket) => completed(socket),
    { timeoutMs: 90 },
    async () => {
      await Bun.sleep(60);
      return { accessToken: "fixture", accountId: "fixture" };
    },
  );
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await Bun.sleep(60);
      controller.enqueue(new TextEncoder().encode('{"input":"hello"}'));
      controller.close();
    },
  });
  try {
    const response = await local.gateway.forward(
      new Request("http://local/v1/responses", { method: "POST", body }),
    );
    expect(response.status).toBe(504);
    expect(local.headers).toHaveLength(0);
  } finally {
    local.close();
  }
});

test("SDK receives SSE before terminal completion and cancelling closes the native turn", async () => {
  const local = fixture((socket) => {
    socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "EARLY" }));
  });
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => local.gateway.forward(request),
  });
  try {
    const client = new OpenAI({
      baseURL: `${http.url.origin}/v1`,
      apiKey: "fixture",
      maxRetries: 0,
    });
    const stream = await client.responses.create({
      input: "hello",
      model: "fixture-model",
      stream: true,
    });
    for await (const event of stream) {
      expect(event).toMatchObject({ type: "response.output_text.delta", delta: "EARLY" });
      break;
    }
    await Promise.race([
      local.closed,
      Bun.sleep(300).then(() => {
        throw new Error("Native turn was not cancelled");
      }),
    ]);
  } finally {
    http.stop(true);
    local.close();
  }
});

test("gateway exposes native errors and timeouts as SSE errors rather than false completion", async () => {
  for (const terminalError of [true, false]) {
    const local = fixture(
      (socket) => {
        if (terminalError)
          socket.send(
            JSON.stringify({
              type: "error",
              error: { code: "fixture_refusal", message: "refused" },
            }),
          );
      },
      { timeoutMs: 60 },
    );
    try {
      const response = await local.gateway.forward(request({ input: "hello", stream: true }));
      const text = await response.text();
      expect(text).toContain(terminalError ? "fixture_refusal" : "upstream_timeout");
      expect(text).not.toContain("response.completed");
    } finally {
      local.close();
    }
  }
});
