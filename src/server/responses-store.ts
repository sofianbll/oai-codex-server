import { z } from "zod";

type JsonObject = Readonly<Record<string, unknown>>;

export type ResponsesRelay = (request: Request) => Promise<Response>;

export type ResponsesStoreOptions = {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxResponseBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
};

export type ResponsesLifecycle = ((request: Request) => Promise<Response>) & {
  clear(): void;
  size(): number;
};

type StoredResponse = {
  readonly response: JsonObject;
  readonly input: readonly unknown[];
  readonly bytes: number;
  readonly createdAt: number;
};

const objectSchema = z.record(z.string(), z.unknown());
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_BODY_BYTES = 8 * 1024 * 1024;

export function createResponsesLifecycle(
  relay: ResponsesRelay,
  options: ResponsesStoreOptions = {},
): ResponsesLifecycle {
  const maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxRecordBytes = Math.min(
    positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES),
    maxBytes,
  );
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
  const maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_BODY_BYTES);
  const now = options.now ?? Date.now;
  const records = new Map<string, StoredResponse>();
  let bytes = 0;

  const remove = (id: string): boolean => {
    const previous = records.get(id);
    if (!previous) return false;
    records.delete(id);
    bytes -= previous.bytes;
    return true;
  };

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [id, record] of records) {
      if (record.createdAt <= cutoff) remove(id);
    }
  };

  const save = (response: JsonObject, input: readonly unknown[]): boolean => {
    const id = response["id"];
    if (typeof id !== "string" || id.length === 0) return false;
    const serialized = JSON.stringify({ response, input });
    const recordBytes = new TextEncoder().encode(serialized).byteLength;
    if (recordBytes > maxRecordBytes) return false;
    prune();
    remove(id);
    while (records.size >= maxRecords || bytes + recordBytes > maxBytes) {
      const oldest = records.keys().next();
      if (oldest.done) return false;
      remove(oldest.value);
    }
    records.set(id, { response, input, bytes: recordBytes, createdAt: now() });
    bytes += recordBytes;
    return true;
  };

  const retrieve = (id: string): StoredResponse | undefined => {
    prune();
    return records.get(id);
  };

  const handle: ResponsesLifecycle = Object.assign(
    async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = decodedPath(url);
      if (!path) return jsonError(400, "invalid_request", "Malformed URL path");

      if (request.method === "POST" && path === "/v1/responses") {
        const parsed = await readRequestBody(request);
        if (parsed instanceof Response) return parsed;
        const store = parsed["store"] === true;
        if (!store) return relay(request);
        if (parsed["background"] === true)
          return jsonError(
            501,
            "background_not_supported_locally",
            "Local Responses storage does not implement background jobs",
          );

        const input = inputItems(parsed["input"]);
        const body = JSON.stringify({ ...parsed, store: false });
        const upstreamRequest = new Request(request, { body });
        const upstream = await relay(upstreamRequest);
        if (!upstream.ok) return upstream;
        const upstreamHeaders = new Headers(upstream.headers);
        const contentType = upstreamHeaders
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (contentType === "text/event-stream") {
          upstreamHeaders.delete("content-length");
          if (!upstream.body)
            return jsonError(502, "response_not_stored", "Upstream returned an empty event stream");
          const tapped = tapEventStream(upstream.body, input, save, maxResponseBytes);
          return new Response(tapped, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstreamHeaders,
          });
        }

        const captured = await captureResponse(upstream, maxResponseBytes);
        if (captured instanceof Response) return captured;
        const responseObject = finalResponse(captured.body, captured.contentType);
        const storedObject = responseObject ? { ...responseObject, store: true } : undefined;
        if (!storedObject || !save(storedObject, input))
          return jsonError(
            502,
            "response_not_stored",
            "Upstream completed without a storable response object",
          );
        const responseBody = new TextEncoder().encode(JSON.stringify(storedObject)).buffer;
        captured.headers.delete("content-length");
        return new Response(responseBody, {
          status: captured.status,
          statusText: captured.statusText,
          headers: captured.headers,
        });
      }

      const match = path.match(/^\/v1\/responses\/([^/]+)(?:\/input_items)?$/);
      if (!match) return relay(request);
      const suffix = path.endsWith("/input_items");
      const id = match[1];
      if (!id) return jsonError(400, "invalid_request", "Response ID is required");

      if (request.method === "GET" && !suffix) {
        const saved = retrieve(id);
        return saved
          ? Response.json(saved.response)
          : jsonError(404, "not_found", `Response '${id}' was not found`);
      }
      if (request.method === "DELETE" && !suffix) {
        const deleted = remove(id);
        return deleted
          ? Response.json({ id, object: "response.deleted", deleted: true })
          : jsonError(404, "not_found", `Response '${id}' was not found`);
      }
      if (request.method === "GET" && suffix) {
        const saved = retrieve(id);
        return saved
          ? inputItemsPage(saved.input, url)
          : jsonError(404, "not_found", `Response '${id}' was not found`);
      }
      return relay(request);
    },
    {
      clear() {
        records.clear();
        bytes = 0;
      },
      size() {
        prune();
        return records.size;
      },
    },
  );

  return handle;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function decodedPath(url: URL): string | undefined {
  try {
    return decodeURIComponent(url.pathname);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

async function readRequestBody(request: Request): Promise<JsonObject | Response> {
  let value: unknown;
  try {
    value = await request.clone().json();
  } catch {
    return jsonError(400, "invalid_json", "Responses requires a JSON object");
  }
  const parsed = objectSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : jsonError(400, "invalid_request", "Responses requires a JSON object");
}

function inputItems(input: unknown): readonly unknown[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: input }],
          },
        ]
      : [];
  return values.map((value) => {
    const parsed = objectSchema.safeParse(value);
    if (!parsed.success || typeof parsed.data["id"] === "string") return value;
    return { ...parsed.data, id: `in_${crypto.randomUUID()}` };
  });
}

type CapturedResponse = {
  readonly body: ArrayBuffer;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly contentType: string;
};

async function captureResponse(
  response: Response,
  maxResponseBytes: number,
): Promise<CapturedResponse | Response> {
  const headers = new Headers(response.headers);
  const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      body: new ArrayBuffer(0),
      status: response.status,
      statusText: response.statusText,
      headers,
      contentType,
    };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        return jsonError(502, "stored_response_too_large", "Response exceeded local storage limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  headers.delete("content-length");
  return {
    body: joined.buffer,
    status: response.status,
    statusText: response.statusText,
    headers,
    contentType,
  };
}

function finalResponse(body: ArrayBuffer, contentType: string): JsonObject | undefined {
  const text = new TextDecoder().decode(body);
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    try {
      const parsed = objectSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function tapEventStream(
  body: ReadableStream<Uint8Array>,
  input: readonly unknown[],
  save: (response: JsonObject, input: readonly unknown[]) => boolean,
  maxFrameBytes: number,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let savedTerminal = false;
  const frameBoundary = /\r?\n\r?\n/;
  const terminalTypes = new Set(["response.completed", "response.incomplete", "response.failed"]);

  const rewriteFrame = (frame: string): string => {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return frame;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return frame;
    }
    const parsed = z
      .looseObject({ type: z.string(), response: objectSchema.optional() })
      .safeParse(value);
    if (!parsed.success || !terminalTypes.has(parsed.data.type)) return frame;
    if (!parsed.data.response || typeof parsed.data.response["id"] !== "string")
      throw new Error("Upstream terminal event did not contain a storable response");
    const stored = { ...parsed.data.response, store: true };
    if (!save(stored, input)) throw new Error("Local Responses store capacity was exceeded");
    savedTerminal = true;
    const retained = lines.filter((line) => !line.startsWith("data:"));
    retained.push(`data: ${JSON.stringify({ ...parsed.data, response: stored })}`);
    return retained.join("\n");
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let match = frameBoundary.exec(pending);
        while (match?.index !== undefined) {
          const delimiter = match[0];
          const frame = pending.slice(0, match.index);
          pending = pending.slice(match.index + delimiter.length);
          controller.enqueue(encoder.encode(`${rewriteFrame(frame)}${delimiter}`));
          match = frameBoundary.exec(pending);
        }
        if (encoder.encode(pending).byteLength > maxFrameBytes)
          throw new Error("SSE event exceeded local Responses storage limit");
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.length > 0) controller.enqueue(encoder.encode(rewriteFrame(pending)));
        if (!savedTerminal) throw new Error("Upstream stream ended without a storable response");
      },
    }),
  );
}

function inputItemsPage(input: readonly unknown[], url: URL): Response {
  const order = url.searchParams.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc")
    return jsonError(400, "invalid_request", "order must be 'asc' or 'desc'");
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return jsonError(400, "invalid_request", "limit must be between 1 and 100");

  const ordered = order === "asc" ? [...input] : [...input].reverse();
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  if (before && after)
    return jsonError(400, "invalid_request", "Use either before or after, not both");
  let start = 0;
  let end = ordered.length;
  if (before) {
    const index = ordered.findIndex((item) => itemId(item) === before);
    if (index < 0) return jsonError(400, "invalid_cursor", "before cursor was not found");
    end = index;
  }
  if (after) {
    const index = ordered.findIndex((item) => itemId(item) === after);
    if (index < 0) return jsonError(400, "invalid_cursor", "after cursor was not found");
    start = index + 1;
  }
  const page = ordered.slice(start, Math.min(end, start + limit));
  const dataIds = page.map(itemId).filter((id): id is string => id !== undefined);
  return Response.json({
    object: "list",
    data: page,
    has_more: start + page.length < end,
    first_id: dataIds[0] ?? null,
    last_id: dataIds.at(-1) ?? null,
  });
}

function itemId(item: unknown): string | undefined {
  const parsed = objectSchema.safeParse(item);
  const id = parsed.success ? parsed.data["id"] : undefined;
  return typeof id === "string" ? id : undefined;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { type: "invalid_request_error", code, message } }, { status });
}
