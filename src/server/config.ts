import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { GatewayError } from "../shared/contracts";

const schema = z.strictObject({
  server: z
    .strictObject({
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(8787),
    })
    .prefault({}),
  proxy: z
    .strictObject({
      baseUrl: z
        .literal("https://chatgpt.com/backend-api/codex")
        .default("https://chatgpt.com/backend-api/codex"),
      timeoutMs: z.number().int().min(1000).max(900000).default(120000),
      maxBodyBytes: z.number().int().min(1024).max(67108864).default(16777216),
      defaultModel: z.string().min(1).default("gpt-6-astra"),
      clientVersion: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .default("0.162.1"),
      translationMode: z.enum(["minimal", "raw"]).default("minimal"),
    })
    .prefault({}),
  auth: z
    .strictObject({
      codexHome: z
        .string()
        .min(1)
        .default(process.env["CODEX_HOME"] || resolve(homedir(), ".codex")),
      tokenFile: z.string().min(1).default(".local/server-token"),
    })
    .prefault({}),
  limits: z
    .strictObject({
      maxConcurrent: z.number().int().min(1).max(256).default(16),
      activityEntries: z.number().int().min(1).max(1000).default(100),
    })
    .prefault({}),
  dashboard: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
  docs: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
});

export type AppConfig = z.infer<typeof schema>;

export function parseConfig(value: unknown): AppConfig {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
      .join("; ");
    throw new GatewayError(400, "invalid_config", `Configuration invalide (${fields}).`);
  }
  return parsed.data;
}

export function publicConfig(config: AppConfig) {
  return {
    server: config.server,
    proxy: config.proxy,
    dashboard: config.dashboard,
    docs: config.docs,
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  try {
    const input: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseConfig(input);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      400,
      "config_unreadable",
      "Configuration introuvable ou JSON invalide. Utilisez oai-codex init.",
    );
  }
}

export async function saveConfig(path: string, config: AppConfig): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function resolveHost(host: string): string {
  if (host !== "tailscale") return host;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const [first, second] = address.address.split(".").map(Number);
      if (
        address.family === "IPv4" &&
        first === 100 &&
        second !== undefined &&
        second >= 64 &&
        second <= 127
      )
        return address.address;
    }
  }
  throw new GatewayError(
    503,
    "tailscale_unavailable",
    "Aucune adresse Tailscale active. Connectez Tailscale ou utilisez --host 127.0.0.1.",
  );
}
