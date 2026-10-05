import { expect, test } from "bun:test";
import { closed, connected, fixture, nextMessage } from "./fixtures/websocket-harness";

test("relays raw future events without translation when using a WebSocket route", async () => {
  // Given: a local wire-level echo upstream.
  const server = fixture();
  const socket = new WebSocket(`${server.url}/v1/responses?model=future%2Bmodel`);
  const wire = '{ "type":"future.event", "unknown":[1,"été 🌍"], "store":true }';
  try {
    await connected(socket);
    const reply = nextMessage(socket);
    // When: the client sends an opaque event before upstream opening is guaranteed.
    socket.send(wire);
    // Then: the exact text reaches the client unchanged.
    expect(await reply).toBe(wire);
    const received = await server.received;
    expect(new URL(received.url).pathname + new URL(received.url).search).toBe(
      "/backend-api/codex/responses?model=future%2Bmodel",
    );
  } finally {
    socket.close();
    server.close();
  }
});

test("preserves binary bytes when relaying an unknown WebSocket endpoint", async () => {
  // Given: arbitrary non-UTF8 binary bytes.
  const server = fixture();
  const socket = new WebSocket(`${server.url}/v1/future`);
  socket.binaryType = "arraybuffer";
  const wire = Uint8Array.of(0, 255, 128, 13, 10);
  try {
    await connected(socket);
    const reply = nextMessage(socket);
    // When: the client sends a binary frame.
    socket.send(wire);
    // Then: the binary frame type and bytes survive.
    const result = await reply;
    expect(result).toBeInstanceOf(ArrayBuffer);
    if (!(result instanceof ArrayBuffer)) throw new Error("Expected binary frame");
    expect(new Uint8Array(result)).toEqual(wire);
  } finally {
    socket.close();
    server.close();
  }
});

test("replaces local credentials and strips secret subprotocols when opening upstream", async () => {
  // Given: spoofed session headers and browser authentication subprotocols.
  const server = fixture();
  const socket = new WebSocket(`${server.url}/v1/responses`, {
    protocols: ["oai-codex", "oai-codex-token.local-key"],
    headers: {
      authorization: "Bearer local-key",
      "chatgpt-account-id": "spoofed",
      cookie: "secret=cookie",
      "openai-beta": "responses_websockets=2026-02-06",
      origin: "http://local",
    },
  });
  try {
    // When: the authenticated upgrade reaches the real wire fixture.
    await connected(socket);
    const request = await server.received;
    // Then: the upstream sees only its credentials and the selected beta header.
    expect(request.headers.get("authorization")).toBe("Bearer upstream-token");
    expect(request.headers.get("chatgpt-account-id")).toBe("upstream-account");
    expect(request.headers.get("openai-beta")).toBe("responses_websockets=2026-02-06");
    for (const name of ["cookie", "origin", "sec-websocket-protocol"])
      expect(request.headers.has(name)).toBe(false);
    expect(socket.protocol).toBe("oai-codex");
  } finally {
    socket.close();
    server.close();
  }
});

test("closes the upstream when a client cancels its connection", async () => {
  // Given: a connected client and upstream.
  const server = fixture();
  const socket = new WebSocket(`${server.url}/v1/responses`);
  try {
    await connected(socket);
    await server.upstreamSocket;
    // When: the client cancels.
    socket.close(1000, "cancelled");
    // Then: the corresponding upstream connection closes.
    await server.disconnected;
  } finally {
    server.close();
  }
});

test("relays the close code when the upstream closes the connection", async () => {
  // Given: a fully connected relay.
  const server = fixture();
  const socket = new WebSocket(`${server.url}/v1/responses`);
  try {
    await connected(socket);
    const upstream = await server.upstreamSocket;
    const closure = closed(socket);
    // When: the upstream ends the session with an application close code.
    upstream.close(4001, "session finished");
    // Then: the client observes the same close code and reason.
    const result = await closure;
    expect(result.code).toBe(4001);
    expect(result.reason).toBe("session finished");
  } finally {
    socket.close();
    server.close();
  }
});

test("terminates both sockets when the proxy shuts down", async () => {
  // Given: an active pair of sockets.
  const server = fixture();
  const socket = new WebSocket(`${server.url}/v1/responses`);
  try {
    await connected(socket);
    await server.upstreamSocket;
    const closure = closed(socket);
    // When: the runtime initiates shutdown.
    server.proxy.close();
    // Then: both real peers receive closure.
    await Promise.all([closure, server.disconnected]);
  } finally {
    server.close();
  }
});

test("bounds queued frames when the upstream handshake is pending", async () => {
  // Given: a delayed upstream upgrade and a twelve-byte buffer budget.
  const gate = Promise.withResolvers<void>();
  const server = fixture({ maxBodyBytes: 12 }, gate.promise);
  const socket = new WebSocket(`${server.url}/v1/responses`);
  try {
    await connected(socket);
    const closure = closed(socket);
    // When: two individually valid frames exceed the total queued-byte limit.
    socket.send("12345678");
    socket.send("12345678");
    // Then: the proxy closes the connection instead of buffering unbounded data.
    expect((await closure).code).toBe(1009);
  } finally {
    gate.resolve();
    socket.close();
    server.close();
  }
});

test("preserves frame ordering when messages wait for the upstream handshake", async () => {
  // Given: a gated handshake and three distinct frames.
  const gate = Promise.withResolvers<void>();
  const server = fixture({}, gate.promise);
  const socket = new WebSocket(`${server.url}/v1/responses`);
  const messages: unknown[] = [];
  const complete = Promise.withResolvers<void>();
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    messages.push(event.data);
    if (messages.length === 3) complete.resolve();
  });
  try {
    await connected(socket);
    await server.received;
    // When: frames arrive while the upstream handshake is gated.
    socket.send("one");
    socket.send("two");
    socket.send("three");
    gate.resolve();
    await complete.promise;
    // Then: the wire order and text remain exact.
    expect(messages).toEqual(["one", "two", "three"]);
  } finally {
    gate.resolve();
    socket.close();
    server.close();
  }
});

test("closes both peers when an upstream frame exceeds the configured bound", async () => {
  // Given: a connected upstream and a twelve-byte message budget.
  const server = fixture({ maxBodyBytes: 12 });
  const socket = new WebSocket(`${server.url}/v1/responses`);
  try {
    await connected(socket);
    const upstream = await server.upstreamSocket;
    const closure = closed(socket);
    // When: the upstream sends an oversized frame.
    upstream.send("1234567890123");
    // Then: the client receives a size-limit close and the upstream also closes.
    expect((await closure).code).toBe(1009);
    await server.disconnected;
  } finally {
    socket.close();
    server.close();
  }
});

test("closes the client when the upstream handshake exceeds its timeout", async () => {
  // Given: an upstream that delays its handshake beyond the configured deadline.
  const gate = Promise.withResolvers<void>();
  const server = fixture({ timeoutMs: 30 }, gate.promise);
  const socket = new WebSocket(`${server.url}/v1/responses`);
  try {
    const closure = closed(socket);
    // When: the local upgrade succeeds but the upstream never opens.
    await connected(socket);
    // Then: the deadline closes the client with a server error.
    expect((await closure).code).toBe(1011);
  } finally {
    gate.resolve();
    socket.close();
    server.close();
  }
});

test.each(["/private", "/v1/%252e%252e/private", "/v1//evil.test/path", "/v1/%5cprivate"])(
  "rejects invalid WebSocket destination %s",
  async (path) => {
    // Given: a URL outside the fixed upstream route boundary.
    const server = fixture();
    try {
      // When: an upgrade targets the hostile path.
      const response = await fetch(`${server.url.replace("ws:", "http:")}${path}`, {
        headers: { upgrade: "websocket" },
      });
      // Then: the request fails before any upstream connection is created.
      expect(response.status).toBe(400);
    } finally {
      server.close();
    }
  },
);
