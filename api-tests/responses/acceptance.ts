import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

const optionsSchema = z.object({
  baseUrl: z.url(),
  keyFile: z.string().min(1).optional(),
  model: z.string().min(1),
  outputDir: z
    .string()
    .min(1)
    .default(new URL("./results/", import.meta.url).pathname),
});

export type AcceptanceOptions = Readonly<z.infer<typeof optionsSchema> & { readonly key: string }>;

export async function optionsFromArgs(args: readonly string[]): Promise<AcceptanceOptions> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new TypeError("Expected --name value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase())] =
      value;
  }
  const parsed = optionsSchema.parse(values);
  const { OPENAI_API_KEY: environmentKey } = process.env;
  const key = (
    parsed.keyFile ? await readFile(parsed.keyFile, "utf8") : (environmentKey ?? "")
  ).trim();
  if (!key) throw new TypeError("Define OPENAI_API_KEY or --key-file");
  return { ...parsed, key };
}

export function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.replaceAll(secret, "[REDACTED]") : result),
    value,
  );
}

export async function writeReport(
  options: AcceptanceOptions,
  scenario: string,
  report: Record<string, unknown>,
): Promise<string> {
  await mkdir(options.outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z");
  const path = join(options.outputDir, `${basename(scenario)}-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

export function wsEndpoint(baseUrl: string): string {
  const url = new URL("responses", `${baseUrl.replace(/\/$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
