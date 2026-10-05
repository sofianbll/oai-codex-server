import { expect, test } from "bun:test";
import OpenAI from "openai";
import { completed, fixture, sse } from "./fixtures/proxy-harness";

test("normalizes only Codex requirements when a Responses request is nonstreaming", async () => {
  // Given: a wire fixture accepting the Codex request contract.
  let received: unknown;
  const response = completed();
  const server = fixture(async (request) => {
    received = await request.json();
    return new Response(sse({ type: "response.completed", response }), {
      headers: { "content-type": "text/event-stream", "x-request-id": "req_fixture" },
    });
  });
  try {
    // When: the official SDK sends a conventional nonstreaming request.
    const client = new OpenAI({ apiKey: "local-key", baseURL: server.url, maxRetries: 0 });
    const result = await client.responses.create({
      model: "chosen-model",
      input: "Salut",
      stream: false,
    });
    // Then: the wire contract is adapted and the SDK receives the final response.
    expect(received).toEqual({
      model: "chosen-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "Salut" }] }],
      instructions: "",
      store: false,
      stream: true,
    });
    expect(result).toMatchObject(response);
    expect(result._request_id).toBe("req_fixture");
  } finally {
    server.close();
  }
});

test("preserves unknown request fields when applying missing defaults", async () => {
  // Given: a future-compatible payload accepted by the fixture.
  let received: unknown;
  const server = fixture(async (request) => {
    received = await request.json();
    return new Response(sse({ type: "response.completed", response: completed() }), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    // When: the caller omits optional defaults but sends future fields.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: JSON.stringify({
        input: "Hi",
        future: { opaque: [1, "é"] },
        tools: [{ type: "future_tool" }],
        reasoning: { effort: "low" },
      }),
    });
    // Then: only required defaults and string input change.
    expect(result.status).toBe(200);
    expect(received).toEqual({
      model: "fixture-model",
      instructions: "",
      store: false,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      future: { opaque: [1, "é"] },
      tools: [{ type: "future_tool" }],
      reasoning: { effort: "low" },
    });
    await result.arrayBuffer();
  } finally {
    server.close();
  }
});

test("delivers a tiny SSE event before EOF and preserves unknown events and Unicode bytes", async () => {
  // Given: EOF is gated until the client has received the first event.
  const release = Promise.withResolvers<void>();
  const first = 'event: future.event\r\ndata: {"type":"future.event","future":true}\r\n\r\n';
  const tail = sse({ type: "response.output_text.delta", delta: "été 🌍", extra: 42 });
  const encoder = new TextEncoder();
  const server = fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(first));
            await release.promise;
            for (const byte of encoder.encode(tail)) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  try {
    // When: a streaming caller reads while the upstream is still open.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: JSON.stringify({ input: [], stream: true }),
    });
    const reader = result.body?.getReader();
    if (!reader) throw new Error("Missing streamed response body");
    const initial = await reader.read();
    // Then: the small event arrives before EOF and all subsequent bytes survive.
    expect(new TextDecoder().decode(initial.value)).toBe(first);
    release.resolve();
    const chunks: number[] = [...(initial.value ?? [])];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(...chunk.value);
    }
    expect(new TextDecoder().decode(Uint8Array.from(chunks))).toBe(first + tail);
  } finally {
    release.resolve();
    server.close();
  }
});

test("supports the official SDK stream iterator including future event fields", async () => {
  // Given: the upstream emits standard and future event types.
  const events = [
    { type: "future.event", metadata: { original: true } },
    { type: "response.output_text.delta", delta: "Bonjour 🌍", extra: 42 },
    { type: "response.completed", response: completed() },
  ];
  const server = fixture(
    () =>
      new Response(events.map(sse).join(""), { headers: { "content-type": "text/event-stream" } }),
  );
  try {
    // When: the official SDK consumes the proxied stream.
    const client = new OpenAI({ apiKey: "local-key", baseURL: server.url, maxRetries: 0 });
    const stream = await client.responses.create({
      model: "fixture-model",
      input: [],
      stream: true,
    });
    const received: unknown[] = [];
    for await (const event of stream) received.push(event);
    // Then: SDK events retain unknown fields and complete Unicode values.
    expect(received).toEqual(events);
  } finally {
    server.close();
  }
});
