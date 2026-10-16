import { z } from "zod";
import { GatewayError } from "../shared/contracts";

const textPart = z.strictObject({ type: z.literal("text"), text: z.string() });
const message = z.strictObject({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(textPart).min(1)]),
});
const requestSchema = z.strictObject({
  model: z.string().min(1).optional(),
  messages: z.array(message).min(1),
  stream: z.literal(false).optional(),
  store: z.literal(false).optional(),
  n: z.literal(1).optional(),
});

export function chatRequest(request: Request, body: ArrayBuffer): Request {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new GatewayError(400, "invalid_json", "Chat Completions requires a JSON object");
  }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success)
    throw new GatewayError(
      400,
      "unsupported_chat_contract",
      `Chat JSON supports model, text messages (system/developer/user/assistant), stream:false, store:false and n:1 only. Unsupported or invalid fields: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join("; ")}`,
    );
  const data = parsed.data;
  const url = new URL(request.url);
  url.pathname = "/v1/responses";
  if (url.search)
    throw new GatewayError(
      400,
      "unsupported_chat_contract",
      "Chat query parameters are not implemented",
    );
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(url.toString(), {
    method: "POST",
    headers,
    signal: request.signal,
    body: JSON.stringify({
      ...(data.model === undefined ? {} : { model: data.model }),
      store: false,
      stream: false,
      input: data.messages.map((item) => ({
        role: item.role,
        content: (typeof item.content === "string" ? [{ text: item.content }] : item.content).map(
          (part) => ({
            type: item.role === "assistant" ? "output_text" : "input_text",
            text: part.text,
          }),
        ),
      })),
    }),
  });
}

const outputPart = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("output_text"),
    text: z.string(),
    annotations: z.array(z.never()).optional(),
  }),
  z.looseObject({ type: z.literal("refusal"), refusal: z.string() }),
]);
const terminalSchema = z.looseObject({
  id: z.string().min(1),
  created_at: z.number(),
  model: z.string(),
  status: z.literal("completed"),
  output: z.array(
    z.union([
      z.looseObject({
        type: z.literal("message"),
        role: z.literal("assistant"),
        content: z.array(outputPart),
      }),
      z.looseObject({ type: z.literal("reasoning") }),
    ]),
  ),
  usage: z
    .looseObject({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      input_tokens_details: z.record(z.string(), z.unknown()).nullish(),
      output_tokens_details: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
});

export async function chatResponse(response: Response): Promise<Response> {
  // Failures retain the Responses engine's status and error payload, never a fabricated completion.
  if (!response.ok) return response;
  const parsed = terminalSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new GatewayError(
      502,
      "unsupported_chat_output",
      "Upstream output cannot be represented by the implemented Chat JSON text contract",
    );
  const data = parsed.data;
  const parts = data.output.flatMap((item) => (item.type === "message" ? item.content : []));
  const text = parts
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
  const refusal = parts
    .filter((part) => part.type === "refusal")
    .map((part) => part.refusal)
    .join("");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return Response.json(
    {
      id: `chatcmpl_${data.id.replace(/^resp_/, "")}`,
      object: "chat.completion",
      created: data.created_at,
      model: data.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: parts.some((part) => part.type === "output_text") ? text : null,
            refusal: parts.some((part) => part.type === "refusal") ? refusal : null,
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      ...(data.usage
        ? {
            usage: {
              prompt_tokens: data.usage.input_tokens,
              completion_tokens: data.usage.output_tokens,
              total_tokens: data.usage.total_tokens,
              ...(data.usage.input_tokens_details
                ? { prompt_tokens_details: data.usage.input_tokens_details }
                : {}),
              ...(data.usage.output_tokens_details
                ? { completion_tokens_details: data.usage.output_tokens_details }
                : {}),
            },
          }
        : {}),
    },
    { status: response.status, headers },
  );
}
