import { expect, test } from "bun:test";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ProxyOptions } from "../src/shared/contracts";

test("raw gateway leaves Responses bytes and lifecycle routes at the upstream", async () => {
  // Given: raw mode must not acquire local storage or a WebSocket transport.
  const received: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
      return Response.json({ upstream: true });
    },
  });
  const options: ProxyOptions = {
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    defaultModel: "fixture-model",
    clientVersion: "fixture",
    translationMode: "raw",
    timeoutMs: 2000,
    maxBodyBytes: 1024 * 1024,
  };
  const gateway = createResponsesGateway(options, async () => ({
    accessToken: "fixture-token",
    accountId: "fixture-account",
  }));
  try {
    // When: a stored create and retrieve pass through the integrated gateway.
    const body = '{ "input":"hello", "store":true }';
    const created = await gateway.forward(
      new Request("http://local/v1/responses", {
        method: "POST",
        body,
      }),
    );
    const retrieved = await gateway.forward(new Request("http://local/v1/responses/resp_unknown"));
    // Then: raw forwarding preserves the payload and does not return a local 404.
    expect(created.status).toBe(200);
    expect(retrieved.status).toBe(200);
    expect(received).toEqual([
      `POST /backend-api/codex/responses ${body}`,
      "GET /backend-api/codex/responses/resp_unknown ",
    ]);
  } finally {
    gateway.close();
    upstream.stop(true);
  }
});

test("integrated minimal gateway stores responses and clears them on account change", async () => {
  const upstream = Bun.serve<{ turn: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { turn: 0 } })) return undefined;
      return new Response("Expected WebSocket", { status: 400 });
    },
    websocket: {
      message(socket) {
        socket.data.turn++;
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_integrated_${socket.data.turn}`,
              object: "response",
              status: "completed",
              created_at: 1,
              model: "fixture-model",
              store: false,
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "READY" }],
                },
              ],
            },
          }),
        );
      },
    },
  });
  let account = "account-one";
  const gateway = createResponsesGateway(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      defaultModel: "fixture-model",
      clientVersion: "fixture",
      translationMode: "minimal",
      timeoutMs: 2000,
      maxBodyBytes: 1024 * 1024,
    },
    async () => ({ accessToken: "fixture-token", accountId: account }),
  );
  try {
    const response = await gateway.forward(
      new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ input: "hello", store: true }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "resp_integrated_1", store: true });
    const saved = await gateway.forward(new Request("http://local/v1/responses/resp_integrated_1"));
    expect(saved.status).toBe(200);
    account = "account-two";
    const old = await gateway.forward(new Request("http://local/v1/responses/resp_integrated_1"));
    expect(old.status).toBe(404);
  } finally {
    gateway.close();
    upstream.stop(true);
  }
});
