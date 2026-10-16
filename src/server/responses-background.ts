import {
  type CredentialProvider,
  GatewayError,
  type ProxyOptions,
  type UpstreamCredentials,
} from "../shared/contracts";
import type { DurableStore } from "./durable-store";
import { adaptRequest } from "./response-adapter";
import type { ResponsesStoreOptions } from "./responses-store";
import { Exchange } from "./upstream-stream";

type Json = Record<string, unknown>;
type Job = { response: Json; input: unknown[]; nativeId?: string };
const terminal = (response: Json) =>
  ["completed", "failed", "cancelled", "incomplete"].includes(String(response["status"]));
const TEMP_TTL = 10 * 60_000;
const DURABLE_TTL = 30 * 24 * 60 * 60_000;
const interruption = {
  code: "background_interrupted",
  message: "Server interrupted the background job; it was not restarted",
};

export function createBackgroundResponses(
  options: ProxyOptions,
  credentials: CredentialProvider,
  store: DurableStore,
  storage: ResponsesStoreOptions,
  generate: (
    request: Request,
    auth: UpstreamCredentials,
    beforeSend: () => Promise<void>,
  ) => Promise<Response>,
) {
  const now = storage.now ?? Date.now;
  const active = new Map<string, { cancel(): void }>();
  let closed = false;
  const expires = (response: Json) =>
    now() + (response["store"] === true ? (storage.ttlMs ?? DURABLE_TTL) : TEMP_TTL);
  // Recovery is synchronous and never schedules work, including queued jobs.
  store.recover("background", (payload) => {
    const job = payload as Job;
    if (terminal(job.response)) return undefined;
    const response = { ...job.response, status: "failed", error: interruption };
    return { payload: { ...job, response }, expires: expires(response) };
  });

  return {
    async create(request: Request, parsed: Json, auth: UpstreamCredentials): Promise<Response> {
      if (closed) throw new GatewayError(503, "server_stopping", "Server is stopping");
      if (parsed["stream"] === true)
        throw new GatewayError(
          501,
          "background_stream_not_ready",
          "Background SSE journal and replay are not implemented yet; use JSON polling",
        );
      if (active.size >= 16)
        throw new GatewayError(
          429,
          "background_capacity_exceeded",
          "At most 16 local background jobs may be pending",
        );
      // Validate before reserving or detaching. Preserve unknown upstream fields.
      adaptRequest(
        new TextEncoder().encode(
          JSON.stringify({ ...parsed, store: parsed["store"] === true ? false : parsed["store"] }),
        ).buffer,
        options,
      );
      const body = { ...parsed, store: false, background: false, stream: false };
      const id = `resp_bg_${crypto.randomUUID()}`;
      const response: Json = {
        id,
        object: "response",
        created_at: Math.floor(now() / 1000),
        status: "queued",
        background: true,
        store: parsed["store"] === true,
        model: parsed["model"] ?? options.defaultModel,
        output: [],
        error: null,
        incomplete_details: null,
      };
      const input =
        typeof parsed["input"] === "string"
          ? [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: parsed["input"] }],
              },
            ]
          : Array.isArray(parsed["input"])
            ? parsed["input"]
            : [];
      const job: Job = {
        response,
        input: input.map((item) =>
          typeof item === "object" && item !== null
            ? { id: `in_${crypto.randomUUID()}`, ...item }
            : item,
        ),
      };
      // Leave bounded room for terminal failure/interruption metadata even at saturation.
      if (Buffer.byteLength(JSON.stringify(job)) + 1024 > store.maxRecordBytes)
        throw new GatewayError(
          507,
          "stored_response_too_large",
          "Background inputs and metadata exceed the local record limit",
        );
      const reservation = store.reserve(auth.accountId, "background", options.timeoutMs + 60_000);
      try {
        reservation.commit(id, job, null, true);
      } catch (error) {
        reservation.release();
        throw error;
      }
      const exchange = new Exchange(new AbortController().signal, options.timeoutMs);
      const key = `${auth.accountId}/${id}`;
      let settled = false;
      const save = (result: Json) => {
        if (closed || settled) return;
        const retained = {
          ...result,
          id,
          object: "response",
          background: true,
          store: response["store"],
        };
        try {
          reservation.commit(id, { ...job, response: retained }, expires(retained));
        } catch (error) {
          const failure = {
            ...response,
            status: "failed",
            error: {
              code: error instanceof GatewayError ? error.code : "storage_unavailable",
              message: "Background result could not be retained locally",
            },
          };
          reservation.commit(id, { response: failure, input: job.input }, expires(failure));
        }
        settled = true;
      };
      active.set(key, {
        cancel() {
          save({ ...response, status: "cancelled" });
          exchange.controller.abort();
        },
      });
      // The producer owns its signal: disconnecting the creation/polling client is not cancel.
      setTimeout(() => {
        void (async () => {
          try {
            if (closed || settled) return;
            job.response = { ...response, status: "in_progress" };
            reservation.commit(id, job, null, true);
            const current = await exchange.wait(credentials());
            if (current.accountId !== auth.accountId)
              throw new GatewayError(
                409,
                "upstream_account_changed",
                "Background job belongs to a different upstream account",
              );
            if (closed || settled) return;
            const upstreamRequest = new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify(body),
              signal: exchange.controller.signal,
            });
            const result = await exchange.wait(
              generate(upstreamRequest, current, async () => {
                const latest = await exchange.wait(credentials());
                if (latest.accountId !== auth.accountId)
                  throw new GatewayError(
                    409,
                    "upstream_account_changed",
                    "Upstream account changed before background emission",
                  );
                exchange.controller.signal.throwIfAborted();
                if (closed || settled)
                  throw new GatewayError(499, "request_cancelled", "Background job stopped");
              }),
            );
            const value = (await exchange.wait(result.json())) as Json;
            if (terminal(value)) {
              if (typeof value["id"] === "string") job.nativeId = value["id"];
              save(value);
            } else
              save({
                ...response,
                status: "failed",
                error: value["error"] ?? {
                  code: "invalid_upstream_response",
                  message: "Upstream did not return a terminal Response",
                },
              });
          } catch (error) {
            save({
              ...response,
              status: "failed",
              error: {
                code: error instanceof GatewayError ? error.code : "upstream_unavailable",
                message:
                  error instanceof GatewayError ? error.message : "Background generation failed",
              },
            });
          } finally {
            reservation.release();
            exchange.close();
            active.delete(key);
          }
        })().catch(() => {
          /* Storage failures must never become a successful terminal. */
        });
      }, 0);
      return Response.json(response);
    },
    cancel(account: string, id: string): Response {
      const job = store.get(account, "background", id) as Job | undefined;
      if (!job)
        throw new GatewayError(404, "not_found", `Background response '${id}' was not found`);
      if (!terminal(job.response)) active.get(`${account}/${id}`)?.cancel();
      return Response.json((store.get(account, "background", id) as Job).response);
    },
    close() {
      closed = true;
      for (const job of active.values()) job.cancel();
      active.clear();
    },
  };
}
