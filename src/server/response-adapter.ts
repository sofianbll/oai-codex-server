import { APIError } from "openai";
import { Stream } from "openai/core/streaming";
import { z } from "zod";
import { GatewayError, type ProxyOptions } from "../shared/contracts";
import type { Exchange } from "./upstream-stream";

const requestSchema = z.looseObject({
  model: z.unknown().optional(),
  instructions: z.unknown().optional(),
  input: z.unknown().optional(),
  store: z.boolean().optional(),
  stream: z.boolean().optional(),
  prompt_cache_key: z.unknown().optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
});
const eventSchema = z.looseObject({
  type: z.string(),
  response: z.record(z.string(), z.unknown()).optional(),
  output_index: z.number().int().nonnegative().optional(),
  item: z.record(z.string(), z.unknown()).optional(),
});
const modelsSchema = z.looseObject({ models: z.array(z.looseObject({ slug: z.string() })) });

export function adaptRequest(body: ArrayBuffer, options: ProxyOptions) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new GatewayError(400, "invalid_json", "Responses requires a JSON object");
    throw error;
  }
  const result = requestSchema.safeParse(parsed);
  if (!result.success)
    throw new GatewayError(
      400,
      "invalid_request",
      "Responses requires a JSON object with boolean stream and store fields",
    );
  const data = result.data;
  if (data.store === true)
    throw new GatewayError(
      400,
      "store_not_supported",
      "Codex does not support store:true; use store:false",
    );
  return {
    streaming: data.stream === true,
    sessionId: promptCacheSessionId(data.prompt_cache_key),
    body: JSON.stringify({
      ...normalizeToolFields(data),
      model: data.model === undefined ? options.defaultModel : data.model,
      instructions: data.instructions === undefined ? "" : data.instructions,
      store: data.store === undefined ? false : data.store,
      input:
        typeof data.input === "string"
          ? [{ role: "user", content: [{ type: "input_text", text: data.input }] }]
          : data.input,
      stream: true,
    }),
  };
}

function normalizeToolFields(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    ...(Array.isArray(data["tools"]) ? { tools: data["tools"].map(normalizeToolValue) } : {}),
    ...(data["tool_choice"] === undefined
      ? {}
      : { tool_choice: normalizeToolValue(data["tool_choice"]) }),
  };
}

function normalizeToolValue(value: unknown): unknown {
  if (typeof value === "string") return value === "web_search_preview" ? "web_search" : value;
  if (Array.isArray(value)) return value.map(normalizeToolValue);
  if (typeof value !== "object" || value === null) return value;

  const tool = value as Record<string, unknown> & {
    type?: unknown;
    allowed_tools?: unknown;
    tools?: unknown;
  };
  return {
    ...tool,
    ...(tool.type === "web_search_preview" ? { type: "web_search" } : {}),
    ...(Array.isArray(tool.allowed_tools)
      ? { allowed_tools: tool.allowed_tools.map(normalizeToolValue) }
      : {}),
    ...(Array.isArray(tool.tools) ? { tools: tool.tools.map(normalizeToolValue) } : {}),
  };
}

function promptCacheSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return undefined;
  return /^[\x20-\x7e]+$/.test(value) ? value : undefined;
}

export async function completedResponse(response: Response, exchange: Exchange): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  try {
    const completedItems = new Map<number, Readonly<Record<string, unknown>>>();
    const stream = Stream.fromSSEResponse<unknown>(response, exchange.controller);
    for await (const value of stream) {
      const event = eventSchema.safeParse(value);
      if (!event.success) continue;
      if (
        event.data.type === "response.output_item.done" &&
        event.data.output_index !== undefined &&
        event.data.item
      ) {
        completedItems.set(event.data.output_index, event.data.item);
      }
      if (
        ["response.completed", "response.failed", "response.incomplete"].includes(
          event.data.type,
        ) &&
        event.data.response
      ) {
        const output = event.data.response["output"];
        const fillOutput =
          completedItems.size > 0 &&
          (output === undefined || (Array.isArray(output) && output.length === 0));
        const finalResponse = fillOutput
          ? {
              ...event.data.response,
              output: [...completedItems]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
            }
          : event.data.response;
        return Response.json(finalResponse, { status: response.status, headers });
      }
    }
    exchange.controller.signal.throwIfAborted();
    throw new GatewayError(
      502,
      "incomplete_upstream_response",
      "Upstream stream ended without a final response",
    );
  } catch (error) {
    if (error instanceof APIError)
      return Response.json({ error: error.error }, { status: 502, headers });
    if (error instanceof SyntaxError)
      throw new GatewayError(
        502,
        "invalid_upstream_stream",
        "Upstream returned malformed event JSON",
      );
    throw error;
  } finally {
    exchange.close();
  }
}

export async function modelList(response: Response): Promise<Response> {
  const bytes = await response.arrayBuffer();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) return new Response(bytes, response);
    throw error;
  }
  const parsed = modelsSchema.safeParse(value);
  if (!parsed.success) return new Response(bytes, response);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return Response.json(
    {
      ...parsed.data,
      object: "list",
      data: parsed.data.models.map((model) => ({
        ...model,
        id: model.slug,
        object: "model",
        created: 0,
        owned_by: "openai",
      })),
    },
    { status: response.status, headers },
  );
}
