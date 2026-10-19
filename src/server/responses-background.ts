import {
  type CredentialProvider,
  GatewayError,
  type ProxyOptions,
  type UpstreamCredentials,
} from "../shared/contracts";
import type { DurableStore } from "./durable-store";
import { adaptRequest } from "./response-adapter";
import { restoreStreamOutput } from "./response-stream-adapter";
import type { ResponsesStoreOptions } from "./responses-store";
import { Exchange } from "./upstream-stream";

type Json = Record<string, unknown>;
type Job = { response: Json; input: unknown[]; nativeId?: string };
type Journal = { frames: string[]; ended: boolean; interrupted?: boolean };
type Subscriber = { wake(): void; pending: number; error?: string };
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
  const releaseOwnership = store.claimBackground();
  const active = new Map<string, { cancel(): void }>();
  const subscribers = new Map<string, Set<Subscriber>>();
  let subscriberCount = 0;
  let closed = false;
  const expires = (response: Json) =>
    now() + (response["store"] === true ? (storage.ttlMs ?? DURABLE_TTL) : TEMP_TTL);
  // Recovery is synchronous and never schedules work, including queued jobs.
  try {
    store.recover("background", (payload) => {
      const job = payload as Job;
      if (terminal(job.response)) return undefined;
      const response = { ...job.response, status: "failed", error: interruption };
      return { payload: { ...job, response }, expires: expires(response) };
    });
    store.recover("background-stream", (payload) => {
      const journal = payload as Journal;
      return journal.ended
        ? undefined
        : { payload: { ...journal, ended: true, interrupted: true }, expires: now() + TEMP_TTL };
    });
  } catch (error) {
    releaseOwnership();
    throw error;
  }

  const reserveSubscriber = () => {
    if (closed) throw new GatewayError(503, "server_stopping", "Server is stopping");
    if (subscriberCount >= 64)
      throw new GatewayError(
        429,
        "background_subscriber_capacity",
        "At most 64 background streams may be open",
      );
    subscriberCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscriberCount--;
    };
  };
  const stream = (
    account: string,
    id: string,
    after = -1,
    release = reserveSubscriber(),
  ): Response => {
    try {
      const key = `${account}/${id}`;
      const saved = store.get(account, "background", id) as Job | undefined;
      if (!saved)
        throw new GatewayError(404, "not_found", `Background response '${id}' was not found`);
      if (saved.response["stream"] !== true)
        throw new GatewayError(
          400,
          "background_not_streamed",
          "Only background responses created with stream:true can be resumed",
        );
      const journal = store.get(account, "background-stream", id) as Journal | undefined;
      if (!journal)
        throw new GatewayError(
          410,
          "background_journal_unavailable",
          "Background event journal is expired or unavailable; generation will not be restarted",
        );
      if (after >= journal.frames.length)
        throw new GatewayError(
          400,
          "invalid_cursor",
          "starting_after is beyond the last exposed event",
        );
      let cursor = after + 1;
      let wake: (() => void) | undefined;
      let stopped = false;
      const subscriber: Subscriber = { wake: () => wake?.(), pending: 0 };
      const group = subscribers.get(key) ?? new Set<Subscriber>();
      group.add(subscriber);
      subscribers.set(key, group);
      const detach = () => {
        release();
        stopped = true;
        subscriber.wake();
        group.delete(subscriber);
        if (!group.size) subscribers.delete(key);
      };
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                while (!stopped) {
                  if (subscriber.error || closed)
                    throw new GatewayError(
                      503,
                      subscriber.error ?? "background_interrupted",
                      subscriber.error === "slow_consumer"
                        ? "Background stream consumer is too slow; reconnect using starting_after. The job continues."
                        : "Background stream interrupted; generation will not be restarted",
                    );
                  const current = store.get(account, "background-stream", id) as
                    | Journal
                    | undefined;
                  if (!current)
                    throw new GatewayError(
                      410,
                      "background_journal_unavailable",
                      "Background journal is unavailable",
                    );
                  const frame = current.frames[cursor];
                  if (frame !== undefined) {
                    cursor++;
                    subscriber.pending = Math.max(0, subscriber.pending - Buffer.byteLength(frame));
                    controller.enqueue(new TextEncoder().encode(frame));
                    return;
                  }
                  if (current.ended) {
                    if (current.interrupted)
                      throw new GatewayError(
                        503,
                        "background_interrupted",
                        "Server interrupted the job; no missing events were reconstructed and generation will not be restarted",
                      );
                    detach();
                    controller.close();
                    return;
                  }
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                  });
                  wake = undefined;
                }
              } catch (error) {
                detach();
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: error\ndata: ${JSON.stringify({ type: "error", error: { code: error instanceof GatewayError ? error.code : "storage_unavailable", message: error instanceof Error ? error.message : "Background stream unavailable" } })}\n\n`,
                  ),
                );
                controller.close();
              }
            },
            cancel() {
              detach();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
      );
    } catch (error) {
      release();
      throw error;
    }
  };
  return {
    stream,
    async create(request: Request, parsed: Json, auth: UpstreamCredentials): Promise<Response> {
      if (closed) throw new GatewayError(503, "server_stopping", "Server is stopping");
      const streaming = parsed["stream"] === true;
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
      const body = { ...parsed, store: false, background: false, stream: streaming };
      const id = `resp_bg_${crypto.randomUUID()}`;
      const response: Json = {
        id,
        object: "response",
        created_at: Math.floor(now() / 1000),
        status: "queued",
        background: true,
        store: parsed["store"] === true,
        ...(streaming ? { stream: true } : {}),
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
      // Reserve synchronously before any durable job or producer can exist; GET shares this budget.
      const releaseSubscriber = streaming ? reserveSubscriber() : undefined;
      try {
        const reservation = store.reserve(auth.accountId, "background", options.timeoutMs + 60_000);
        let journalReservation: ReturnType<DurableStore["reserve"]> | undefined;
        let journal: Journal = { frames: [], ended: false };
        const frame = (event: Json, sequence: number) =>
          `event: ${event["type"]}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`;
        const canRetainFailure = (value: Journal) => {
          const failure = frame(
            {
              type: "response.failed",
              response: {
                ...response,
                status: "failed",
                error: { code: "storage_capacity_exceeded", message: "x".repeat(512) },
              },
            },
            Number.MAX_SAFE_INTEGER,
          );
          // Account for both JSON encodings and the terminal expiry, as the shared reservation does.
          const payload = JSON.stringify({ frames: [...value.frames, failure], ended: true });
          return (
            Buffer.byteLength(
              JSON.stringify([auth.accountId, "background-stream", id, payload, now() + TEMP_TTL]),
            ) <= store.maxRecordBytes
          );
        };
        try {
          if (streaming) {
            journalReservation = store.reserve(
              auth.accountId,
              "background-stream",
              options.timeoutMs + 60_000,
            );
            journal.frames.push(frame({ type: "response.created", response }, 0));
            if (!canRetainFailure(journal))
              throw new GatewayError(
                507,
                "background_journal_full",
                "Background creation event exceeds the journal capacity",
              );
          }
          store.atomic(() => {
            reservation.commit(id, job, null, true);
            journalReservation?.commit(id, journal, null, true);
          });
        } catch (error) {
          reservation.release();
          journalReservation?.release();
          throw error;
        }
        const exchange = new Exchange(new AbortController().signal, options.timeoutMs);
        const key = `${auth.accountId}/${id}`;
        let settled = false;
        const notify = (bytes: number) => {
          for (const subscriber of subscribers.get(key) ?? []) {
            subscriber.pending += bytes;
            if (subscriber.pending > options.maxBodyBytes) subscriber.error = "slow_consumer";
            subscriber.wake();
          }
        };
        const retain = (result: Json): Json => ({
          ...result,
          id,
          object: "response",
          background: true,
          store: response["store"],
          ...(streaming ? { stream: true } : {}),
        });
        const publish = (event: Json, result?: Json) => {
          if (closed || settled) return;
          const exposed: Json = { ...event };
          if (exposed["response_id"] !== undefined) exposed["response_id"] = id;
          if (exposed["response"] && typeof exposed["response"] === "object")
            exposed["response"] = retain(exposed["response"] as Json);
          const encoded = frame(exposed, journal.frames.length);
          const next = { frames: [...journal.frames, encoded], ended: result !== undefined };
          if (!result && !canRetainFailure(next))
            throw new GatewayError(
              507,
              "background_journal_full",
              "Background event journal reached its bounded capacity",
            );
          store.atomic(() => {
            journalReservation?.commit(id, next, result ? now() + TEMP_TTL : null, true);
            if (result) {
              const retained = retain(result);
              reservation.commit(id, { ...job, response: retained }, expires(retained), true);
            }
          });
          journal = next;
          if (result) settled = true;
          notify(Buffer.byteLength(encoded));
        };
        const save = (result: Json) => {
          if (closed || settled) return;
          const retained = retain(result);
          try {
            if (streaming)
              publish({ type: `response.${retained["status"]}`, response: retained }, retained);
            else reservation.commit(id, { ...job, response: retained }, expires(retained));
          } catch (error) {
            const failure = {
              ...response,
              status: "failed",
              error: {
                code: error instanceof GatewayError ? error.code : "storage_unavailable",
                message: "Background result could not be retained locally",
              },
            };
            if (streaming) publish({ type: "response.failed", response: failure }, failure);
            else reservation.commit(id, { response: failure, input: job.input }, expires(failure));
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
              if (
                streaming &&
                result.body &&
                result.headers.get("content-type")?.includes("text/event-stream")
              ) {
                const reader = result.body
                  .pipeThrough(restoreStreamOutput(options.maxBodyBytes))
                  .getReader();
                const decoder = new TextDecoder();
                let pending = "";
                try {
                  while (!settled && !closed) {
                    const next = await exchange.wait(reader.read());
                    if (next.done) break;
                    pending += decoder.decode(next.value, { stream: true });
                    let boundary = /\r?\n\r?\n/.exec(pending);
                    while (boundary) {
                      const text = pending
                        .slice(0, boundary.index)
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                      pending = pending.slice(boundary.index + boundary[0].length);
                      if (text && text !== "[DONE]") {
                        const event = JSON.parse(text) as Json;
                        const value = event["response"] as Json | undefined;
                        if (value && terminal(value)) publish(event, value);
                        else if (
                          event["type"] === "error" ||
                          (event["type"] === undefined && event["error"])
                        ) {
                          publish({ ...event, type: "error" });
                          save({
                            ...response,
                            status: "failed",
                            error: event["error"] ?? {
                              ...event,
                              code: event["code"] ?? "upstream_error",
                              message: event["message"] ?? "Background upstream failed",
                            },
                          });
                        } else publish(event);
                      }
                      boundary = /\r?\n\r?\n/.exec(pending);
                    }
                    if (Buffer.byteLength(pending) > options.maxBodyBytes)
                      throw new GatewayError(
                        502,
                        "body_too_large",
                        "Background event exceeded the configured byte limit",
                      );
                  }
                  if (!settled && !closed)
                    throw new GatewayError(
                      502,
                      "invalid_upstream_response",
                      "Background stream ended without a terminal Response",
                    );
                } finally {
                  await reader.cancel().catch(() => undefined);
                }
                return;
              }
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
              journalReservation?.release();
              exchange.close();
              active.delete(key);
            }
          })().catch(() => {
            for (const subscriber of subscribers.get(key) ?? []) {
              subscriber.error = "storage_unavailable";
              subscriber.wake();
            }
          });
        }, 0);
        return streaming
          ? stream(auth.accountId, id, -1, releaseSubscriber)
          : Response.json(response);
      } catch (error) {
        releaseSubscriber?.();
        throw error;
      }
    },
    cancel(account: string, id: string): Response {
      const job = store.get(account, "background", id) as Job | undefined;
      if (!job)
        throw new GatewayError(404, "not_found", `Background response '${id}' was not found`);
      if (!terminal(job.response)) active.get(`${account}/${id}`)?.cancel();
      return Response.json((store.get(account, "background", id) as Job).response);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of active.values()) job.cancel();
      active.clear();
      for (const group of subscribers.values()) for (const subscriber of group) subscriber.wake();
      releaseOwnership();
    },
  };
}
