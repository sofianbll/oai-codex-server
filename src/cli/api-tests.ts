import { resolve } from "node:path";
import { cancel, intro, isCancel, select } from "@clack/prompts";
import type { Command } from "commander";
import { z } from "zod";
import { resolveHost } from "../server/config";
import { GatewayError } from "../shared/contracts";
import { readOptions, selectConfig } from "./options";
import { responsesScenarioIds, responsesScenarios } from "./responses-scenarios";

const root = resolve(import.meta.dir, "../..");
const testOptions = z.object({
  baseUrl: z.url().optional(),
  scenario: z
    .string()
    .refine((value) => responsesScenarioIds.includes(value), "Unknown Responses scenario")
    .optional(),
  keyFile: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
});

export async function runApiTest(endpoint: string | undefined, command: Command): Promise<void> {
  if (endpoint !== undefined && endpoint !== "models" && endpoint !== "responses") {
    throw new GatewayError(
      400,
      "unknown_test",
      "Test indisponible. Tests disponibles : models, responses.",
    );
  }
  const parsed = testOptions.safeParse(command.opts());
  if (!parsed.success) {
    throw new GatewayError(
      400,
      "invalid_test_options",
      "Scénario Responses invalide. Consultez oai-codex test responses --help.",
    );
  }
  let selectedScenario = parsed.data.scenario ?? "create-text";
  let selectedEndpoint = endpoint;
  if (selectedEndpoint === undefined) {
    if (!process.stdin.isTTY) {
      throw new GatewayError(
        400,
        "terminal_required",
        "Utilisez oai-codex test models sans terminal interactif.",
      );
    }
    intro("Banc de compatibilité OpenAI");
    const chosen = await select({
      message: "Quel endpoint voulez-vous tester ?",
      options: [
        {
          value: "models",
          label: "Models · GET /v1/models",
          hint: "Catalogue, SDK et contrat JSON",
        },
        { value: "responses", label: "Responses", hint: "Création de réponse" },
        { value: "quit", label: "Quitter" },
      ],
    });
    if (isCancel(chosen) || chosen === "quit") {
      cancel("Aucun test lancé.");
      return;
    }
    selectedEndpoint = chosen;
    if (chosen === "responses") {
      const scenario = await select({
        message: "Quel scénario Responses ?",
        options: [
          ...responsesScenarios.map(({ id, label, hint }) => ({ value: id, label, hint })),
          { value: "quit", label: "Quitter" },
        ],
      });
      if (isCancel(scenario) || scenario === "quit") {
        cancel("Aucun test lancé.");
        return;
      }
      selectedScenario = scenario;
    }
  }
  if (selectedEndpoint === undefined) {
    throw new GatewayError(400, "missing_test", "Choisissez un test.");
  }
  if (selectedEndpoint === "models" && parsed.data.scenario !== undefined) {
    throw new GatewayError(
      400,
      "invalid_scenario",
      "--scenario s’applique uniquement à Responses.",
    );
  }
  const responses = selectedEndpoint === "responses";
  const scenario = responsesScenarios.find(({ id }) => id === selectedScenario);
  if (responses && !scenario) {
    throw new GatewayError(400, "invalid_scenario", "Scénario Responses introuvable.");
  }
  const runner = scenario?.runner ?? "uv";
  if (runner === "uv" && !Bun.which("uv")) {
    throw new GatewayError(
      400,
      "uv_missing",
      "uv est nécessaire pour lancer le SDK Python. Installez uv puis relancez cette commande.",
    );
  }
  const options = readOptions(command);
  const selection = await selectConfig({
    ...options,
    config:
      command.parent?.getOptionValueSource("config") === "default"
        ? resolve(root, "oai-codex.config.json")
        : options.config,
  });
  const host = resolveHost(selection.config.server.host);
  const targetHost =
    host === "0.0.0.0"
      ? "127.0.0.1"
      : host === "::"
        ? "[::1]"
        : host.includes(":")
          ? `[${host}]`
          : host;
  const baseUrl = parsed.data.baseUrl ?? `http://${targetHost}:${selection.config.server.port}/v1`;
  const script = scenario?.script ?? "models/test_list.py";
  const extra = responses ? ["--model", selection.config.proxy.defaultModel] : [];
  console.log(
    `\n${responses ? `Responses · ${scenario?.label}` : "Models"} · ${baseUrl}/${selectedEndpoint}\nExécution du ${runner === "bun" ? "client Node" : "SDK Python"}…\n`,
  );
  const child = Bun.spawn(
    [
      runner,
      "run",
      resolve(root, "api-tests", script),
      ...(scenario?.scenario ? ["--scenario", scenario.scenario] : []),
      ...extra,
      "--base-url",
      baseUrl,
      "--key-file",
      resolve(parsed.data.keyFile ?? selection.config.auth.tokenFile),
      ...(parsed.data.outputDir ? ["--output-dir", resolve(parsed.data.outputDir)] : []),
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = await child.exited;
}
