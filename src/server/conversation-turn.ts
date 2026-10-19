import { GatewayError } from "../shared/contracts";
import { presentConversationItem } from "./conversation-items";
import {
  appendConversationItems,
  lockConversation,
  prepareConversationItems,
} from "./conversations";
import type { DurableStore } from "./durable-store";
import { originalInput, projectContext } from "./response-replay";

type Json = Record<string, unknown>;
export type ConversationTurn = ReturnType<typeof prepareConversationTurn>;

export function responseConversation(payload: Json): string | undefined {
  const value = payload["conversation"];
  if (value === undefined || value === null) return undefined;
  const id =
    typeof value === "string"
      ? value
      : typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).length === 1 &&
          "id" in value
        ? value.id
        : undefined;
  if (typeof id !== "string" || !id.length)
    throw new GatewayError(
      400,
      "invalid_conversation",
      "conversation must be null, a nonempty ID or exactly {id}",
    );
  if (payload["previous_response_id"] !== undefined && payload["previous_response_id"] !== null)
    throw new GatewayError(
      400,
      "conflicting_response_context",
      "conversation and previous_response_id cannot be combined",
    );
  return id;
}

export function prepareConversationTurn(
  store: DurableStore,
  account: string,
  id: string,
  payload: Json,
  durationMs: number,
  maxBytes: number,
) {
  if (!store.get(account, "conversation", id))
    throw new GatewayError(404, "not_found", "Conversation not found in this account");
  const records: (Json & { id: string })[] = [];
  let after: string | undefined;
  let bytes = 0;
  // Read one bounded object at a time rather than allocating an arbitrarily large history.
  for (;;) {
    const row = store.listByInsertion(account, `conversation-links:${id}`, "asc", 1, after)[0];
    if (!row) break;
    const item = store.get(account, "conversation-item", row.id) as
      | (Json & { id: string })
      | undefined;
    if (!item)
      throw new GatewayError(
        409,
        "conversation_context_incomplete",
        "A retained Conversation item is unavailable",
      );
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > maxBytes)
      throw new GatewayError(
        413,
        "body_too_large",
        "Conversation context exceeds the configured byte limit",
      );
    records.push(item);
    after = row.id;
  }
  const history = records.map(presentConversationItem);
  const input = originalInput(payload["input"]);
  if (!input)
    throw new GatewayError(
      400,
      "invalid_conversation_input",
      "Conversation requires text or item inputs",
    );
  if (input.some((item) => typeof item !== "object" || item === null || Array.isArray(item)))
    throw new GatewayError(400, "invalid_conversation_input", "Conversation inputs must be items");
  prepareConversationItems(store, account, input as Json[], true);
  const { conversation: _conversation, ...native } = payload;
  const projected = projectContext(history, true);
  const unlock = lockConversation(store, account, id);
  let capacity: ReturnType<DurableStore["reserve"]>;
  try {
    capacity = store.reserve(account, "conversation-turn", durationMs);
  } catch (error) {
    unlock();
    throw error;
  }
  const releaseCapacity = () => capacity.release();
  const release = () => {
    releaseCapacity();
    unlock();
  };
  return {
    id,
    release,
    releaseCapacity,
    context: [...records.map((item) => item["original"] ?? item), ...input],
    payload: { ...native, input: [...projected, ...input] },
    append(response: Json) {
      const output = response["output"];
      if (
        !Array.isArray(output) ||
        output.some((item) => typeof item !== "object" || item === null || Array.isArray(item))
      )
        throw new GatewayError(
          502,
          "invalid_conversation_output",
          "Terminal Response must contain an output array of items",
        );
      try {
        appendConversationItems(store, account, id, [...input, ...output] as Json[], true);
      } catch (error) {
        if (error instanceof GatewayError && [400, 501].includes(error.status))
          throw new GatewayError(
            502,
            "invalid_conversation_output",
            "The terminal turn cannot be retained faithfully (invalid item or account-wide ID collision)",
          );
        throw error;
      }
    },
  };
}
