import { z } from "zod";
import { GatewayError } from "../shared/contracts";
import { metadataPairs } from "./metadata";

const textPart = z.strictObject({ type: z.literal("text"), text: z.string() });
const content = z.union([z.string(), z.array(textPart).min(1)]);
const toolCall = z.strictObject({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.strictObject({ name: z.string().min(1), arguments: z.string() }),
});
const message = z.discriminatedUnion("role", [
  z.strictObject({ role: z.enum(["system", "developer", "user"]), content }),
  z
    .strictObject({
      role: z.literal("assistant"),
      content: content.nullish(),
      refusal: z.null().optional(),
      tool_calls: z.array(toolCall).min(1).optional(),
    })
    .refine(
      (item) => item.content != null || item.tool_calls !== undefined,
      "Assistant requires content or tool calls",
    ),
  z.strictObject({ role: z.literal("tool"), content: z.string(), tool_call_id: z.string().min(1) }),
]);
const tool = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional(),
  }),
});
const requestSchema = z.strictObject({
  model: z.string().min(1).optional(),
  messages: z.array(message).min(1),
  stream: z.boolean().optional(),
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).optional(),
  store: z.boolean().optional(),
  metadata: metadataPairs.nullable().optional(),
  n: z.literal(1).optional(),
  tools: z.array(tool).optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.strictObject({
        type: z.literal("function"),
        function: z.strictObject({ name: z.string().min(1) }),
      }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
});

export function chatRequest(
  request: Request,
  body: ArrayBuffer,
): {
  request: Request;
  includeUsage: boolean;
  metadata: Record<string, string> | null | undefined;
  stored: { messages: unknown[]; metadata: Record<string, string> | null } | undefined;
} {
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
      `Unsupported or invalid Chat fields: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join("; ")}`,
    );
  const data = parsed.data;
  if (data.stream_options && !data.stream)
    throw new GatewayError(400, "unsupported_chat_contract", "stream_options requires stream:true");
  const input: Record<string, unknown>[] = [];
  const pendingCalls = new Set<string>();
  const seenCalls = new Set<string>();
  for (const item of data.messages) {
    if (item.role === "tool") {
      if (!pendingCalls.delete(item.tool_call_id))
        throw new GatewayError(
          400,
          "unsupported_chat_contract",
          "Tool result must reference one pending tool_call_id exactly once",
        );
      input.push({
        type: "function_call_output",
        call_id: item.tool_call_id,
        output: item.content,
      });
      continue;
    }
    if (pendingCalls.size)
      throw new GatewayError(
        400,
        "unsupported_chat_contract",
        "Tool calls require results before the next message",
      );
    if (item.content != null)
      input.push({
        role: item.role,
        content: (typeof item.content === "string" ? [{ text: item.content }] : item.content).map(
          (part) => ({
            type: item.role === "assistant" ? "output_text" : "input_text",
            text: part.text,
          }),
        ),
      });
    if (item.role === "assistant")
      for (const call of item.tool_calls ?? []) {
        if (seenCalls.has(call.id))
          throw new GatewayError(400, "unsupported_chat_contract", "Duplicate tool call id");
        seenCalls.add(call.id);
        pendingCalls.add(call.id);
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
  }
  if (pendingCalls.size)
    throw new GatewayError(
      400,
      "unsupported_chat_contract",
      "Tool calls require results before generation",
    );
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
  return {
    metadata: data.metadata,
    stored:
      data.store === true
        ? { messages: data.messages, metadata: data.metadata === undefined ? null : data.metadata }
        : undefined,
    includeUsage: data.stream_options?.include_usage === true,
    request: new Request(url.toString(), {
      method: "POST",
      headers,
      signal: request.signal,
      body: JSON.stringify({
        ...(data.model === undefined ? {} : { model: data.model }),
        store: false,
        stream: data.stream === true,
        input,
        ...(data.tools === undefined
          ? {}
          : { tools: data.tools.map((tool) => ({ type: tool.type, ...tool.function })) }),
        ...(data.tool_choice === undefined
          ? {}
          : {
              tool_choice:
                typeof data.tool_choice === "string"
                  ? data.tool_choice
                  : { type: "function", name: data.tool_choice.function.name },
            }),
        ...(data.parallel_tool_calls === undefined
          ? {}
          : { parallel_tool_calls: data.parallel_tool_calls }),
      }),
    }),
  };
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
      z.looseObject({
        type: z.literal("function_call"),
        call_id: z.string().min(1),
        name: z.string().min(1),
        arguments: z.string(),
      }),
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

export function chatCompletion(value: unknown) {
  const parsed = terminalSchema.safeParse(value);
  if (!parsed.success)
    throw new GatewayError(
      502,
      "unsupported_chat_output",
      "Upstream output cannot be represented by the implemented Chat contract",
    );
  const data = parsed.data;
  const parts = data.output.flatMap((item) => (item.type === "message" ? item.content : []));
  const calls = data.output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: item.call_id,
      type: "function" as const,
      function: { name: item.name, arguments: item.arguments },
    }));
  if (new Set(calls.map((call) => call.id)).size !== calls.length)
    throw new GatewayError(502, "unsupported_chat_output", "Duplicate upstream tool call id");
  return {
    id: `chatcmpl_${data.id.replace(/^resp_/, "")}`,
    created: data.created_at,
    model: data.model,
    message: {
      role: "assistant" as const,
      content: parts.some((part) => part.type === "output_text")
        ? parts
            .filter((part) => part.type === "output_text")
            .map((part) => part.text)
            .join("")
        : null,
      refusal: parts.some((part) => part.type === "refusal")
        ? parts
            .filter((part) => part.type === "refusal")
            .map((part) => part.refusal)
            .join("")
        : null,
      ...(calls.length ? { tool_calls: calls } : {}),
    },
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.total_tokens,
          ...(data.usage.input_tokens_details
            ? { prompt_tokens_details: data.usage.input_tokens_details }
            : {}),
          ...(data.usage.output_tokens_details
            ? { completion_tokens_details: data.usage.output_tokens_details }
            : {}),
        }
      : undefined,
  };
}

export function chatObject(value: unknown) {
  const data = chatCompletion(value);
  return {
    id: data.id,
    object: "chat.completion",
    created: data.created,
    model: data.model,
    choices: [
      {
        index: 0,
        message: data.message,
        logprobs: null,
        finish_reason: data.message.tool_calls?.length ? "tool_calls" : "stop",
      },
    ],
    ...(data.usage ? { usage: data.usage } : {}),
  };
}

export async function chatResponse(
  response: Response,
  save?: (value: unknown) => unknown,
): Promise<Response> {
  // Failures retain the Responses engine's status and error payload, never a fabricated completion.
  if (!response.ok) return response;
  const value: unknown = await response.json();
  const result = save ? save(value) : chatObject(value);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return Response.json(result, { status: response.status, headers });
}
