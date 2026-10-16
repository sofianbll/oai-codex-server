import { z } from "zod";
import { GatewayError } from "../shared/contracts";
import { chatCompletion } from "./chat-adapter";

const eventSchema = z.looseObject({
  type: z.string().optional(),
  response: z.unknown().optional(),
  delta: z.string().optional(),
  error: z.unknown().optional(),
  output_index: z.number().int().nonnegative().optional(),
  item: z.unknown().optional(),
  item_id: z.string().optional(),
});
const callSchema = z.looseObject({
  type: z.literal("function_call"),
  id: z.string().optional(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});
const identitySchema = z.looseObject({
  id: z.string().min(1),
  created_at: z.number(),
  model: z.string(),
});
// Lifecycle/content snapshots are reconciled against the terminal; reasoning is never final text.
const snapshotEvents = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.refusal.done",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
]);

export function chatStream(
  includeUsage: boolean,
  maxBytes: number,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let identity: { id: string; created: number; model: string } | undefined;
  let text = "";
  let refusal = "";
  let terminal = false;
  const calls = new Map<
    number,
    { index: number; id: string; itemId: string | undefined; name: string; arguments: string }
  >();
  const invalid = (message: string): never => {
    throw new GatewayError(502, "unsupported_chat_output", message);
  };
  return new TransformStream({
    transform(chunk, controller) {
      const emit = (delta: Record<string, unknown>, finish: string | null = null) => {
        if (!identity) invalid("Chat delta received before response identity");
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ ...identity, object: "chat.completion.chunk", choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...(includeUsage ? { usage: null } : {}) })}\n\n`,
          ),
        );
      };
      const tool = (outputIndex: number, value: unknown) => {
        const item = callSchema.parse(value);
        let call = calls.get(outputIndex);
        if (!call) {
          if ([...calls.values()].some((call) => call.id === item.call_id))
            invalid("Duplicate upstream tool call id");
          call = {
            index: calls.size,
            id: item.call_id,
            itemId: item.id,
            name: item.name,
            arguments: "",
          };
          calls.set(outputIndex, call);
          emit({
            tool_calls: [
              {
                index: call.index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          });
        }
        if (
          call.id !== item.call_id ||
          (call.itemId !== undefined && item.id !== undefined && call.itemId !== item.id) ||
          call.name !== item.name ||
          !item.arguments.startsWith(call.arguments)
        )
          invalid("Inconsistent tool call output");
        const suffix = item.arguments.slice(call.arguments.length);
        if (suffix) emit({ tool_calls: [{ index: call.index, function: { arguments: suffix } }] });
        call.arguments = item.arguments;
      };
      pending += decoder.decode(chunk, { stream: true });
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const raw = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (raw && raw !== "[DONE]") {
          const parsedEvent = eventSchema.parse(JSON.parse(raw));
          const event = {
            ...parsedEvent,
            type:
              parsedEvent.type ??
              (parsedEvent.error ? "error" : invalid("Missing upstream event type")),
          };
          if (
            !snapshotEvents.has(event.type) &&
            ![
              "error",
              "response.failed",
              "response.incomplete",
              "response.completed",
              "response.output_text.delta",
              "response.refusal.delta",
              "response.output_item.added",
              "response.output_item.done",
              "response.function_call_arguments.delta",
            ].includes(event.type)
          )
            invalid(`Unsupported Chat stream event: ${event.type}`);
          if (terminal) invalid("Events received after Chat terminal");
          if (
            event.type === "error" ||
            event.type === "response.failed" ||
            event.type === "response.incomplete"
          ) {
            const response = z
              .looseObject({ error: z.unknown().optional() })
              .safeParse(event.response);
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ ...event, error: event.error ?? (response.success ? response.data.error : undefined) ?? { code: "upstream_response_failed", message: "Upstream response did not complete" } })}\n\n`,
              ),
            );
            terminal = true;
          } else {
            if (event.response && !identity) {
              const data = identitySchema.parse(event.response);
              identity = {
                id: `chatcmpl_${data.id.replace(/^resp_/, "")}`,
                created: data.created_at,
                model: data.model,
              };
              emit({ role: "assistant" });
            }
            if (
              event.type === "response.output_text.delta" ||
              event.type === "response.refusal.delta"
            ) {
              const value = event.delta ?? invalid("Missing Chat content delta");
              if (event.type === "response.output_text.delta") {
                text += value;
                emit({ content: value });
              } else {
                refusal += value;
                emit({ refusal: value });
              }
            }
            if (
              event.type === "response.output_item.added" ||
              event.type === "response.output_item.done"
            ) {
              const item = z.looseObject({ type: z.string() }).parse(event.item);
              if (item.type === "function_call") {
                tool(event.output_index ?? invalid("Missing tool output index"), event.item);
              } else if (!["message", "reasoning"].includes(item.type))
                invalid("Unsupported structured Chat output");
            }
            if (event.type === "response.function_call_arguments.delta") {
              const call =
                (event.output_index === undefined ? undefined : calls.get(event.output_index)) ??
                invalid("Tool argument delta has no matching call");
              const delta = event.delta ?? invalid("Missing tool argument delta");
              if (
                event.item_id !== undefined &&
                call.itemId !== undefined &&
                event.item_id !== call.itemId
              )
                invalid("Tool argument delta has a conflicting item id");
              call.arguments += delta;
              emit({ tool_calls: [{ index: call.index, function: { arguments: delta } }] });
            }
            if (event.type === "response.completed") {
              const final = chatCompletion(event.response);
              if (
                identity?.id !== final.id ||
                identity.model !== final.model ||
                identity.created !== final.created
              )
                invalid("Inconsistent Chat response identity");
              for (const [key, sent] of [
                ["content", text],
                ["refusal", refusal],
              ] as const) {
                const value = final.message[key];
                if (!(value ?? "").startsWith(sent))
                  invalid("Terminal content does not match streamed Chat deltas");
                if (value !== null && (value.length > sent.length || sent === ""))
                  emit({ [key]: value.slice(sent.length) });
              }
              const output = z
                .looseObject({ output: z.array(z.unknown()) })
                .parse(event.response).output;
              output.forEach((item, index) => {
                const parsed = callSchema.safeParse(item);
                if (parsed.success) {
                  const existing = [...calls].find(([, call]) => call.id === parsed.data.call_id);
                  tool(existing?.[0] ?? index, item);
                }
              });
              if (calls.size !== (final.message.tool_calls?.length ?? 0))
                invalid("Terminal tool calls do not match streamed calls");
              for (const call of calls.values())
                if (final.message.tool_calls?.[call.index]?.id !== call.id)
                  invalid("Terminal tool call order does not match streamed calls");
              emit({}, calls.size ? "tool_calls" : "stop");
              if (includeUsage)
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ ...identity, object: "chat.completion.chunk", choices: [], usage: final.usage ?? null })}\n\n`,
                  ),
                );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              terminal = true;
            }
          }
        }
        boundary = pending.indexOf("\n\n");
      }
      if (
        encoder.encode(pending + text + refusal + JSON.stringify([...calls])).byteLength > maxBytes
      )
        throw new GatewayError(
          502,
          "body_too_large",
          "Buffered Chat output exceeds the configured byte limit",
        );
    },
    flush() {
      if (!terminal || pending.trim())
        invalid("Upstream Chat stream ended without a terminal event");
    },
  });
}
