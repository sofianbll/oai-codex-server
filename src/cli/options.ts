import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { loadServerToken } from "../server/access";
import { type AppConfig, loadConfig, parseConfig, resolveHost } from "../server/config";
import { GatewayError } from "../shared/contracts";

const optionsSchema = z.object({
  config: z.string().min(1).default("oai-codex.config.json"),
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(0).max(65535).optional(),
  model: z.string().min(1).optional(),
  mode: z.enum(["minimal", "raw"]).optional(),
  timeout: z.coerce.number().int().min(1000).max(900000).optional(),
  dashboard: z.boolean().optional(),
  docs: z.boolean().optional(),
  force: z.boolean().optional(),
});
export type CliOptions = z.infer<typeof optionsSchema>;
export type Selection = { readonly config: AppConfig; readonly configPath: string };

export function readOptions(command: Command): CliOptions {
  const parsed = optionsSchema.safeParse(command.optsWithGlobals<Record<string, unknown>>());
  if (!parsed.success)
    throw new GatewayError(400, "invalid_options", "Options invalides. Consultez --help.");
  return parsed.data;
}

function applyOptions(config: AppConfig, options: CliOptions): AppConfig {
  return parseConfig({
    ...config,
    server: { host: options.host ?? config.server.host, port: options.port ?? config.server.port },
    proxy: {
      ...config.proxy,
      defaultModel: options.model ?? config.proxy.defaultModel,
      translationMode: options.mode ?? config.proxy.translationMode,
      timeoutMs: options.timeout ?? config.proxy.timeoutMs,
    },
    dashboard: { enabled: options.dashboard ?? config.dashboard.enabled },
    docs: { enabled: options.docs ?? config.docs.enabled },
  });
}

export async function selectConfig(options: CliOptions): Promise<Selection> {
  const configPath = resolve(options.config);
  const config = applyOptions(await loadConfig(configPath), options);
  return {
    configPath,
    config: {
      ...config,
      auth: {
        tokenFile: resolve(dirname(configPath), config.auth.tokenFile),
        codexHome: resolve(dirname(configPath), config.auth.codexHome),
      },
    },
  };
}

export async function initialize(options: CliOptions): Promise<void> {
  const path = resolve(options.config);
  const config = applyOptions(parseConfig({}), options);
  resolveHost(config.server.host);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
      flag: options.force ? "w" : "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new GatewayError(
        409,
        "config_exists",
        "Une configuration existe déjà. Utilisez --force pour la remplacer.",
      );
    }
    throw error;
  }
  await loadServerToken(resolve(dirname(path), config.auth.tokenFile), true);
  console.log(
    `Configuration créée : ${path}\nClé privée créée. Affichage explicite : oai-codex token`,
  );
}

export function forwardedOptions(options: CliOptions): string[] {
  const args: string[] = [];
  for (const name of ["host", "port", "model", "mode", "timeout"] as const) {
    const value = options[name];
    if (value !== undefined) args.push(`--${name}`, String(value));
  }
  if (options.dashboard !== undefined)
    args.push(options.dashboard ? "--dashboard" : "--no-dashboard");
  if (options.docs !== undefined) args.push(options.docs ? "--docs" : "--no-docs");
  return args;
}
