import { type CredentialProvider, GatewayError, type ProxyOptions } from "../shared/contracts";
import { chatRequest, chatResponse } from "./chat-adapter";
import { compactResponse } from "./response-compact";
import { restoreStreamOutput } from "./response-stream-adapter";
import { createResponsesLifecycle } from "./responses-store";
import { createResponsesBridge } from "./responses-ws-bridge";
import { forward } from "./upstream";
import { Exchange } from "./upstream-stream";

export function createResponsesGateway(options: ProxyOptions, credentials: CredentialProvider) {
  const bridge = createResponsesBridge(options, credentials);
  let accountId: string | undefined;
  const relay = (request: Request) => forward(request, options, credentials);
  const lifecycle = createResponsesLifecycle(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/responses/compact")
      return compactResponse(request, options, credentials, relay);
    if (request.method === "POST" && path === "/v1/responses") {
      const response = await bridge.forward(request);
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
    return relay(request);
  });
  return {
    async forward(request: Request): Promise<Response> {
      if (options.translationMode !== "minimal") return relay(request);
      const path = new URL(request.url).pathname;
      const chat = path === "/v1/chat/completions" && request.method === "POST";
      if ((path === "/v1/chat/completions" || path.startsWith("/v1/chat/completions/")) && !chat)
        return Response.json(
          {
            error: {
              code: "unsupported_chat_contract",
              message: "Stored Chat operations are not implemented",
            },
          },
          { status: 501 },
        );
      if (chat || path === "/v1/responses" || path.startsWith("/v1/responses/")) {
        const exchange = new Exchange(request.signal, options.timeoutMs);
        try {
          if (chat || (request.method === "POST" && path === "/v1/responses")) {
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
            if (chat) request = chatRequest(request, body);
          } else request = new Request(request, { signal: exchange.controller.signal });
          const current = await exchange.wait(credentials());
          if (accountId !== undefined && accountId !== current.accountId) lifecycle.clear();
          accountId = current.accountId;
          let response = await exchange.wait(lifecycle(request));
          if (chat) response = await exchange.wait(chatResponse(response));
          if (!response.body) {
            exchange.close();
            return response;
          }
          return new Response(
            exchange.wrap(response.body, {
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
        }
      }
      return lifecycle(request);
    },
    close() {
      bridge.close();
      lifecycle.clear();
    },
  };
}
