import { expect, test } from "bun:test";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { localTls } from "./fixtures/local-tls";
import { closed, connected, fixture } from "./fixtures/websocket-harness";

test("minimal Realtime refuses the known incompatible V1 intent before opening upstream", async () => {
  const server = fixture();
  try {
    const response = await fetch(
      `${server.url.replace("ws:", "http:")}/v1/realtime?intent=quicksilver`,
      {
        headers: { upgrade: "websocket" },
      },
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "realtime_protocol_not_adapted" });
  } finally {
    server.close();
  }
});

test("OpenAI SDK exchanges synthetic PCM and preserves public V2 errors and interruption without translating native events", async () => {
  const server = fixture({}, Promise.resolve(), "local-key", localTls);
  const client = new OpenAIRealtimeWS(
    { model: "fixture-v2", options: { tls: { rejectUnauthorized: false } } },
    { apiKey: "local-key", baseURL: `${server.url.replace(/^ws/, "http")}/v1` },
  );
  const errors: unknown[] = [];
  client.on("error", (error) => errors.push(error.error));
  try {
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", resolve);
      client.socket.once("error", reject);
    });
    const upstream = await server.upstreamSocket;
    const input = {
      type: "input_audio_buffer.append" as const,
      audio: Buffer.alloc(4800).toString("base64"),
    };
    const echo = new Promise<string>((resolve) =>
      client.socket.once("message", (data: unknown) => resolve(String(data))),
    );
    client.send(input);
    expect(JSON.parse(await echo)).toEqual(input);

    const output = Promise.withResolvers<{ delta: string; response_id: string }>();
    client.once("response.output_audio.delta", output.resolve);
    upstream.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        event_id: "evt_audio",
        response_id: "resp_audio",
        item_id: "item_audio",
        output_index: 0,
        content_index: 0,
        delta: "AAABAP//",
      }),
    );
    const audioEvent = await output.promise;
    expect(audioEvent).toMatchObject({ delta: "AAABAP//", response_id: "resp_audio" });
    expect([...Buffer.from(audioEvent.delta, "base64")]).toEqual([0, 0, 1, 0, 255, 255]);

    const cancelled = Promise.withResolvers<unknown>();
    client.once("response.done", cancelled.resolve);
    const cancelEcho = new Promise<string>((resolve) =>
      client.socket.once("message", (data: unknown) => resolve(String(data))),
    );
    client.send({ type: "response.cancel", response_id: "resp_audio" });
    expect(JSON.parse(await cancelEcho)).toEqual({
      type: "response.cancel",
      response_id: "resp_audio",
    });
    upstream.send(
      JSON.stringify({
        type: "response.done",
        event_id: "evt_cancel",
        response: { id: "resp_audio", status: "cancelled", output: [] },
      }),
    );
    expect(await cancelled.promise).toMatchObject({ response: { status: "cancelled" } });

    const error = Promise.withResolvers<void>();
    client.once("error", () => error.resolve());
    upstream.send(
      JSON.stringify({
        type: "error",
        event_id: "evt_error",
        error: {
          type: "invalid_request_error",
          code: "unsupported_option",
          message: "Fixture refusal",
          param: "session.future",
        },
      }),
    );
    await error.promise;
    expect(errors).toEqual([
      {
        type: "invalid_request_error",
        code: "unsupported_option",
        message: "Fixture refusal",
        param: "session.future",
      },
    ]);
    const closure = new Promise<number>((resolve) => client.socket.once("close", resolve));
    upstream.close(4001, "fixture session ended");
    expect(await closure).toBe(4001);
  } finally {
    client.close();
    server.close();
  }
});

test("raw V1 stays available without claiming public protocol compatibility", async () => {
  const server = fixture({ translationMode: "raw" });
  const socket = new WebSocket(`${server.url}/v1/realtime?intent=quicksilver&model=native`);
  try {
    await connected(socket);
    const reply = new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
    );
    const native = '{"type":"session.update","session":{"type":"quicksilver","future":null}}';
    socket.send(native);
    expect(await reply).toBe(native);
    expect(new URL((await server.received).url).search).toBe("?intent=quicksilver&model=native");
  } finally {
    socket.close();
    server.close();
  }
});

test("Realtime bounds queued synthetic audio while the upstream handshake is pending", async () => {
  const gate = Promise.withResolvers<void>();
  const server = fixture({ maxBodyBytes: 12000 }, gate.promise);
  const socket = new WebSocket(`${server.url}/v1/realtime?model=fixture-v2`);
  try {
    await connected(socket);
    const closure = closed(socket);
    const audio = JSON.stringify({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(4800).toString("base64"),
    });
    socket.send(audio);
    socket.send(audio);
    expect((await closure).code).toBe(1009);
  } finally {
    gate.resolve();
    socket.close();
    server.close();
  }
});

test("Realtime closes both peers on oversized synthetic audio output", async () => {
  const server = fixture({ maxBodyBytes: 1024 });
  const socket = new WebSocket(`${server.url}/v1/realtime?model=fixture-v2`);
  try {
    await connected(socket);
    const upstream = await server.upstreamSocket;
    const closure = closed(socket);
    upstream.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.alloc(800).toString("base64"),
      }),
    );
    expect((await closure).code).toBe(1009);
    await server.disconnected;
  } finally {
    socket.close();
    server.close();
  }
});

test("Realtime client disconnect closes upstream and does not resume audio", async () => {
  const server = fixture();
  const socket = new WebSocket(`${server.url}/v1/realtime?model=fixture-v2`);
  try {
    await connected(socket);
    await server.upstreamSocket;
    socket.close(1000, "interrupted");
    await server.disconnected;
  } finally {
    server.close();
  }
});

test.each([
  [{}, 401],
  [{ authorization: "Bearer wrong-key" }, 401],
  [{ authorization: "Bearer local-key", origin: "https://foreign.example" }, 403],
] as const)(
  "Realtime upgrade rejects unauthorized/foreign clients (%j)",
  async (headers, status) => {
    const server = fixture({}, Promise.resolve(), "local-key");
    try {
      const response = await fetch(`${server.url.replace("ws:", "http:")}/v1/realtime`, {
        headers: { ...headers, upgrade: "websocket" },
      });
      expect(response.status).toBe(status);
    } finally {
      server.close();
    }
  },
);

test("Realtime preserves native session correlation while replacing credentials under the Codex prefix", async () => {
  const server = fixture({}, Promise.resolve(), "local-key");
  const socket = new WebSocket(`${server.url}/v1/realtime?model=fixture-v2`, {
    protocols: ["oai-codex", "oai-codex-token.local-key"],
    headers: {
      "x-session-id": "fixture-session",
      "chatgpt-account-id": "spoofed",
      cookie: "private=cookie",
      "openai-beta": "realtime=v1",
    },
  });
  try {
    await connected(socket);
    const request = await server.received;
    expect(new URL(request.url).pathname).toBe("/backend-api/codex/realtime");
    expect(new URL(request.url).search).toBe("?model=fixture-v2");
    expect(request.headers.get("x-session-id")).toBe("fixture-session");
    expect(request.headers.get("authorization")).toBe("Bearer upstream-token");
    expect(request.headers.get("chatgpt-account-id")).toBe("upstream-account");
    expect(request.headers.get("openai-beta")).toBe("realtime=v1");
    for (const name of ["cookie", "origin", "sec-websocket-protocol"])
      expect(request.headers.has(name)).toBe(false);
  } finally {
    socket.close();
    server.close();
  }
});
