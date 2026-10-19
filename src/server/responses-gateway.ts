import { type CredentialProvider, GatewayError, type ProxyOptions } from "../shared/contracts";
import { chatObject, chatRequest, chatResponse } from "./chat-adapter";
import { createChatStorage } from "./chat-storage";
import { chatStream } from "./chat-stream";
import { conversations } from "./conversations";
import { createDurableStore } from "./durable-store";
import { compactResponse } from "./response-compact";
import { restoreResponse, type StoredResponse } from "./response-replay";
import { restoreStreamOutput } from "./response-stream-adapter";
import { createBackgroundResponses } from "./responses-background";
import { createResponsesLifecycle, type ResponsesStoreOptions } from "./responses-store";
import { createResponsesBridge } from "./responses-ws-bridge";
import { forward } from "./upstream";
import { Exchange } from "./upstream-stream";

export function createResponsesGateway(
  options: ProxyOptions,
  credentials: CredentialProvider,
  storage: ResponsesStoreOptions = {},
) {
  const bridge = createResponsesBridge(options, credentials);
  let accountId: string | undefined;
  const relay = (request: Request) => forward(request, options, credentials);
  const store =
    options.translationMode === "minimal"
      ? (storage.store ?? createDurableStore(storage))
      : undefined;
  let background: ReturnType<typeof createBackgroundResponses> | undefined;
  try {
    background = store
      ? createBackgroundResponses(
          options,
          credentials,
          store,
          storage,
          (request, auth, beforeSend) => bridge.forward(request, auth, beforeSend),
        )
      : undefined;
  } catch (error) {
    bridge.close();
    if (!storage.store) store?.close();
    throw error;
  }
  const lifecycleFor = (auth: Awaited<ReturnType<CredentialProvider>>) =>
    createResponsesLifecycle(
      async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/v1/responses/compact")
          return compactResponse(
            request,
            options,
            async () => auth,
            (req) => forward(req, options, async () => auth),
          );
        if (request.method === "POST" && path === "/v1/responses") {
          const response = await bridge.forward(
            request,
            auth,
            undefined,
            (previous, payload, account) =>
              restoreResponse(
                store?.get(account, "response", previous) as StoredResponse | undefined,
                payload,
              ),
          );
          if (
            response.ok &&
            response.body &&
            response.headers.get("content-type")?.includes("text/event-stream")
          )
            return new Response(
              response.body.pipeThrough(restoreStreamOutput(options.maxBodyBytes)),
              response,
            );
          return response;
        }
        return forward(request, options, async () => auth);
      },
      {
        ...storage,
        ...(store ? { store } : {}),
        maxResponseBytes: options.maxBodyBytes,
        reservationMs: options.timeoutMs,
      },
    );
  return {
    async forward(request: Request): Promise<Response> {
      if (options.translationMode !== "minimal") return relay(request);
      const path = new URL(request.url).pathname;
      const chat = path === "/v1/chat/completions" && request.method === "POST";
      const conversation = path === "/v1/conversations" || path.startsWith("/v1/conversations/");
      let conversationBody = "{}";
      const chatOperation =
        path === "/v1/chat/completions" || path.startsWith("/v1/chat/completions/");
      if (
        conversation ||
        chatOperation ||
        path === "/v1/responses" ||
        path.startsWith("/v1/responses/")
      ) {
        const exchange = new Exchange(request.signal, options.timeoutMs);
        let includeUsage = false;
        let original: ReturnType<typeof chatRequest>["stored"];
        let metadata: ReturnType<typeof chatRequest>["metadata"];
        let reservation: ReturnType<ReturnType<typeof createChatStorage>["reserve"]> | undefined;
        let streaming = false;
        try {
          if (
            (chatOperation && request.method === "POST") ||
            (request.method === "POST" && (conversation || path === "/v1/responses"))
          ) {
            const declared = request.headers.get("content-length");
            if (
              declared !== null &&
              (!/^\d+$/.test(declared) || Number(declared) > options.maxBodyBytes)
            )
              throw new GatewayError(
                413,
                "body_too_large",
                "Request body exceeds the configured byte limit",
              );
            const body = request.body
              ? await new Response(
                  exchange.wrap(request.body, {
                    maxBytes: options.maxBodyBytes,
                    overflowStatus: 413,
                  }),
                ).arrayBuffer()
              : new ArrayBuffer(0);
            request = new Request(request, { body, signal: exchange.controller.signal });
            if (conversation && body.byteLength) conversationBody = new TextDecoder().decode(body);
            if (chat) {
              const adapted = chatRequest(request, body);
              request = adapted.request;
              includeUsage = adapted.includeUsage;
              original = adapted.stored;
              metadata = adapted.metadata;
            }
          } else request = new Request(request, { signal: exchange.controller.signal });
          const current = await exchange.wait(credentials());
          if (accountId !== undefined && accountId !== current.accountId) bridge.reset();
          accountId = current.accountId;
          if (chatOperation && !chat && store) {
            const result = await createChatStorage(store, storage).handle(
              request,
              current.accountId,
            );
            exchange.close();
            return result;
          }
          if (original && store)
            reservation = createChatStorage(store, {
              ...storage,
              reservationMs: options.timeoutMs,
            }).reserve(current.accountId, original);
          let response: Response;
          const cancel = path.match(/^\/v1\/responses\/([^/]+)\/cancel$/);
          if (conversation && store) {
            response = conversations(
              request,
              current.accountId ?? "local",
              store,
              conversationBody,
              storage.now,
            );
          } else if (request.method === "POST" && cancel?.[1] && background) {
            response = background.cancel(current.accountId, decodeURIComponent(cancel[1]));
          } else if (!chat && request.method === "POST" && path === "/v1/responses" && background) {
            let parsed: unknown;
            try {
              parsed = await request.clone().json();
            } catch {
              throw new GatewayError(400, "invalid_json", "Responses requires a JSON object");
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
              throw new GatewayError(400, "invalid_request", "Responses requires a JSON object");
            if ("background" in parsed && parsed.background === true)
              response = await background.create(
                request,
                parsed as Record<string, unknown>,
                current,
              );
            else response = await exchange.wait(lifecycleFor(current)(request, current.accountId));
          } else response = await exchange.wait(lifecycleFor(current)(request, current.accountId));
          if (chat) {
            response =
              response.ok &&
              response.body &&
              response.headers.get("content-type")?.includes("text/event-stream")
                ? new Response(
                    response.body.pipeThrough(
                      chatStream(includeUsage, options.maxBodyBytes, reservation?.save),
                    ),
                    response,
                  )
                : await exchange.wait(
                    chatResponse(
                      response,
                      reservation?.save ??
                        (metadata === undefined
                          ? undefined
                          : (value) => ({ ...chatObject(value), metadata })),
                    ),
                  );
          }
          let body = response.body;
          if (!body) {
            exchange.close();
            return response;
          }
          if (reservation && response.headers.get("content-type")?.includes("text/event-stream")) {
            const owner = reservation;
            const reader = body.getReader();
            body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (next.done) {
                    owner.release();
                    controller.close();
                  } else controller.enqueue(next.value);
                } catch (error) {
                  owner.release();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                owner.release();
                await reader.cancel(reason);
              },
            });
            streaming = true;
          }
          return new Response(
            exchange.wrap(body, {
              complete: true,
              direct: true,
              sse: response.headers.get("content-type")?.includes("text/event-stream") === true,
            }),
            response,
          );
        } catch (error) {
          exchange.close();
          if (error instanceof GatewayError)
            return Response.json(
              { error: { code: error.code, message: error.message } },
              { status: error.status },
            );
          throw error;
        } finally {
          if (!streaming) reservation?.release();
        }
      }
      return relay(request);
    },
    close() {
      background?.close();
      bridge.close();
      if (!storage.store) store?.close();
    },
  };
}
