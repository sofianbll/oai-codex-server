import ky, { TimeoutError } from "ky";
import { type CredentialProvider, GatewayError, type ProxyOptions } from "../shared/contracts";
import { adaptRequest, completedResponse, modelList } from "./response-adapter";
import { restoreStreamOutput } from "./response-stream-adapter";
import { Exchange } from "./upstream-stream";

const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;
const privateHeaders = [
  "cookie",
  "host",
  "origin",
  "referer",
  "referrer",
  "forwarded",
  "x-api-key",
] as const;

function sanitizedHeaders(source: Headers, incoming: boolean): Headers {
  const headers = new Headers(source);
  for (const name of source.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  for (const name of hopHeaders) headers.delete(name);
  headers.delete("content-length");
  if (incoming) {
    for (const name of privateHeaders) headers.delete(name);
    for (const name of headers.keys()) if (name.startsWith("x-forwarded-")) headers.delete(name);
  } else {
    headers.delete("set-cookie");
    headers.delete("content-encoding");
  }
  return headers;
}

export function destination(request: Request, options: ProxyOptions): URL {
  const original = new URL(request.url);
  let decoded = original.pathname;
  try {
    for (let pass = 0; pass < 5; pass++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch (error) {
    if (error instanceof URIError)
      throw new GatewayError(400, "invalid_path", "Malformed URL encoding");
    throw error;
  }
  const suffix = decoded.slice(3);
  if (
    !decoded.startsWith("/v1/") ||
    decoded.includes("\\") ||
    [...decoded].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /%(?:25|2e|2f|5c)/i.test(decoded) ||
    suffix.startsWith("//") ||
    /^\/[a-z][a-z\d+.-]*:/i.test(suffix) ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new GatewayError(400, "invalid_path", "Only paths inside /v1/ are allowed");
  }
  const base = new URL(options.baseUrl);
  const target = new URL(
    `${base.href.replace(/\/+$/, "")}${original.pathname.slice(3)}${original.search}`,
  );
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`)
  ) {
    throw new GatewayError(400, "invalid_path", "Upstream URL escape rejected");
  }
  return target;
}

export async function forward(
  request: Request,
  options: ProxyOptions,
  credentials: CredentialProvider,
): Promise<Response> {
  const target = destination(request, options);
  const path = new URL(request.url).pathname;
  const minimal = options.translationMode === "minimal";
  const responses = minimal && request.method === "POST" && path === "/v1/responses";
  const models = minimal && request.method === "GET" && path === "/v1/models";
  if (models && !target.searchParams.has("client_version"))
    target.searchParams.set("client_version", options.clientVersion);
  const exchange = new Exchange(request.signal, options.timeoutMs);
  try {
    const bytes = request.body
      ? await new Response(
          exchange.wrap(request.body, { maxBytes: options.maxBodyBytes, overflowStatus: 413 }),
        ).arrayBuffer()
      : undefined;
    const adapted = responses ? adaptRequest(bytes ?? new ArrayBuffer(0), options) : undefined;
    const headers = sanitizedHeaders(request.headers, true);
    if (adapted?.sessionId !== undefined && !headers.has("session-id"))
      headers.set("session-id", adapted.sessionId);
    const auth = await exchange.wait(credentials());
    exchange.controller.signal.throwIfAborted();
    headers.set("authorization", `Bearer ${auth.accessToken}`);
    headers.set("chatgpt-account-id", auth.accountId);
    headers.set("accept-encoding", "identity");
    if (adapted) {
      headers.set("content-type", "application/json");
      headers.delete("content-encoding");
    }
    const payload = adapted?.body ?? bytes;
    const response = await ky(target, {
      method: request.method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: exchange.controller.signal,
      retry: 0,
      timeout: options.timeoutMs,
      redirect: "manual",
      throwHttpErrors: false,
    });
    const responseHeaders = sanitizedHeaders(response.headers, false);
    const mediaType = responseHeaders.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (responses && response.ok && (!mediaType || mediaType === "text/plain")) {
      responseHeaders.set("content-type", "text/event-stream");
    }
    const aggregate =
      response.ok &&
      (models ||
        (adapted?.streaming === false &&
          responseHeaders.get("content-type")?.includes("text/event-stream")));
    const streamedBody =
      adapted?.streaming === true &&
      response.ok &&
      responseHeaders.get("content-type")?.includes("text/event-stream")
        ? (response.body?.pipeThrough(restoreStreamOutput(options.maxBodyBytes), {
            signal: exchange.controller.signal,
          }) ?? null)
        : response.body;
    const body = streamedBody
      ? exchange.wrap(streamedBody, {
          complete: true,
          ...(aggregate
            ? { maxBytes: options.maxBodyBytes }
            : {
                direct: true,
                sse: responseHeaders.get("content-type")?.includes("text/event-stream") === true,
              }),
        })
      : null;
    if (!body) exchange.close();
    const result = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
    if (response.ok && models) return await modelList(result);
    if (aggregate && !models) return await completedResponse(result, exchange);
    return result;
  } catch (error) {
    exchange.close();
    if (error instanceof GatewayError) throw error;
    if (exchange.controller.signal.aborted) throw exchange.controller.signal.reason;
    exchange.controller.abort(error);
    if (error instanceof TimeoutError)
      throw new GatewayError(504, "upstream_timeout", "Upstream request exceeded its timeout");
    if (error instanceof Error)
      throw new GatewayError(
        502,
        "upstream_unavailable",
        "Unable to reach the configured upstream",
      );
    throw error;
  }
}
