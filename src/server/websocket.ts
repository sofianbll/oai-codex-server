import { type CredentialProvider, GatewayError, type ProxyOptions } from "../shared/contracts";
import { destination } from "./upstream";

type Frame = string | ArrayBuffer | Uint8Array<ArrayBuffer>;

export type WebSocketData = {
  readonly upstream: WebSocket;
  readonly queue: Frame[];
  downstream: Bun.ServerWebSocket<WebSocketData> | undefined;
  queuedBytes: number;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

function byteLength(frame: Frame): number {
  return typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
}

function closeCode(code: number): number {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1011;
}

export function createWebSocketProxy(options: ProxyOptions, credentials: CredentialProvider) {
  const connections = new Set<WebSocketData>();
  let pending = 0;
  let stopped = false;

  function finish(data: WebSocketData, code = 1011, reason = "Connection ended"): void {
    if (data.ended) return;
    data.ended = true;
    clearTimeout(data.timer);
    connections.delete(data);
    data.queue.length = 0;
    data.queuedBytes = 0;
    if (data.upstream.readyState === WebSocket.CONNECTING) data.upstream.terminate();
    else if (data.upstream.readyState === WebSocket.OPEN)
      data.upstream.close(closeCode(code), reason);
    data.downstream?.close(closeCode(code), reason);
    setTimeout(() => {
      data.upstream.terminate();
      data.downstream?.terminate();
    }, 250).unref();
  }

  function sendUpstream(data: WebSocketData, frame: Frame): void {
    if (data.ended) return;
    const size = byteLength(frame);
    if (size + data.upstream.bufferedAmount + data.queuedBytes > options.maxBodyBytes) {
      finish(data, 1009, "WebSocket buffer limit exceeded");
      return;
    }
    if (data.upstream.readyState === WebSocket.OPEN) data.upstream.send(frame);
    else if (data.queue.length < 1024) {
      data.queue.push(frame);
      data.queuedBytes += size;
    } else finish(data, 1009, "WebSocket queue limit exceeded");
  }

  const websocket: Bun.WebSocketHandler<WebSocketData> = {
    maxPayloadLength: options.maxBodyBytes,
    backpressureLimit: options.maxBodyBytes,
    closeOnBackpressureLimit: true,
    idleTimeout: 0,
    open(socket) {
      socket.data.downstream = socket;
    },
    message(socket, message) {
      sendUpstream(socket.data, message);
    },
    close(socket, code, reason) {
      finish(socket.data, code, reason);
    },
  };

  return {
    websocket,
    async upgrade(
      request: Request,
      server: Bun.Server<WebSocketData>,
    ): Promise<Response | undefined> {
      const target = destination(request, options);
      if (
        request.method !== "GET" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        throw new GatewayError(
          400,
          "invalid_websocket_upgrade",
          "A WebSocket GET upgrade is required",
        );
      }
      if (stopped || connections.size + pending >= 64)
        throw new GatewayError(503, "websocket_capacity", "WebSocket capacity unavailable");
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      pending++;
      let credentialTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const auth = await Promise.race([
          credentials(),
          new Promise<never>((_resolve, reject) => {
            credentialTimer = setTimeout(
              () =>
                reject(
                  new GatewayError(504, "websocket_timeout", "WebSocket authentication timed out"),
                ),
              options.timeoutMs,
            );
          }),
        ]);
        if (stopped || request.signal.aborted)
          throw new GatewayError(503, "websocket_closed", "WebSocket connection cancelled");
        const headers: Record<string, string> = {
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
        };
        for (const name of [
          "openai-beta",
          "openai-organization",
          "openai-project",
          "x-client-request-id",
        ]) {
          const value = request.headers.get(name);
          if (value) headers[name] = value;
        }
        const upstream = new WebSocket(target, { headers, perMessageDeflate: false });
        upstream.binaryType = "arraybuffer";
        const data: WebSocketData = {
          upstream,
          downstream: undefined,
          queue: [],
          queuedBytes: 0,
          ended: false,
          timer: undefined,
        };
        connections.add(data);
        data.timer = setTimeout(
          () => finish(data, 1011, "Upstream connection timed out"),
          options.timeoutMs,
        );
        upstream.addEventListener("open", () => {
          clearTimeout(data.timer);
          if (data.ended) {
            upstream.terminate();
            return;
          }
          const frames = data.queue.splice(0);
          data.queuedBytes = 0;
          for (const frame of frames) sendUpstream(data, frame);
        });
        upstream.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (data.ended) return;
          const frame = event.data;
          if (typeof frame !== "string" && !(frame instanceof ArrayBuffer)) {
            finish(data);
            return;
          }
          const downstream = data.downstream;
          if (
            !downstream ||
            byteLength(frame) + downstream.getBufferedAmount() > options.maxBodyBytes
          ) {
            finish(data, 1009, "WebSocket buffer limit exceeded");
          } else downstream.send(frame);
        });
        upstream.addEventListener("close", (event) => finish(data, event.code, event.reason));
        upstream.addEventListener("error", () => finish(data, 1011, "Upstream connection failed"));
        const browserProtocol = request.headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .some((protocol) => protocol.trim() === "oai-codex");
        const responseHeaders = new Headers();
        if (browserProtocol) responseHeaders.set("sec-websocket-protocol", "oai-codex");
        if (!server.upgrade(request, { data, headers: responseHeaders })) {
          finish(data);
          throw new GatewayError(400, "invalid_websocket_upgrade", "WebSocket upgrade rejected");
        }
        return undefined;
      } finally {
        clearTimeout(credentialTimer);
        pending--;
      }
    },
    close() {
      stopped = true;
      for (const data of connections) {
        finish(data, 1001, "Server shutting down");
        data.upstream.terminate();
        data.downstream?.terminate();
      }
    },
  };
}
