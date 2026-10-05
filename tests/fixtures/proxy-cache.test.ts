import { expect, test } from "bun:test";
import { fixture, sse } from "./proxy-harness";

const cacheUsage = {
  input_tokens: 1822,
  input_tokens_details: { cached_tokens: 1664, cache_write_tokens: 0 },
  output_tokens: 1,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1823,
};

test("maps a valid prompt_cache_key to session-id without changing the body key", async () => {
  // Given: minimal mode receives a valid cache key and no explicit session affinity.
  const key = "cache-session-123";
  let receivedHeaders = new Headers();
  let receivedBody = "";
  const server = fixture(async (request) => {
    receivedHeaders = new Headers(request.headers);
    receivedBody = await request.text();
    return new Response(sse({ type: "response.completed", response: { usage: cacheUsage } }), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    // When: a Responses request with prompt_cache_key is forwarded.
    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", input: "Hi", prompt_cache_key: key }),
    });
    // Then: the upstream gets header affinity and the original cache key in JSON.
    expect(response.status).toBe(200);
    expect(receivedHeaders.get("session-id")).toBe(key);
    expect(JSON.parse(receivedBody)).toMatchObject({ prompt_cache_key: key });
  } finally {
    server.close();
  }
});

test("keeps an explicit session-id ahead of prompt_cache_key", async () => {
  // Given: the caller sends both a cache key and an explicit session identity.
  let receivedHeaders = new Headers();
  let receivedBody = "";
  const server = fixture(async (request) => {
    receivedHeaders = new Headers(request.headers);
    receivedBody = await request.text();
    return new Response(sse({ type: "response.completed", response: {} }), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    // When: minimal mode forwards the request.
    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "caller-session" },
      body: JSON.stringify({ input: "Hi", prompt_cache_key: "body-cache-key" }),
    });
    // Then: the explicit header remains authoritative and the body value is unchanged.
    expect(response.status).toBe(200);
    expect(receivedHeaders.get("session-id")).toBe("caller-session");
    expect(JSON.parse(receivedBody)).toMatchObject({ prompt_cache_key: "body-cache-key" });
  } finally {
    server.close();
  }
});

test("does not synthesize session-id when prompt_cache_key is absent", async () => {
  // Given: a normal minimal Responses request without a cache key.
  let receivedHeaders = new Headers();
  const server = fixture((request) => {
    receivedHeaders = new Headers(request.headers);
    return new Response(sse({ type: "response.completed", response: {} }), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    // When: the request reaches the upstream fixture.
    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hi" }),
    });
    // Then: the gateway does not invent an affinity key.
    expect(response.status).toBe(200);
    expect(receivedHeaders.has("session-id")).toBe(false);
  } finally {
    server.close();
  }
});

test.each([
  ["null", null],
  ["non-string", 42],
  ["empty", ""],
  ["leading whitespace", " cache-key"],
  ["trailing whitespace", "cache-key "],
  ["CRLF", "cache\r\nkey"],
  ["Unicode", "café"],
] as const)(
  "forwards %s prompt_cache_key without deriving a header or failing",
  async (_shape, key) => {
    // Given: prompt_cache_key is present but is not representable as a safe header value.
    let receivedHeaders = new Headers();
    let receivedBody = "";
    const server = fixture(async (request) => {
      receivedHeaders = new Headers(request.headers);
      receivedBody = await request.text();
      return new Response(sse({ type: "response.completed", response: {} }), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    try {
      // When: the caller sends the otherwise valid Responses request.
      const response = await fetch(`${server.url}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Hi", prompt_cache_key: key }),
      });
      // Then: the body field remains intact and the gateway returns the upstream response.
      expect(response.status).toBe(200);
      expect(receivedHeaders.has("session-id")).toBe(false);
      expect(JSON.parse(receivedBody)).toMatchObject({ prompt_cache_key: key });
    } finally {
      server.close();
    }
  },
);

test("leaves prompt_cache_key body untouched in raw mode", async () => {
  // Given: raw mode and an otherwise valid prompt_cache_key.
  const wire = '{ "prompt_cache_key":"raw-key", "stream":false, "store":false }';
  let receivedHeaders = new Headers();
  let receivedBody = "";
  const server = fixture(
    async (request) => {
      receivedHeaders = new Headers(request.headers);
      receivedBody = await request.text();
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    { translationMode: "raw" },
  );
  try {
    // When: the request reaches the passthrough route.
    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: wire,
    });
    // Then: raw mode preserves exact bytes and does not synthesize Codex headers.
    expect(response.status).toBe(200);
    expect(receivedBody).toBe(wire);
    expect(receivedHeaders.has("session-id")).toBe(false);
  } finally {
    server.close();
  }
});

test("does not derive session-id for a non-Responses POST route", async () => {
  // Given: a valid cache key appears on a different API route.
  const wire = '{ "prompt_cache_key":"other-route-key", "opaque":true }';
  let receivedHeaders = new Headers();
  let receivedBody = "";
  let receivedPath = "";
  const server = fixture(async (request) => {
    receivedHeaders = new Headers(request.headers);
    receivedBody = await request.text();
    receivedPath = new URL(request.url).pathname;
    return Response.json({ ok: true });
  });
  try {
    // When: the request is sent to /files rather than /responses.
    const response = await fetch(`${server.url}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: wire,
    });
    // Then: the other route preserves bytes and receives no derived header.
    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/backend-api/codex/files");
    expect(receivedBody).toBe(wire);
    expect(receivedHeaders.has("session-id")).toBe(false);
  } finally {
    server.close();
  }
});

test("preserves upstream cache usage counters in the completed stream", async () => {
  // Given: Codex returns explicit input and cached-token usage values.
  const wire = sse({ type: "response.completed", response: { usage: cacheUsage } });
  const server = fixture(
    () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
  );
  try {
    // When: a streamed Responses request passes through the gateway.
    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Hi", stream: true }),
    });
    const body = await response.text();
    // Then: the terminal response preserves each upstream usage counter exactly.
    expect(response.status).toBe(200);
    expect(body).toContain(
      JSON.stringify({ type: "response.completed", response: { usage: cacheUsage } }),
    );
  } finally {
    server.close();
  }
});
