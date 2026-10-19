import { z } from "zod";
import { GatewayError } from "../shared/contracts";
import { publicApi } from "./catalog";

type Schema = Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>;
type Item = Record<string, unknown> & { id: string };
const source = publicApi.components["schemas"] as Record<string, Schema>;
const definitions: Record<string, Schema> = {};

// Local adapter for the pinned OpenAPI graph, not a client-supplied schema compiler.
function definition(name: string): Schema {
  if (Object.hasOwn(definitions, name)) return definitions[name] as Schema;
  definitions[name] = {};
  const schema = adapt(source[name]) as Schema;
  // SDK 7.20.0: these two required entries have no property, and logprobs is optional.
  const omit =
    name === "LocalShellToolCallOutput"
      ? "call_id"
      : name === "MCPApprovalResponseResource"
        ? "request_id"
        : name === "OutputTextContent"
          ? "logprobs"
          : undefined;
  if (omit && schema.required) schema.required = schema.required.filter((key) => key !== omit);
  // SDK declares these payloads unknown, not object-only schemas to compile/interpret.
  if (name === "MCPListToolsTool")
    schema.properties = { ...schema.properties, input_schema: {}, annotations: {} };
  // The pinned allOf accidentally intersects disjoint status enums; SDK returns all four.
  if (name === "ComputerCallOutputStatus")
    schema.enum = ["in_progress", "completed", "incomplete", "failed"];
  if (name === "ComputerToolCallOutput")
    schema.properties = {
      ...schema.properties,
      status: { $ref: "#/$defs/ComputerCallOutputStatus" },
    };
  // ConversationItem uses the base custom types; Responses also returns provenance/status.
  if (name === "CustomToolCall" || name === "CustomToolCallOutput") {
    schema.properties = {
      ...schema.properties,
      status: { $ref: "#/$defs/FunctionCallStatus" },
      created_by: { type: "string" },
    };
    definition("FunctionCallStatus");
  }
  if (name === "Program" || name === "ProgramOutput")
    schema.properties = {
      ...schema.properties,
      call_id: { type: "string", minLength: 1, maxLength: 64 },
    };
  definitions[name] = schema;
  return schema;
}

function adapt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adapt);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "default")
      .map(([key, entry]) => {
        if (key !== "$ref") return [key, adapt(entry)];
        if (typeof entry !== "string" || !entry.startsWith("#/components/schemas/"))
          throw new Error("Conversation contract requires a pinned local schema reference");
        const name = entry.slice("#/components/schemas/".length);
        definition(name);
        return [key, `#/$defs/${name}`];
      }),
  );
}

function validator(name: string) {
  definition(name);
  return z.fromJSONSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `#/$defs/${name}`,
    $defs: definitions,
  });
}
const history = validator("ConversationItem");
const inputContent = validator("InputMessageContentList");
const outputContent = validator("OutputMessageContent");
function shorthandPart(part: unknown, assistant: boolean): unknown {
  if (typeof part !== "object" || part === null || Array.isArray(part)) return part;
  const content = part as Record<string, unknown>;
  if (content["type"] === "input_image" && !Object.hasOwn(content, "detail"))
    return { ...content, detail: "auto" };
  if (assistant && content["type"] === "output_text" && !Object.hasOwn(content, "annotations"))
    return { ...content, annotations: [] };
  return part;
}
const shorthand = z
  .strictObject({
    type: z.literal("message").optional(),
    id: z.string().min(1).nullable().optional(),
    role: z.enum(["user", "assistant", "system", "developer"]),
    content: z.union([z.string(), z.array(z.unknown())]),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
  })
  .refine((item) => {
    if (item.role !== "assistant" && item.phase !== undefined) return false;
    if (typeof item.content === "string") return true;
    const parts = item.content.map((part) => shorthandPart(part, item.role === "assistant"));
    return parts.every(
      (part) =>
        inputContent.safeParse([part]).success ||
        (item.role === "assistant" && outputContent.safeParse(part).success),
    );
  });

// JSON.parse accepts 1e999 as Infinity. Visit *all* own values, including opaque __proto__.
function finiteJson(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry === "number" && !Number.isFinite(entry)) return false;
    if (typeof entry === "object" && entry !== null)
      for (const child of Object.values(entry)) pending.push(child);
  }
  return true;
}

// Zod object catchalls skip __proto__. Check the three typed dictionaries on raw own values.
function ownDictionaries(item: Record<string, unknown>): boolean {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const strings = (value: unknown) =>
    !object(value) || Object.values(value).every((v) => typeof v === "string");
  const tools = (value: unknown): boolean =>
    !Array.isArray(value) ||
    value.every(
      (tool: unknown) =>
        !object(tool) ||
        (tool["type"] === "namespace"
          ? tools(tool["tools"])
          : tool["type"] !== "mcp" || strings(tool["headers"])),
    );
  if (
    item["type"] === "local_shell_call" &&
    object(item["action"]) &&
    !strings(item["action"]["env"])
  )
    return false;
  if (
    (item["type"] === "tool_search_output" || item["type"] === "additional_tools") &&
    !tools(item["tools"])
  )
    return false;
  if (item["type"] === "file_search_call" && Array.isArray(item["results"]))
    for (const result of item["results"]) {
      if (!object(result) || !object(result["attributes"])) continue;
      const attributes = result["attributes"];
      if (
        Object.keys(attributes).length > 16 ||
        Object.entries(attributes).some(
          ([key, value]) =>
            key.length > 64 ||
            !(
              typeof value === "boolean" ||
              typeof value === "number" ||
              (typeof value === "string" && value.length <= 512)
            ),
        )
      )
        return false;
    }
  return true;
}

export const conversationItemSchema = z.custom<Record<string, unknown>>((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !finiteJson(value))
    return false;
  const item = value as Record<string, unknown>;
  if (
    item["type"] === "compaction_trigger" ||
    item["type"] === "item_reference" ||
    ((item["type"] === undefined || item["type"] === null) &&
      Object.hasOwn(item, "id") &&
      !Object.hasOwn(item, "role"))
  )
    throw new GatewayError(
      501,
      "conversation_control_not_materializable",
      "Inert history cannot materialize compaction_trigger or item_reference; no execution or reference lookup is performed",
    );
  // Only messages may omit id (one is generated at persistence); other families keep their
  // own identity. Dot segments are refused: SDK/HTTP item paths can never address them.
  const isMessage = item["type"] === undefined || item["type"] === "message";
  if (typeof item["id"] !== "string" || !item["id"].length) {
    if (item["id"] !== undefined && item["id"] !== null) return false;
    if (!isMessage) return false;
  } else if (item["id"] === "." || item["id"] === "..") return false;
  const publicItem = presentConversationItem({ id: "item_validation", original: item });
  return (
    ownDictionaries(item) &&
    history.safeParse(publicItem).success &&
    (isMessage && !(typeof item["id"] === "string" && Object.hasOwn(item, "status"))
      ? shorthand.safeParse(item).success
      : true)
  );
});

// New envelopes retain the original once; legacy records already contain the public item.
export function presentConversationItem(record: Item): Item {
  if (record["type"] !== undefined) return record;
  const original = record["original"] as Record<string, unknown>;
  const item: Item = { ...original, id: record.id };
  if (item["type"] === undefined || item["type"] === "message") {
    item["type"] = "message";
    if (item["status"] === undefined) item["status"] = "completed";
    if (typeof item["content"] === "string")
      item["content"] = [
        {
          type: item["role"] === "assistant" ? "output_text" : "input_text",
          text: item["content"],
          ...(item["role"] === "assistant" ? { annotations: [] } : {}),
        },
      ];
    else if (
      Array.isArray(item["content"]) &&
      !(typeof original["id"] === "string" && Object.hasOwn(original, "status"))
    )
      item["content"] = item["content"].map((part) =>
        shorthandPart(part, item["role"] === "assistant"),
      );
  }
  return item;
}
