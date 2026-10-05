import {
  type CredentialProvider,
  GatewayError,
  type ProxyOptions,
  type UpstreamCredentials,
} from "../shared/contracts";
import { adaptRequest } from "./response-adapter";
import { destination } from "./upstream";

const MAX_SESSIONS = 64;
const MAX_RESPONSE_IDS_PER_SESSION = 256;
const SESSION_TTL_MS = 5 * 60_000;
const terminalTypes = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

type WireEvent = Readonly<{
  type: string;
  response: Readonly<Record<string, unknown>> | undefined;
  item: Readonly<Record<string, unknown>> | undefined;
  output_index: number | undefined;
  error: unknown;
}>;
type Session = {
  readonly socket: WebSocket;
  readonly accountId: string;
  readonly responseIds: Set<string>;
  busy: boolean;
  touchedAt: number;
  expiry: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
};
type Terminal = Readonly<{
  event: WireEvent;
  items: ReadonlyMap<number, Readonly<Record<string, unknown>>>;
}>;
type ActiveTurn = Readonly<{ completion: Promise<Terminal>; cancel: () => void }>;

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function parseEvent(raw: string): WireEvent {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value))
    throw new GatewayError(
      502,
      "invalid_upstream_event",
      "Upstream WebSocket returned an invalid event",
    );
  const type = value.type;
  if (typeof type !== "string")
    throw new GatewayError(
      502,
      "invalid_upstream_event",
      "Upstream WebSocket returned an invalid event",
    );
  const response = "response" in value && isRecord(value.response) ? value.response : undefined;
  const item = "item" in value && isRecord(value.item) ? value.item : undefined;
  const outputIndex =
    "output_index" in value &&
    typeof value.output_index === "number" &&
    Number.isInteger(value.output_index)
      ? value.output_index
      : undefined;
  return {
    type,
    response,
    item,
    output_index: outputIndex,
    error: "error" in value ? value.error : undefined,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    throw new GatewayError(413, "body_too_large", "Request body exceeds the configured byte limit");
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes)
        throw new GatewayError(
          413,
          "body_too_large",
          "Request body exceeds the configured byte limit",
        );
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new GatewayError(504, "upstream_timeout", "Upstream request exceeded its timeout")),
      timeoutMs,
    );
    const abort = () =>
      reject(new GatewayError(499, "request_cancelled", "Client cancelled the request"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    });
  });
}

export function createResponsesBridge(options: ProxyOptions, credentials: CredentialProvider) {
  const sessions = new Set<Session>();
  const responseSessions = new Map<string, Session>();
  let stopped = false;

  const destroy = (session: Session): void => {
    if (session.closed) return;
    session.closed = true;
    session.busy = false;
    clearTimeout(session.expiry);
    sessions.delete(session);
    for (const id of session.responseIds) responseSessions.delete(id);
    if (session.socket.readyState === WebSocket.CONNECTING) session.socket.terminate();
    else if (session.socket.readyState === WebSocket.OPEN)
      session.socket.close(1000, "Response session closed");
  };

  const retain = (session: Session): void => {
    clearTimeout(session.expiry);
    session.expiry = setTimeout(() => destroy(session), SESSION_TTL_MS);
    session.expiry.unref();
  };

  const remember = (session: Session, event: WireEvent): void => {
    const id = event.response === undefined ? undefined : event.response["id"];
    if (typeof id !== "string" || id.length === 0) return;
    if (!session.responseIds.has(id) && session.responseIds.size >= MAX_RESPONSE_IDS_PER_SESSION) {
      const oldest = session.responseIds.values().next().value;
      if (oldest !== undefined) {
        session.responseIds.delete(oldest);
        responseSessions.delete(oldest);
      }
    }
    session.responseIds.add(id);
    responseSessions.set(id, session);
  };

  async function connect(
    request: Request,
    auth: UpstreamCredentials,
    sessionId: string | undefined,
  ): Promise<Session> {
    if (stopped)
      throw new GatewayError(
        503,
        "responses_session_capacity",
        "Responses session capacity unavailable",
      );
    if (sessions.size >= MAX_SESSIONS) {
      const idle = [...sessions]
        .filter((entry) => !entry.busy)
        .sort((left, right) => left.touchedAt - right.touchedAt)[0];
      if (idle === undefined)
        throw new GatewayError(
          503,
          "responses_session_capacity",
          "Responses session capacity unavailable",
        );
      destroy(idle);
    }
    const target = destination(request, options);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const headers: Record<string, string> = {
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
    };
    const beta = request.headers.get("openai-beta");
    if (beta) headers["openai-beta"] = beta;
    if (sessionId !== undefined) headers["session-id"] = sessionId;
    const socket = new WebSocket(target, { headers, perMessageDeflate: false });
    const session: Session = {
      socket,
      accountId: auth.accountId,
      responseIds: new Set(),
      busy: false,
      touchedAt: Date.now(),
      expiry: undefined,
      closed: false,
    };
    socket.binaryType = "arraybuffer";
    try {
      await waitFor(
        new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener(
            "error",
            () =>
              reject(
                new GatewayError(
                  502,
                  "upstream_unavailable",
                  "Unable to open the upstream Responses WebSocket",
                ),
              ),
            { once: true },
          );
          socket.addEventListener(
            "close",
            () =>
              reject(
                new GatewayError(
                  502,
                  "upstream_unavailable",
                  "Upstream Responses WebSocket closed during connection",
                ),
              ),
            { once: true },
          );
        }),
        options.timeoutMs,
        request.signal,
      );
    } catch (error) {
      socket.terminate();
      throw error;
    }
    sessions.add(session);
    socket.addEventListener("close", () => destroy(session), { once: true });
    return session;
  }

  const begin = (
    session: Session,
    payload: Readonly<Record<string, unknown>>,
    request: Request,
    onEvent: (event: WireEvent, raw: string) => void,
  ): ActiveTurn => {
    session.busy = true;
    session.touchedAt = Date.now();
    clearTimeout(session.expiry);
    const items = new Map<number, Readonly<Record<string, unknown>>>();
    let settled = false;
    let rejectTurn: (reason: unknown) => void = () => undefined;
    let message: (event: MessageEvent<unknown>) => void = () => undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      session.socket.removeEventListener("message", message);
      session.socket.removeEventListener("error", failure);
      session.socket.removeEventListener("close", closed);
      session.busy = false;
    };
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectTurn(reason);
      destroy(session);
    };
    const abort = (): void =>
      fail(new GatewayError(499, "request_cancelled", "Client cancelled the request"));
    const failure = (): void =>
      fail(new GatewayError(502, "upstream_unavailable", "Upstream Responses WebSocket failed"));
    const closed = (): void =>
      fail(new GatewayError(502, "upstream_unavailable", "Upstream Responses WebSocket closed"));
    const timer = setTimeout(
      () =>
        fail(new GatewayError(504, "upstream_timeout", "Upstream request exceeded its timeout")),
      options.timeoutMs,
    );
    const completion = new Promise<Terminal>((resolve, reject) => {
      rejectTurn = reject;
      message = (event: MessageEvent<unknown>): void => {
        if (typeof event.data !== "string") {
          fail(
            new GatewayError(
              502,
              "invalid_upstream_event",
              "Upstream WebSocket returned a binary event",
            ),
          );
          return;
        }
        let parsed: WireEvent;
        try {
          parsed = parseEvent(event.data);
          onEvent(parsed, event.data);
        } catch (error) {
          fail(error);
          return;
        }
        if (
          parsed.type === "response.output_item.done" &&
          parsed.item &&
          parsed.output_index !== undefined
        )
          items.set(parsed.output_index, parsed.item);
        remember(session, parsed);
        if (!terminalTypes.has(parsed.type)) return;
        if (settled) return;
        settled = true;
        cleanup();
        session.touchedAt = Date.now();
        retain(session);
        resolve({ event: parsed, items });
      };
      session.socket.addEventListener("message", message);
    });
    request.signal.addEventListener("abort", abort, { once: true });
    session.socket.addEventListener("error", failure, { once: true });
    session.socket.addEventListener("close", closed, { once: true });
    const wire = JSON.stringify({ type: "response.create", ...payload });
    if (
      new TextEncoder().encode(wire).byteLength + session.socket.bufferedAmount >
      options.maxBodyBytes
    )
      fail(
        new GatewayError(
          413,
          "body_too_large",
          "Response create event exceeds the configured byte limit",
        ),
      );
    else session.socket.send(wire);
    return {
      completion,
      cancel: () =>
        fail(new GatewayError(499, "request_cancelled", "Client cancelled the request")),
    };
  };

  async function forward(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return errorResponse(405, "method_not_allowed", "Responses bridge requires POST");
    try {
      const adapted = adaptRequest(await boundedBody(request, options.maxBodyBytes), options);
      const payloadValue: unknown = JSON.parse(adapted.body);
      if (!isRecord(payloadValue))
        throw new GatewayError(400, "invalid_request", "Responses requires a JSON object");
      const { stream: _stream, ...websocketPayload } = payloadValue;
      const previous = payloadValue["previous_response_id"];
      if (
        previous !== undefined &&
        previous !== null &&
        (typeof previous !== "string" || previous.length === 0)
      )
        return errorResponse(
          400,
          "invalid_previous_response_id",
          "previous_response_id must be a non-empty string",
        );
      const session = typeof previous === "string" ? responseSessions.get(previous) : undefined;
      if (typeof previous === "string" && session === undefined)
        return errorResponse(
          404,
          "previous_response_not_found",
          "No live Responses session owns previous_response_id",
        );
      if (session?.busy)
        return errorResponse(
          409,
          "previous_response_busy",
          "The previous response is still active",
        );
      const auth = await waitFor(credentials(), options.timeoutMs, request.signal);
      if (session && session.accountId !== auth.accountId)
        return errorResponse(
          409,
          "previous_response_account_mismatch",
          "The previous response belongs to another upstream account",
        );
      const active = session ?? (await connect(request, auth, adapted.sessionId));
      const streaming = adapted.streaming;
      if (streaming) {
        let turn: ActiveTurn | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            turn = begin(active, websocketPayload, request, (event, raw) => {
              controller.enqueue(
                new TextEncoder().encode(`event: ${event.type}\ndata: ${raw}\n\n`),
              );
            });
            void turn.completion.then(
              () => controller.close(),
              (error: unknown) => {
                const message =
                  error instanceof GatewayError
                    ? error.message
                    : "Upstream Responses WebSocket failed";
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: error\ndata: ${JSON.stringify({ error: { message } })}\n\n`,
                  ),
                );
                controller.close();
              },
            );
          },
          cancel() {
            turn?.cancel();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      const turn = begin(active, websocketPayload, request, () => undefined);
      const terminal = await turn.completion;
      if (terminal.event.type === "error")
        return Response.json(
          {
            error: terminal.event.error ?? {
              code: "upstream_error",
              message: "Upstream Responses WebSocket failed",
            },
          },
          { status: 502 },
        );
      if (!terminal.event.response)
        return errorResponse(
          502,
          "upstream_response_failed",
          "Upstream Responses WebSocket did not complete the response",
        );
      if (terminal.event.type !== "response.completed")
        return Response.json(terminal.event.response, { status: 502 });
      const output = terminal.event.response["output"];
      const finalResponse =
        terminal.items.size > 0 && (!Array.isArray(output) || output.length === 0)
          ? {
              ...terminal.event.response,
              output: [...terminal.items]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
            }
          : terminal.event.response;
      return Response.json(finalResponse);
    } catch (error) {
      if (error instanceof GatewayError)
        return errorResponse(error.status, error.code, error.message);
      return errorResponse(502, "upstream_unavailable", "Unable to reach the configured upstream");
    }
  }

  return {
    forward,
    close: () => {
      stopped = true;
      for (const session of sessions) destroy(session);
    },
  };
}
