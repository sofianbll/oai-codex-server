import { forward } from "../../src/server/upstream";
import { GatewayError, type ProxyOptions } from "../../src/shared/contracts";

export const credentials = async () => ({
  accessToken: "fixture-token",
  accountId: "fixture-account",
});

export function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  overrides: Partial<ProxyOptions> = {},
) {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const options: ProxyOptions = {
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    timeoutMs: 2_000,
    maxBodyBytes: 1024 * 1024,
    defaultModel: "fixture-model",
    clientVersion: "0.0.1-fixture",
    translationMode: "minimal",
    ...overrides,
  };
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        return await forward(request, options, credentials);
      } catch (error) {
        if (error instanceof GatewayError) {
          return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: error.status },
          );
        }
        throw error;
      }
    },
  });
  return {
    options,
    url: `${gateway.url.origin}/v1`,
    close() {
      gateway.stop(true);
      upstream.stop(true);
    },
  };
}

export function sse(event: Readonly<Record<string, unknown>>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function completed(text = "Bonjour 🌍") {
  return {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    model: "fixture-model",
    output: [
      {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    future_metadata: { preserved: true },
  };
}
