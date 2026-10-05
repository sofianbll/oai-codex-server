import { expect, test } from "bun:test";
import { fixture } from "./proxy-harness";

test.each([400, 401, 422, 500])(
  "passes through upstream HTTP %i with its body intact",
  async (status) => {
    // Given: an upstream error with an OpenAI-shaped payload and request ID.
    const errorBody = JSON.stringify({ error: { code: `fixture_${status}`, future: true } });
    const server = fixture(
      () =>
        new Response(errorBody, {
          status,
          headers: { "content-type": "application/json", "x-request-id": `req_${status}` },
        }),
    );
    try {
      // When: a caller makes a request through the relay.
      const result = await fetch(`${server.url}/responses`);
      // Then: the upstream status, body, and request ID remain observable.
      expect(result.status).toBe(status);
      expect(result.headers.get("x-request-id")).toBe(`req_${status}`);
      expect(await result.text()).toBe(errorBody);
    } finally {
      server.close();
    }
  },
);

test("rejects invalid JSON before dispatching to the upstream", async () => {
  // Given: a minimal Responses relay whose upstream must not be called.
  let calls = 0;
  const server = fixture(() => {
    calls++;
    return new Response("unexpected");
  });
  try {
    // When: a malformed JSON request reaches the adaptation boundary.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: "{invalid",
    });
    // Then: the caller receives an explicit local error and no request is dispatched.
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: { code: "invalid_json" } });
    expect(calls).toBe(0);
  } finally {
    server.close();
  }
});

test("returns an explicit gateway error for malformed upstream SSE JSON", async () => {
  // Given: an upstream stream with a malformed JSON data field.
  const server = fixture(
    () =>
      new Response("data: {invalid\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  try {
    // When: minimal mode aggregates the stream for a nonstreaming caller.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":[],"stream":false}',
    });
    // Then: it reports malformed upstream data instead of synthesizing success.
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: "invalid_upstream_stream" } });
  } finally {
    server.close();
  }
});
