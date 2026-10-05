import { expect, test } from "bun:test";
import { forward } from "../../src/server/upstream";
import { credentials, fixture, sse } from "./proxy-harness";

test("times out when the upstream never returns headers", async () => {
  // Given: a held response with a short configured deadline.
  const hold = Promise.withResolvers<Response>();
  const server = fixture(() => hold.promise, { timeoutMs: 50 });
  try {
    // When: the caller waits for the upstream response.
    const result = await fetch(`${server.url}/models`);
    // Then: the proxy returns a bounded timeout error.
    expect(result.status).toBe(504);
    expect(await result.json()).toMatchObject({ error: { code: "upstream_timeout" } });
  } finally {
    hold.resolve(new Response("released"));
    server.close();
  }
});

test("keeps the timeout active after headers while a nonstreaming response is incomplete", async () => {
  // Given: an upstream that sends a header and event but no completion.
  const server = fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse({ type: "response.created" })));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { timeoutMs: 50 },
  );
  try {
    // When: the proxy waits to extract a final response.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":"Hi"}',
    });
    // Then: response-body time is covered by the same deadline.
    expect(result.status).toBe(504);
    expect(await result.json()).toMatchObject({ error: { code: "upstream_timeout" } });
  } finally {
    server.close();
  }
});

test("ends a timed-out stream with an SSE error event instead of a silent success", async () => {
  // Given: an SSE upstream that sends one event and then stalls.
  const server = fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse({ type: "response.created" })));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { timeoutMs: 50 },
  );
  try {
    // When: a connected client reads the stream past the deadline.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":[],"stream":true}',
    });
    // Then: the truncation is announced in-band, where OpenAI SDKs raise an APIError.
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toContain("response.created");
    expect(text).toContain("event: error");
    expect(text).toContain('"code":"upstream_timeout"');
  } finally {
    server.close();
  }
});

test("cancels the upstream when the downstream client aborts an active SSE request", async () => {
  // Given: an upstream stream that records socket cancellation.
  const aborted = Promise.withResolvers<void>();
  const server = fixture((request) => {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse({ type: "future" })));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const controller = new AbortController();
  try {
    // When: the client aborts after observing the first bytes.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":[],"stream":true}',
      signal: controller.signal,
    });
    await result.body?.getReader().read();
    controller.abort();
    // Then: cancellation reaches the live upstream request.
    await aborted.promise;
    expect(controller.signal.aborted).toBe(true);
  } finally {
    controller.abort();
    server.close();
  }
}, 1500);

test("bounds credential resolution with the same request deadline", async () => {
  // Given: a credential provider that remains unresolved.
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof credentials>>>();
  const server = fixture(() => new Response("unexpected"), { timeoutMs: 25 });
  try {
    // When: forwarding requires credentials before an upstream connection.
    const result = forward(
      new Request(`${server.url}/models`),
      server.options,
      () => pending.promise,
    );
    // Then: credential waits cannot outlive the request timeout.
    await expect(result).rejects.toMatchObject({ status: 504, code: "upstream_timeout" });
  } finally {
    pending.resolve(await credentials());
    server.close();
  }
}, 1000);
