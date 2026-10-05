import { z } from "zod";
import { type CredentialProvider, GatewayError, type ProxyOptions } from "../shared/contracts";

const requestSchema = z.looseObject({
  input: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
});
const responseSchema = z.looseObject({
  id: z.string(),
  created_at: z.number(),
  status: z.literal("completed"),
  output: z.array(
    z.looseObject({
      id: z.unknown().optional(),
      type: z.unknown().optional(),
      encrypted_content: z.unknown().optional(),
    }),
  ),
  usage: z.record(z.string(), z.unknown()),
});

export type CompactRelay = (
  request: Request,
  options: ProxyOptions,
  credentials: CredentialProvider,
) => Promise<Response>;

export async function compactResponse(
  request: Request,
  options: ProxyOptions,
  credentials: CredentialProvider,
  relay: CompactRelay,
): Promise<Response> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > options.maxBodyBytes)
    throw new GatewayError(413, "body_too_large", "Request body exceeds the configured byte limit");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new GatewayError(400, "invalid_json", "Responses compact requires a JSON object");
    throw error;
  }
  const result = requestSchema.safeParse(parsed);
  if (!result.success)
    throw new GatewayError(400, "invalid_request", "Responses compact requires a JSON object");

  const input = result.data.input;
  const history =
    typeof input === "string"
      ? [{ role: "user", content: [{ type: "input_text", text: input }] }]
      : Array.isArray(input)
        ? input
        : [];
  const nativePayload = JSON.stringify({
    ...result.data,
    input: [...history, { type: "compaction_trigger" }],
    stream: false,
  });
  const target = new URL(request.url);
  target.pathname = target.pathname.replace(/\/compact\/?$/, "");
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const nativeRequest = new Request(target.toString(), {
    method: "POST",
    headers,
    body: nativePayload,
    signal: request.signal,
  });
  const upstream = await relay(nativeRequest, options, credentials);
  if (!upstream.ok) return upstream;

  let raw: unknown;
  try {
    raw = await upstream.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new GatewayError(
        502,
        "invalid_compaction_response",
        "Upstream returned invalid compact JSON",
      );
    throw error;
  }
  const completed = responseSchema.safeParse(raw);
  const compactionItems = completed.success
    ? completed.data.output.filter(
        (item) =>
          item.type === "compaction" &&
          typeof item.id === "string" &&
          typeof item.encrypted_content === "string" &&
          item.encrypted_content.length > 0,
      )
    : [];
  if (!completed.success || compactionItems.length !== 1)
    throw new GatewayError(
      502,
      "invalid_compaction_response",
      "Upstream did not return one completed compaction item",
    );

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("content-type", "application/json");
  responseHeaders.delete("content-length");
  return Response.json(
    {
      id: completed.data.id,
      created_at: completed.data.created_at,
      object: "response.compaction",
      output: completed.data.output,
      usage: completed.data.usage,
    },
    { status: upstream.status, headers: responseHeaders },
  );
}
