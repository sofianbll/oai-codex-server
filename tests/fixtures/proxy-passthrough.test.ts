import { expect, test } from "bun:test";
import OpenAI from "openai";
import { fixture, sse } from "./proxy-harness";

test("forwards raw JSON byte-for-byte without enforcing Codex defaults", async () => {
  // Given: raw mode and intentionally non-Codex request fields.
  let received = "";
  const wire = '{ "store":true, "stream":false, "input":"é", "unknown":[1] }';
  const response = sse({ type: "future", value: "🌍" });
  const server = fixture(
    async (request) => {
      received = await request.text();
      return new Response(response, {
        status: 202,
        headers: { "content-type": "text/event-stream" },
      });
    },
    { translationMode: "raw" },
  );
  try {
    // When: the raw request is sent through the gateway.
    const result = await fetch(`${server.url}/responses`, { method: "POST", body: wire });
    // Then: request bytes, status, media type and SSE bytes remain unchanged.
    expect(received).toBe(wire);
    expect(result.status).toBe(202);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.text()).toBe(response);
  } finally {
    server.close();
  }
});

test("preserves multipart uploads and binary responses on other routes", async () => {
  // Given: an arbitrary multipart body with binary bytes.
  const prefix = new TextEncoder().encode(
    '--fixture\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\n\r\n',
  );
  const suffix = new TextEncoder().encode("\r\n--fixture--\r\n");
  const wire = new Uint8Array([...prefix, 0, 255, 128, ...suffix]);
  let received = new Uint8Array();
  let target = "";
  const server = fixture(async (request) => {
    target = new URL(request.url).pathname + new URL(request.url).search;
    received = new Uint8Array(await request.arrayBuffer());
    return new Response(Uint8Array.of(0, 255, 128), {
      status: 206,
      headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-2/3" },
    });
  });
  try {
    // When: an upload reaches an otherwise unrecognized endpoint.
    const result = await fetch(`${server.url}/files?opaque=a%2Bb`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=fixture" },
      body: wire,
    });
    // Then: the payload and route survive without endpoint-specific translation.
    expect(received).toEqual(wire);
    expect(target).toBe("/backend-api/codex/files?opaque=a%2Bb");
    expect(result.status).toBe(206);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(Uint8Array.of(0, 255, 128));
  } finally {
    server.close();
  }
});

test("retains upstream errors and request IDs while replacing credentials and removing private headers", async () => {
  // Given: hostile caller headers and a real upstream error response.
  let headers = new Headers();
  const errorBody = '{"error":{"code":"quota","future":true}}';
  const server = fixture((request) => {
    headers = request.headers;
    return new Response(errorBody, {
      status: 429,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_error",
        "retry-after": "7",
        "set-cookie": "secret=upstream",
        connection: "x-hop",
        "x-hop": "private",
      },
    });
  });
  try {
    // When: the proxy sends the authenticated request.
    const result = await fetch(`${server.url}/anything`, {
      headers: {
        authorization: "Bearer local",
        "chatgpt-account-id": "spoof",
        cookie: "private=caller",
        origin: "http://local",
        referer: "http://local/secret",
        "x-forwarded-for": "private-ip",
        connection: "x-secret",
        "x-secret": "hop",
      },
    });
    // Then: only server credentials reach upstream and the HTTP error remains intact.
    expect(headers.get("authorization")).toBe("Bearer fixture-token");
    expect(headers.get("chatgpt-account-id")).toBe("fixture-account");
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-secret"])
      expect(headers.has(name)).toBe(false);
    expect(result.status).toBe(429);
    expect(result.headers.get("x-request-id")).toBe("req_error");
    expect(result.headers.get("retry-after")).toBe("7");
    expect(result.headers.has("set-cookie")).toBe(false);
    expect(result.headers.has("x-hop")).toBe(false);
    expect(await result.text()).toBe(errorBody);
  } finally {
    server.close();
  }
});

test("maps Codex models with metadata and documented compatibility defaults", async () => {
  // Given: the Codex-specific models response shape.
  let query = "";
  const server = fixture((request) => {
    query = new URL(request.url).search;
    return Response.json({
      models: [{ slug: "codex-fixture", display_name: "Fixture", future: [1] }],
      metadata: { fresh: true },
    });
  });
  try {
    // When: the official SDK lists models through minimal mode.
    const client = new OpenAI({ apiKey: "local-key", baseURL: server.url, maxRetries: 0 });
    const result = await client.models.list();
    // Then: IDs and metadata remain available with the agreed compatibility defaults.
    expect(query).toBe("?client_version=0.0.1-fixture");
    const models: unknown = result.data;
    expect(models).toEqual([
      {
        id: "codex-fixture",
        created: 0,
        owned_by: "openai",
        object: "model",
        slug: "codex-fixture",
        display_name: "Fixture",
        future: [1],
      },
    ]);
    expect(result.data[0]?.created).toBe(0);
  } finally {
    server.close();
  }
});
