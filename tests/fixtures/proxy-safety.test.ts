import { expect, test } from "bun:test";
import { forward } from "../../src/server/upstream";
import { completed, credentials, fixture, sse } from "./proxy-harness";

test.each([
  "/v1/%252e%252e/secret",
  "/v1/%2F%2Fevil.test",
  "/v1/https:%2F%2Fevil.test",
  "/v1/%5csecret",
  "/v1/%00",
  "/v1/../secret",
  "/outside",
])("rejects path escapes before upstream dispatch when path is %s", async (path) => {
  // Given: an upstream that must never receive the unsafe route.
  let calls = 0;
  const server = fixture(() => {
    calls++;
    return new Response("unexpected");
  });
  try {
    // When: a path escape reaches the transport boundary.
    const result = forward(new Request(`http://local${path}`), server.options, credentials);
    // Then: the local path error prevents credentialed upstream access.
    await expect(result).rejects.toMatchObject({ status: 400, code: "invalid_path" });
    expect(calls).toBe(0);
  } finally {
    server.close();
  }
});

test("rejects explicit storage when minimal adaptation would change user intent", async () => {
  // Given: a minimal proxy with an untouched upstream.
  let calls = 0;
  const server = fixture(() => {
    calls++;
    return new Response("unexpected");
  });
  try {
    // When: a caller requests persistent response storage.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":"Hi","store":true}',
    });
    // Then: the request is rejected instead of silently disabling storage.
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: { code: "store_not_supported" } });
    expect(calls).toBe(0);
  } finally {
    server.close();
  }
});

test("limits upload bytes even when content length is omitted", async () => {
  // Given: an eight-byte request limit.
  let calls = 0;
  const server = fixture(
    () => {
      calls++;
      return new Response("unexpected");
    },
    { maxBodyBytes: 8, translationMode: "raw" },
  );
  try {
    // When: streamed upload chunks exceed the aggregate limit.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
        controller.close();
      },
    });
    const result = forward(
      new Request(`${server.url}/files`, { method: "POST", body }),
      server.options,
      credentials,
    );
    // Then: dispatch is stopped with a payload-size error.
    await expect(result).rejects.toMatchObject({ status: 413, code: "body_too_large" });
    expect(calls).toBe(0);
  } finally {
    server.close();
  }
});

test("bounds nonstream aggregate size before the SDK parser can accumulate an oversized event", async () => {
  // Given: a response event larger than the configured limit.
  const server = fixture(
    () =>
      new Response(sse({ type: "response.completed", response: completed("x".repeat(1000)) }), {
        headers: { "content-type": "text/event-stream" },
      }),
    { maxBodyBytes: 300 },
  );
  try {
    // When: a nonstreaming request consumes the upstream event stream.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":"Hi"}',
    });
    // Then: the bounded aggregate fails with a local gateway error.
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: "body_too_large" } });
  } finally {
    server.close();
  }
});

test("passes redirect status without following credential-bearing redirects", async () => {
  // Given: an upstream redirect to a different resource.
  let calls = 0;
  const server = fixture(() => {
    calls++;
    return new Response(null, {
      status: 307,
      headers: { location: "http://example.invalid/steal" },
    });
  });
  try {
    // When: the local caller also asks to inspect the redirect.
    const result = await fetch(`${server.url}/files`, { redirect: "manual" });
    // Then: no second credentialed request is made.
    expect(result.status).toBe(307);
    expect(result.headers.get("location")).toBe("http://example.invalid/steal");
    expect(calls).toBe(1);
  } finally {
    server.close();
  }
});

test("passes models through unchanged when raw mode is selected", async () => {
  // Given: raw mode and a caller-provided client version.
  let query = "";
  const wire = '{ "models": [{"slug":"future"}], "future":true }';
  const server = fixture(
    (request) => {
      query = new URL(request.url).search;
      return new Response(wire, { headers: { "content-type": "application/json" } });
    },
    { translationMode: "raw" },
  );
  try {
    // When: the caller lists models through the raw gateway.
    const result = await fetch(`${server.url}/models?client_version=custom`);
    // Then: neither the response nor query is adapted.
    expect(query).toBe("?client_version=custom");
    expect(await result.text()).toBe(wire);
  } finally {
    server.close();
  }
});
