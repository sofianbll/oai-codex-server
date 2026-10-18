import { z } from "zod";
import { GatewayError } from "../shared/contracts";
import { chatObject } from "./chat-adapter";
import type { DurableStore } from "./durable-store";
import { metadataPairs } from "./metadata";
import type { ResponsesStoreOptions } from "./responses-store";

type StoredChat = {
  completion: ReturnType<typeof chatObject> & { metadata: Record<string, string> | null };
  messages: Record<string, unknown>[];
  output: unknown;
};
const invalid = (message: string): never => {
  throw new GatewayError(400, "invalid_chat_request", message);
};
const missing = (): never => {
  throw new GatewayError(404, "not_found", "Stored Chat completion was not found or expired");
};

function pagination(url: URL, filters = false) {
  const metadata: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1) invalid("Duplicate query parameter");
    if (["after", "limit", "order"].includes(key) || (filters && key === "model")) continue;
    const match = filters ? /^metadata\[([\s\S]*)\]$/.exec(key) : null;
    if (match?.[1] === undefined) return invalid(`Unsupported query parameter: ${key}`);
    metadata[match[1]] = value;
  }
  if (!metadataPairs.safeParse(metadata).success) invalid("Invalid metadata filter");
  const limit = url.searchParams.get("limit") ?? "20";
  const order = url.searchParams.get("order") ?? "asc";
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    invalid("limit must be between 1 and 100");
  if (order !== "asc" && order !== "desc") return invalid("order must be asc or desc");
  const after = url.searchParams.get("after");
  if (after === "") invalid("after must be a nonempty cursor");
  return { limit: Number(limit), order, ...(after ? { after } : {}), metadata } as const;
}

function page<T extends { id: string }>(data: T[], limit: number) {
  const visible = data.slice(0, limit);
  return Response.json({
    object: "list",
    data: visible,
    first_id: visible[0]?.id ?? null,
    last_id: visible.at(-1)?.id ?? null,
    has_more: data.length > limit,
  });
}

export function createChatStorage(store: DurableStore, options: ResponsesStoreOptions) {
  return {
    reserve(
      account: string,
      original: { messages: unknown[]; metadata: Record<string, string> | null },
    ) {
      if (Buffer.byteLength(JSON.stringify(original)) > store.maxRecordBytes)
        throw new GatewayError(
          507,
          "stored_chat_too_large",
          "Chat history exceeds the durable object limit",
        );
      const reservation = store.reserve(account, "chat", options.reservationMs ?? 900000);
      return {
        release: reservation.release,
        save(value: unknown) {
          const completion = { ...chatObject(value), metadata: original.metadata };
          const native = z.looseObject({ output: z.array(z.unknown()) }).parse(value);
          const messages = original.messages.map((item) => ({
            ...(item as Record<string, unknown>),
            id: `msg_${crypto.randomUUID()}`,
          }));
          const lastMessage = native.output
            .filter((item) => z.looseObject({ type: z.literal("message") }).safeParse(item).success)
            .at(-1);
          const identity = z.looseObject({ id: z.string().min(1) }).safeParse(lastMessage);
          messages.push({
            ...completion.choices[0]?.message,
            id: identity.success ? identity.data.id : `msg_${crypto.randomUUID()}`,
          });
          reservation.commit(
            completion.id,
            { completion, messages, output: native.output },
            (options.now ?? Date.now)() + (options.ttlMs ?? 30 * 24 * 60 * 60 * 1000),
          );
          return completion;
        },
      };
    },
    async handle(request: Request, account: string) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/chat/completions" && request.method === "GET") {
        const query = pagination(url, true);
        const equals: Record<string, string | Record<string, string>> = {};
        const model = url.searchParams.get("model");
        if (model !== null) equals["$.completion.model"] = model;
        equals["$.completion.metadata"] = query.metadata;
        const rows = store.list(account, "chat", {
          ...query,
          limit: query.limit + 1,
          sort: "$.completion.created",
          equals,
        }) as StoredChat[];
        return page(
          rows.map((row) => row.completion),
          query.limit,
        );
      }
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return invalid("Malformed path");
      }
      const match = /^\/v1\/chat\/completions\/([^/]+)(\/messages)?$/.exec(path);
      if (!match?.[1]) return invalid("Unsupported stored Chat operation");
      const id = match[1];
      if (request.method === "GET" && match[2]) {
        const query = pagination(url);
        const saved = store.get(account, "chat", id) as StoredChat | undefined;
        if (!saved) return missing();
        let messages = query.order === "asc" ? saved.messages : saved.messages.toReversed();
        if (query.after) {
          const index = messages.findIndex((item) => item["id"] === query.after);
          if (index < 0) invalid("Message cursor was not found");
          messages = messages.slice(index + 1);
        }
        return page(messages as { id: string }[], query.limit);
      }
      if (url.search || match[2]) return invalid("Unsupported stored Chat query or method");
      if (request.method === "GET") {
        const saved = store.get(account, "chat", id) as StoredChat | undefined;
        return saved ? Response.json(saved.completion) : missing();
      }
      if (request.method === "DELETE")
        return store.delete(account, "chat", id)
          ? Response.json({ id, object: "chat.completion.deleted", deleted: true })
          : missing();
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return invalid("Expected JSON metadata update");
        }
        const parsed = z.strictObject({ metadata: metadataPairs.nullable() }).safeParse(body);
        if (!parsed.success)
          return invalid("Only metadata (up to 16 string pairs, or null) can be updated");
        const saved = store.update(account, "chat", id, (value) => {
          const previous = value as StoredChat;
          return {
            ...previous,
            completion: { ...previous.completion, metadata: parsed.data.metadata },
          };
        }) as StoredChat | undefined;
        return saved ? Response.json(saved.completion) : missing();
      }
      return invalid("Unsupported stored Chat method");
    },
  };
}
