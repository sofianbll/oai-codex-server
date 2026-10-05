import type { CredentialProvider, ProxyOptions } from "../shared/contracts";
import { compactResponse } from "./response-compact";
import { restoreStreamOutput } from "./response-stream-adapter";
import { createResponsesLifecycle } from "./responses-store";
import { createResponsesBridge } from "./responses-ws-bridge";
import { forward } from "./upstream";

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
      if (path === "/v1/responses" || path.startsWith("/v1/responses/")) {
        const current = await credentials();
        if (accountId !== undefined && accountId !== current.accountId) lifecycle.clear();
        accountId = current.accountId;
      }
      return lifecycle(request);
    },
    close() {
      bridge.close();
      lifecycle.clear();
    },
  };
}
