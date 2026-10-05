import ky from "ky";
import { Stream } from "openai/core/streaming";
import { z } from "zod";
import type { ActivityEntry, Operation, PublicStatus } from "../shared/contracts";
import type { JsonObject, PublicConfig } from "./schemas";
import {
  activitySchema,
  configSchema,
  eventSchema,
  modelsSchema,
  operationsSchema,
  savedConfigSchema,
  statusSchema,
} from "./schemas";

const tokenKey = "oai-codex-token";
export const getToken = (): string => sessionStorage.getItem(tokenKey) ?? "";
export const setToken = (token: string): void => {
  sessionStorage.setItem(tokenKey, token);
};
export const clearToken = (): void => {
  sessionStorage.removeItem(tokenKey);
};

const client = ky.create({ retry: 0, timeout: 15_000, throwHttpErrors: false });
const headers = (): HeadersInit => ({ Authorization: `Bearer ${getToken()}` });

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

async function json(path: string): Promise<unknown> {
  const response = await client(path, { headers: headers() });
  if (!response.ok)
    throw new RequestError(response.status, `HTTP ${response.status} · ${await response.text()}`);
  return response.json();
}

export async function getStatus(): Promise<PublicStatus> {
  return statusSchema.parse(await json("/api/status"));
}
export async function getOperations(): Promise<readonly Operation[]> {
  return operationsSchema.parse(await json("/api/capabilities")).operations.map((operation) => {
    const { requestBodyExample, queryParameters, pathParameters, ...base } = operation;
    return {
      ...base,
      ...(requestBodyExample ? { requestBodyExample } : {}),
      ...(queryParameters ? { queryParameters } : {}),
      ...(pathParameters ? { pathParameters } : {}),
    };
  });
}
export async function getActivity(): Promise<readonly ActivityEntry[]> {
  return activitySchema.parse(await json("/api/activity")).entries;
}
export async function getConfig(): Promise<PublicConfig> {
  return configSchema.parse(await json("/api/config"));
}
export async function getModels(): Promise<readonly string[]> {
  return modelsSchema.parse(await json("/v1/models")).data.map((model) => model.id);
}
export async function saveConfig(config: PublicConfig): Promise<z.infer<typeof savedConfigSchema>> {
  const response = await client.put("/api/config", { headers: headers(), json: config });
  if (!response.ok)
    throw new RequestError(response.status, `HTTP ${response.status} · ${await response.text()}`);
  return savedConfigSchema.parse(await response.json());
}

export type ApiRequest = {
  readonly method: string;
  readonly path: string;
  readonly body?: JsonObject | FormData | string;
  readonly contentType?: string;
};
export type ApiResult = {
  readonly status: number;
  readonly durationMs: number;
  readonly data: string;
  readonly streamed: boolean;
  readonly binary?: Blob;
};
export type StreamEvent = z.infer<typeof eventSchema>;

export async function execute(
  request: ApiRequest,
  controller: AbortController,
  onEvent: (event: StreamEvent) => void,
): Promise<ApiResult> {
  const url = new URL(request.path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/v1/")) {
    throw new RequestError(0, "Utilisez un chemin /v1/ de ce serveur.");
  }
  const started = performance.now();
  const requestHeaders = new Headers(headers());
  if (request.contentType) requestHeaders.set("Content-Type", request.contentType);
  const bodyOptions =
    request.body instanceof FormData || typeof request.body === "string"
      ? { body: request.body }
      : request.body
        ? { json: request.body }
        : {};
  const response = await client(url, {
    method: request.method,
    headers: requestHeaders,
    signal: controller.signal,
    timeout: false,
    ...bodyOptions,
  });
  if (!response.ok)
    throw new RequestError(response.status, `HTTP ${response.status} · ${await response.text()}`);
  const contentType = response.headers.get("content-type") ?? "";
  const streamed = contentType.includes("text/event-stream");
  if (
    contentType &&
    !contentType.includes("json") &&
    !contentType.startsWith("text/") &&
    !contentType.includes("xml")
  ) {
    const binary = await response.blob();
    return {
      status: response.status,
      durationMs: performance.now() - started,
      data: `${contentType} · ${binary.size} octets`,
      streamed: false,
      binary,
    };
  }
  let data = "";
  if (streamed) {
    for await (const value of Stream.fromSSEResponse<unknown>(response, controller)) {
      const event = eventSchema.parse(value);
      onEvent(event);
      data = JSON.stringify(event.response ?? event, null, 2);
    }
  } else {
    const body = await response.text();
    data =
      contentType.includes("json") && body.length
        ? JSON.stringify(z.json().parse(tryJson(body)), null, 2)
        : body;
  }
  return { status: response.status, durationMs: performance.now() - started, data, streamed };
}

function tryJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return value;
    throw error;
  }
}

export function curlCommand(request: ApiRequest): string {
  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  const lines = [
    `curl -N -X ${request.method} ${quote(new URL(request.path, window.location.origin).href)}`,
    '  -H "Authorization: Bearer $OAI_CODEX_TOKEN"',
  ];
  if (request.body instanceof FormData) {
    for (const [key, value] of request.body.entries())
      lines.push(`  -F ${quote(`${key}=${typeof value === "string" ? value : `@${value.name}`}`)}`);
  } else if (typeof request.body === "string") {
    lines.push(
      `  -H ${quote(`Content-Type: ${request.contentType ?? "text/plain"}`)}`,
      `  --data-binary ${quote(request.body)}`,
    );
  } else if (request.body)
    lines.push(
      "  -H 'Content-Type: application/json'",
      `  --data ${quote(JSON.stringify(request.body))}`,
    );
  return lines.join(" \\\n");
}
