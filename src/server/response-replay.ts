import {
  type ResponseInputItemLike,
  toResponseInputItem,
} from "openai/lib/responses/ResponseInputItems";
import { GatewayError } from "../shared/contracts";

type JsonObject = Readonly<Record<string, unknown>>;

export type StoredResponse = {
  readonly response: JsonObject;
  readonly input: readonly unknown[];
  // Original history, never the SDK projection or pagination-generated IDs.
  readonly context?: readonly unknown[];
};

export function originalInput(input: unknown): readonly unknown[] | undefined {
  if (Array.isArray(input)) return input;
  if (typeof input === "string")
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  return undefined;
}

export function completedContext(
  saved: StoredResponse | undefined,
): readonly unknown[] | undefined {
  if (
    !saved?.context ||
    saved.response["status"] !== "completed" ||
    !Array.isArray(saved.response["output"])
  )
    return undefined;
  return [...saved.context, ...saved.response["output"]];
}

export function restoreResponse(
  saved: StoredResponse | undefined,
  payload: JsonObject,
): JsonObject {
  if (!saved)
    throw new GatewayError(
      404,
      "previous_response_not_found",
      "No live session or retained Response exists for this account (30-day retention)",
    );
  const context = completedContext(saved);
  const input = originalInput(payload["input"]);
  if (!context || !input)
    throw new GatewayError(
      409,
      "response_context_incomplete",
      "The retained Response does not contain a complete replayable context",
    );
  const projected = context.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw incompatible();
    const item = value as Record<string, unknown>;
    if (
      item["type"] === "item_reference" ||
      (item["status"] !== undefined && item["status"] !== "completed") ||
      (["reasoning", "compaction"].includes(String(item["type"])) &&
        (typeof item["encrypted_content"] !== "string" || !item["encrypted_content"]))
    )
      throw incompatible();
    try {
      const result = toResponseInputItem(item as unknown as ResponseInputItemLike);
      if (!result) throw incompatible();
      return result;
    } catch {
      throw incompatible();
    }
  });
  const { previous_response_id: _previous, ...current } = payload;
  return { ...current, input: [...projected, ...input] };
}

function incompatible(): GatewayError {
  return new GatewayError(
    409,
    "response_context_not_replayable",
    "A retained context item is unfinished, opaque without reusable content, or incompatible with the installed SDK projection",
  );
}
