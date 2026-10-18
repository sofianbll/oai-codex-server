import { z } from "zod";
import { GatewayError } from "../shared/contracts";
import type { DurableStore } from "./durable-store";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const status = z.enum(["in_progress", "completed", "incomplete"]);
const text = z.object({ type: z.literal("input_text"), text: z.string() }).strict();
const outputText = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
    annotations: z.array(z.never()).default([]),
    logprobs: z.array(z.never()).optional(),
  })
  .strict();
const image = z
  .object({
    type: z.literal("input_image"),
    image_url: z.string().nullable().optional(),
    file_id: z.string().nullable().optional(),
    detail: z.enum(["auto", "low", "high", "original"]).optional(),
  })
  .strict()
  .refine((v) => !!v.image_url || !!v.file_id);
const file = z
  .object({
    type: z.literal("input_file"),
    file_id: z.string().optional(),
    file_url: z.string().optional(),
    file_data: z.string().optional(),
    filename: z.string().optional(),
  })
  .strict()
  .refine((v) => !!v.file_id || !!v.file_url || !!v.file_data);
const content = z.union([
  text,
  outputText,
  image,
  file,
  z.object({ type: z.literal("refusal"), refusal: z.string() }).strict(),
]);
// Explicit local subset of ResponseInputItem; other public variants are refused, never stored unchecked.
const itemSchema = z.union([
  z
    .object({
      type: z.literal("message").optional(),
      id: id.optional(),
      role: z.enum(["user", "assistant", "system", "developer"]),
      content: z.union([z.string(), z.array(content)]),
      status: status.optional(),
      phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
    })
    .strict()
    .refine(
      (v) =>
        v.role === "assistant" ||
        (v.phase === undefined &&
          (typeof v.content === "string" ||
            v.content.every((part) => !["output_text", "refusal"].includes(part.type)))),
    ),
  z
    .object({
      type: z.literal("function_call"),
      id: id.optional(),
      call_id: z.string().min(1),
      name: z.string().min(1),
      arguments: z.string(),
      status: status.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call_output"),
      id: id.optional(),
      call_id: z.string().min(1),
      output: z.union([z.string(), z.array(z.union([text, image, file]))]),
      status: status.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      id: id,
      summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() }).strict()),
      encrypted_content: z.string().nullable().optional(),
      content: z
        .array(z.object({ type: z.literal("reasoning_text"), text: z.string() }).strict())
        .optional(),
      status: status.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("compaction"), id: id.optional(), encrypted_content: z.string() })
    .strict(),
]);
const itemsSchema = z.array(itemSchema).max(20);
const metadata = z
  .record(z.string().max(64), z.string().max(512))
  .refine((v) => Object.keys(v).length <= 16)
  .nullable();
const createSchema = z
  .object({ items: itemsSchema.nullable().optional(), metadata: metadata.optional() })
  .strict();
const updateSchema = z.object({ metadata }).strict();
const addSchema = z.object({ items: itemsSchema }).strict();
type Conversation = {
  id: string;
  object: "conversation";
  created_at: number;
  metadata: Record<string, string> | null;
};
type Item = Record<string, unknown> & { id: string };
const invalid = (message: string): never => {
  throw new GatewayError(400, "invalid_conversation_request", message);
};
const missing = (): never => {
  throw new GatewayError(404, "not_found", "Conversation or item not found in this account");
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  return result.success
    ? result.data
    : invalid(
        "Invalid or unsupported Conversation contract: " +
          result.error.issues.map((i) => i.path.join(".")).join(", "),
      );
};
const list = (data: Item[], has_more = false) => ({
  object: "list",
  data,
  first_id: data[0]?.id ?? null,
  last_id: data.at(-1)?.id ?? null,
  has_more,
});

export function conversations(
  request: Request,
  account: string,
  store: DurableStore,
  requestBody = "{}",
  now = Date.now,
): Response {
  const url = new URL(request.url);
  let segments: string[];
  try {
    segments = url.pathname.split("/").slice(3).map(decodeURIComponent);
  } catch {
    return invalid("Malformed path");
  }
  const [conversationId, collection, itemId] = segments;
  if (segments.length > 3 || (collection !== undefined && collection !== "items")) return missing();
  const isItems = collection === "items";
  const allowed =
    isItems && request.method === "GET"
      ? ["order", "limit", "after", "include[]"]
      : isItems && request.method === "POST"
        ? ["include[]"]
        : [];
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key)) invalid(`Unsupported query: ${key}`);
  const includes = [
    "web_search_call.action.sources",
    "code_interpreter_call.outputs",
    "computer_call_output.output.image_url",
    "file_search_call.results",
    "message.input_image.image_url",
    "message.output_text.logprobs",
    "reasoning.encrypted_content",
  ];
  for (const value of url.searchParams.getAll("include[]"))
    if (!includes.includes(value)) invalid("Unsupported include");
  const body = () => {
    try {
      return JSON.parse(requestBody) as unknown;
    } catch {
      return invalid("Expected JSON body");
    }
  };
  // The gateway has already bounded and decoded the request body before entering the transaction.
  return store.atomic(() => {
    const parent = () => {
      if (!conversationId || !id.safeParse(conversationId).success) return missing();
      return (
        (store.get(account, "conversation", conversationId) as Conversation | undefined) ??
        missing()
      );
    };
    const append = (conversation: Conversation, inputs: z.infer<typeof itemsSchema>) => {
      const result: Item[] = inputs.map((input) => {
        const item: Item = {
          ...input,
          id:
            input.id ??
            `${!("type" in input) || input.type === "message" ? "msg" : "item"}_${crypto.randomUUID().replaceAll("-", "")}`,
        };
        if (!("type" in input) || input.type === undefined || input.type === "message") {
          item["type"] = "message";
          item["status"] ??= "completed";
          if (typeof item["content"] === "string")
            item["content"] = [
              {
                type: input.role === "assistant" ? "output_text" : "input_text",
                text: item["content"],
                ...(input.role === "assistant" ? { annotations: [] } : {}),
              },
            ];
        }
        return item;
      });
      const seen = new Set<string>();
      for (const item of result) {
        if (seen.has(item.id) || store.get(account, "conversation-item", item.id) !== undefined)
          invalid("Item ID already retained in this account");
        seen.add(item.id);
      }
      for (const item of result) {
        store.put(account, "conversation-item", item.id, item);
        store.put(account, `conversation-links:${conversation.id}`, item.id, { id: item.id });
      }
      return result;
    };
    if (!conversationId) {
      if (request.method !== "POST") return missing();
      const input = parse(createSchema, body());
      const conversation: Conversation = {
        id: `conv_${crypto.randomUUID().replaceAll("-", "")}`,
        object: "conversation",
        created_at: Math.floor(now() / 1000),
        metadata: input.metadata ?? {},
      };
      if (
        store.get(account, "conversation", conversation.id) ||
        store.listByInsertion(account, `conversation-links:${conversation.id}`, "asc", 1).length
      )
        invalid("Conversation ID collision");
      store.put(account, "conversation", conversation.id, conversation);
      append(conversation, input.items ?? []);
      return Response.json(conversation);
    }
    const conversation = parent();
    if (!isItems) {
      if (request.method === "GET") return Response.json(conversation);
      if (request.method === "POST") {
        const input = parse(updateSchema, body());
        const updated = { ...conversation, metadata: input.metadata };
        store.put(account, "conversation", conversation.id, updated);
        return Response.json(updated);
      }
      if (request.method === "DELETE") {
        store.delete(account, "conversation", conversation.id);
        return Response.json({
          id: conversation.id,
          object: "conversation.deleted",
          deleted: true,
        });
      }
      return missing();
    }
    const kind = `conversation-links:${conversation.id}`;
    if (itemId) {
      if (!store.get(account, kind, itemId)) return missing();
      if (request.method === "GET")
        return Response.json(store.get(account, "conversation-item", itemId) ?? missing());
      if (request.method === "DELETE") {
        store.delete(account, kind, itemId);
        store.delete(account, "conversation-item", itemId);
        return Response.json(conversation);
      }
      return missing();
    }
    if (request.method === "POST")
      return Response.json(list(append(conversation, parse(addSchema, body()).items)));
    if (request.method !== "GET") return missing();
    const order = url.searchParams.get("order") ?? "desc";
    const limit = url.searchParams.get("limit") ?? "20";
    if (
      (order !== "asc" && order !== "desc") ||
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 100
    )
      invalid("Invalid order or limit");
    const rows = store.listByInsertion(
      account,
      kind,
      order as "asc" | "desc",
      Number(limit) + 1,
      url.searchParams.get("after") ?? undefined,
    );
    return Response.json(
      list(
        rows
          .slice(0, Number(limit))
          .map((row) => store.get(account, "conversation-item", row.id) as Item),
        rows.length > Number(limit),
      ),
    );
  });
}
