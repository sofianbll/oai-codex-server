import { expect, test } from "bun:test";
import { createResponsesBridge } from "../src/server/responses-ws-bridge";
import type { ProxyOptions } from "../src/shared/contracts";

const options: ProxyOptions = {
  baseUrl: "",
  timeoutMs: 1_000,
  maxBodyBytes: 1_000_000,
  defaultModel: "fixture-model",
  clientVersion: "fixture",
  translationMode: "minimal",
};

function request(body: Record<string, unknown>): Request {
  return new Request("http://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("bridges two HTTP JSON turns over one authenticated native WebSocket", async () => {
  const received: Record<string, unknown>[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket, frame) {
        const event = JSON.parse(String(frame)) as Record<string, unknown>;
        received.push(event);
        const id = received.length === 1 ? "resp_first" : "resp_second";
        socket.send(JSON.stringify({ type: "response.created", response: { id } }));
        socket.send(
          JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "message", id: `msg_${id}` },
          }),
        );
        socket.send(JSON.stringify({ type: "response.completed", response: { id, output: [] } }));
      },
    },
  });
  const bridge = createResponsesBridge(
    { ...options, baseUrl: `${upstream.url.origin}/backend-api/codex` },
    async () => ({ accessToken: "token", accountId: "account" }),
  );
  try {
    const first = await bridge.forward(
      request({ input: "first", prompt_cache_key: "cache-key", stream: false }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: "resp_first",
      output: [{ id: "msg_resp_first" }],
    });
    const second = await bridge.forward(
      request({ input: "second", previous_response_id: "resp_first", stream: false }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: "resp_second" });
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      type: "response.create",
      model: "fixture-model",
      instructions: "",
      store: false,
      input: [{ role: "user" }],
    });
    expect(received[0]).not.toHaveProperty("stream");
    expect(received[1]).toMatchObject({ previous_response_id: "resp_first" });
  } finally {
    bridge.close();
    upstream.stop(true);
  }
});

test("rejects unknown and account-mismatched continuations without HTTP fallback", async () => {
  let account = "account_a";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(_request, server) {
      return server.upgrade(_request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket) {
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: "resp_owned", output: [] },
          }),
        );
      },
    },
  });
  const bridge = createResponsesBridge(
    { ...options, baseUrl: `${upstream.url.origin}/backend-api/codex` },
    async () => ({ accessToken: "token", accountId: account }),
  );
  try {
    const unknown = await bridge.forward(
      request({ input: "x", previous_response_id: "resp_missing" }),
    );
    expect(unknown.status).toBe(404);
    await bridge.forward(request({ input: "first" }));
    account = "account_b";
    const mismatch = await bridge.forward(
      request({ input: "next", previous_response_id: "resp_owned" }),
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "previous_response_account_mismatch" },
    });
  } finally {
    bridge.close();
    upstream.stop(true);
  }
});

test("retains a native terminal error object for an HTTP caller", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket) {
        socket.send(
          JSON.stringify({
            type: "error",
            error: { code: "compact_rejected", message: "opaque item required" },
          }),
        );
      },
    },
  });
  const bridge = createResponsesBridge(
    { ...options, baseUrl: `${upstream.url.origin}/backend-api/codex` },
    async () => ({ accessToken: "token", accountId: "account" }),
  );
  try {
    const response = await bridge.forward(request({ input: "compact" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "compact_rejected", message: "opaque item required" },
    });
  } finally {
    bridge.close();
    upstream.stop(true);
  }
});
