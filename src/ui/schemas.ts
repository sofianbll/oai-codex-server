import { z } from "zod";

export const jsonObject = z.record(z.string(), z.json());
export const statusSchema = z.object({
  version: z.string(),
  startedAt: z.string(),
  uptimeSeconds: z.number(),
  requests: z.object({ total: z.number(), active: z.number(), failed: z.number() }),
  auth: z.object({
    mode: z.literal("chatgpt"),
    available: z.boolean(),
    expiresAt: z.string().nullable(),
  }),
  upstream: z.object({
    origin: z.string(),
    mode: z.enum(["minimal", "raw"]),
    defaultModel: z.string(),
  }),
  network: z.object({ bind: z.string(), port: z.number(), addresses: z.array(z.string()) }),
});
export const operationsSchema = z.object({
  operations: z.array(
    z.object({
      id: z.string(),
      method: z.string(),
      path: z.string(),
      summary: z.string(),
      description: z.string(),
      category: z.string(),
      availability: z.enum(["verified", "source-backed", "unverified"]),
      supported: z.boolean(),
      requestBodyExample: jsonObject.optional(),
      queryParameters: z.array(z.string()).optional(),
      pathParameters: z.array(z.string()).optional(),
    }),
  ),
});
export const activitySchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      method: z.string(),
      path: z.string(),
      status: z.number(),
      startedAt: z.string(),
      durationMs: z.number(),
      bytes: z.number(),
      state: z.enum(["active", "completed", "aborted", "failed"]),
    }),
  ),
});
export const configSchema = z.object({
  server: z.object({ host: z.string(), port: z.number().int().min(0).max(65535) }),
  proxy: z.object({
    translationMode: z.enum(["minimal", "raw"]),
    defaultModel: z.string(),
    timeoutMs: z.number().positive(),
    maxBodyBytes: z.number().positive(),
    baseUrl: z.string(),
    clientVersion: z.string(),
  }),
  dashboard: z.object({ enabled: z.boolean() }),
  docs: z.object({ enabled: z.boolean() }),
});
export const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
export const savedConfigSchema = z.object({
  saved: z.literal(true),
  restartRequired: z.boolean(),
  config: configSchema,
});
export const eventSchema = z
  .object({
    type: z.string().optional(),
    delta: z.json().optional(),
    response: z.json().optional(),
  })
  .passthrough();
export type JsonObject = z.infer<typeof jsonObject>;
export type PublicConfig = z.infer<typeof configSchema>;
