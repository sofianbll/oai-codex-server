import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { loadServerToken } from "../server/access";
import { GatewayError } from "../shared/contracts";
import { showStatus, startDetached, stopServer } from "./lifecycle";
import { initialize, readOptions, selectConfig } from "./options";
import { responsesScenarios } from "./responses-scenarios";

const program = new Command()
  .name("oai-codex")
  .version("0.1.0")
  .description("Serveur local compatible OpenAI pour votre session Codex")
  .option("-c, --config <path>", "Fichier de configuration", "oai-codex.config.json")
  .option("--host <host>", "Adresse d'écoute ou tailscale")
  .option("--port <number>", "Port HTTP (0 pour un port libre)")
  .option("--model <name>", "Modèle par défaut")
  .option("--mode <mode>", "Traduction minimal ou raw")
  .option("--timeout <milliseconds>", "Délai maximal d'une requête")
  .option("--dashboard", "Activer le tableau de bord")
  .option("--no-dashboard", "Désactiver le tableau de bord")
  .option("--docs", "Activer la documentation")
  .option("--no-docs", "Désactiver la documentation")
  .exitOverride();

program
  .command("init")
  .description("Créer la configuration et la clé du serveur")
  .option("--force", "Remplacer la configuration existante")
  .action(async (_options: unknown, command: Command) => {
    await initialize(readOptions(command));
  });
program
  .command("serve")
  .description("Démarrer au premier plan")
  .action(async (_options: unknown, command: Command) => {
    const selected = await selectConfig(readOptions(command));
    const { startServer } = await import("../server/runtime");
    const server = await startServer(selected.config, selected.configPath);
    console.log(`Serveur disponible : ${server.url}`);
  });
program
  .command("start")
  .description("Démarrer en arrière-plan")
  .action(async (_options: unknown, command: Command) => {
    await startDetached(readOptions(command));
  });
program
  .command("status")
  .description("Lire le statut du serveur")
  .action(async (_options: unknown, command: Command) => {
    await showStatus(await selectConfig(readOptions(command)));
  });
program
  .command("stop")
  .description("Arrêter le serveur via son API authentifiée")
  .action(async (_options: unknown, command: Command) => {
    await stopServer(await selectConfig(readOptions(command)));
  });
program
  .command("token")
  .description("Afficher uniquement la clé d'accès au serveur")
  .action(async (_options: unknown, command: Command) => {
    const { config } = await selectConfig(readOptions(command));
    console.log(await loadServerToken(config.auth.tokenFile));
  });
program
  .command("config")
  .description("Vérifier la configuration")
  .command("validate")
  .description("Valider le fichier de configuration")
  .action(async (_options: unknown, command: Command) => {
    await selectConfig(readOptions(command));
    console.log("Configuration valide.");
  });

program
  .command("test [endpoint]")
  .description("Choisir un test API et afficher ses contrôles de compatibilité")
  .option(
    "--scenario <name>",
    "Scénario Responses numéroté (01 à 26 ; voir oai-codex test responses --help)",
  )
  .option("--base-url <url>", "URL à tester, incluant /v1 (configuration par défaut)")
  .option("--key-file <path>", "Fichier de clé (configuration par défaut)")
  .option(
    "--output-dir <path>",
    "Dossier des rapports JSON expurgés (par défaut : résultats du scénario)",
  )
  .addHelpText(
    "after",
    `\nScénarios Responses :\n${responsesScenarios.map(({ id, label }) => `  ${label}  (${id})`).join("\n")}\n`,
  )
  .action(async (endpoint: string | undefined, _options: unknown, command: Command) => {
    const { runApiTest } = await import("./api-tests");
    await runApiTest(endpoint, command);
  });

const defaultLinkDir = resolve(homedir(), ".local/bin");
program
  .command("link")
  .description("Installer oai-codex dans le PATH via un lien symbolique")
  .option("--target <dir>", "Répertoire cible", defaultLinkDir)
  .action((options: { target: string }) => {
    const binScript = resolve(import.meta.dir, "../../bin/oai-codex");
    const linkPath = resolve(options.target, "oai-codex");
    if (existsSync(linkPath)) {
      console.log("Le lien existe déjà : " + linkPath);
      return;
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(binScript, linkPath);
    console.log("Lien créé : " + linkPath + " -> " + binScript);
    console.log("Vérifiez que " + options.target + " est dans votre PATH.");
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    console.error(
      error instanceof GatewayError ? error.message : "Impossible d'exécuter cette commande.",
    );
    process.exitCode = 1;
  }
}
