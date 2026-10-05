import { createWebSocketProxy } from "../../src/server/websocket";
import { GatewayError, type ProxyOptions } from "../../src/shared/contracts";

export function fixture(overrides: Partial<ProxyOptions> = {}, gate = Promise.resolve()) {
  const received = Promise.withResolvers<Request>();
  const disconnected = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      // Copie avant upgrade : Bun vide la Request une fois la connexion promue.
      received.resolve(new Request(request.url, { headers: request.headers }));
      await gate;
      return server.upgrade(request)
        ? undefined
        : new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      open(socket) {
        opened.resolve(socket);
      },
      message(socket, message) {
        socket.send(message);
      },
      close() {
        disconnected.resolve();
      },
    },
  });
  const proxy = createWebSocketProxy(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      timeoutMs: 1_000,
      maxBodyBytes: 1024 * 1024,
      defaultModel: "fixture",
      clientVersion: "fixture",
      translationMode: "minimal",
      ...overrides,
    },
    async () => ({ accessToken: "upstream-token", accountId: "upstream-account" }),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: proxy.websocket,
    async fetch(request, runtime) {
      try {
        return await proxy.upgrade(request, runtime);
      } catch (error) {
        if (error instanceof GatewayError)
          return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    },
  });
  return {
    proxy,
    received: received.promise,
    disconnected: disconnected.promise,
    upstreamSocket: opened.promise,
    url: server.url.origin.replace("http:", "ws:"),
    close() {
      proxy.close();
      server.stop(true);
      upstream.stop(true);
    },
  };
}

export function connected(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket handshake failed")), {
      once: true,
    });
  });
}

export function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
  );
}

export function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}
