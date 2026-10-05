import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import { loadServerToken } from "../server/access";
import { GatewayError } from "../shared/contracts";
import { type CliOptions, forwardedOptions, type Selection, selectConfig } from "./options";

const stateSchema = z.object({
  pid: z.number().int().positive(),
  url: z.url(),
  configPath: z.string(),
});
const statusSchema = z.object({
  uptimeSeconds: z.number(),
  auth: z.object({ available: z.boolean() }),
});
type ServerState = z.infer<typeof stateSchema>;

async function readState(selection: Selection): Promise<ServerState | null> {
  try {
    const state = stateSchema.parse(
      JSON.parse(await readFile(join(dirname(selection.configPath), ".local/server.json"), "utf8")),
    );
    const url = new URL(state.url);
    if (
      state.configPath !== selection.configPath ||
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new GatewayError(
        500,
        "invalid_server_state",
        "L'état enregistré du serveur est invalide.",
      );
    }
    return state;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      500,
      "invalid_server_state",
      "L'état enregistré du serveur est illisible.",
    );
  }
}

async function request(
  selection: Selection,
  target: { readonly state: ServerState; readonly method: "GET" | "POST"; readonly path: string },
) {
  const token = await loadServerToken(selection.config.auth.tokenFile);
  try {
    return await ky(new URL(target.path, target.state.url), {
      method: target.method,
      headers: { authorization: `Bearer ${token}` },
      retry: 0,
      timeout: 1500,
      redirect: "error",
    });
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 401) {
      throw new GatewayError(
        401,
        "server_access_denied",
        "La clé d'accès est refusée par le serveur.",
      );
    }
    throw new GatewayError(503, "server_unreachable", "Le serveur est inaccessible.");
  }
}

export async function showStatus(selection: Selection): Promise<void> {
  const state = await readState(selection);
  if (!state) {
    console.log("Serveur arrêté.");
    return;
  }
  const response = await request(selection, { state, method: "GET", path: "/api/status" });
  const status = statusSchema.parse(await response.json());
  console.log(
    `Serveur actif : ${state.url}\nDepuis ${Math.floor(status.uptimeSeconds)} s · Session Codex ${status.auth.available ? "disponible" : "indisponible"}`,
  );
}

export async function stopServer(selection: Selection): Promise<void> {
  const state = await readState(selection);
  if (!state) {
    console.log("Serveur déjà arrêté.");
    return;
  }
  await request(selection, { state, method: "POST", path: "/api/server/stop" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await readState(selection);
    if (!current || current.pid !== state.pid) {
      console.log("Serveur arrêté.");
      return;
    }
    await Bun.sleep(50);
  }
  throw new GatewayError(
    504,
    "server_stop_pending",
    "Arrêt demandé, mais sa confirmation a dépassé le délai.",
  );
}

export async function startDetached(options: CliOptions): Promise<void> {
  const selected = await selectConfig(options);
  const previous = await readState(selected);
  if (previous) {
    try {
      await request(selected, { state: previous, method: "GET", path: "/api/status" });
      console.log(`Serveur déjà actif : ${previous.url}`);
      return;
    } catch (error) {
      if (!(error instanceof GatewayError && error.code === "server_unreachable")) throw error;
    }
  }
  const local = join(dirname(selected.configPath), ".local");
  await mkdir(local, { recursive: true, mode: 0o700 });
  const log = await open(join(local, "server.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "serve",
      "--config",
      selected.configPath,
      ...forwardedOptions(options),
    ],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      cwd: process.cwd(),
    },
  );
  let exited = false;
  let closed = false;
  let started = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("close", () => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(new GatewayError(500, "server_start_failed", "Le serveur n'a pas pu démarrer.")),
      );
    });
    const deadline = Date.now() + 15_000;
    while (!exited && Date.now() < deadline) {
      const state = await readState(selected);
      if (state && state.pid === child.pid) {
        try {
          await request(selected, { state, method: "GET", path: "/health" });
          started = true;
          child.unref();
          console.log(`Serveur démarré : ${state.url}`);
          return;
        } catch (error) {
          if (!(error instanceof GatewayError && error.code === "server_unreachable")) throw error;
        }
      }
      await Bun.sleep(100);
    }
    throw new GatewayError(
      500,
      "server_start_failed",
      "Démarrage impossible. Consultez .local/server.log près de la configuration.",
    );
  } finally {
    await log.close();
    if (!started && !closed) {
      child.kill("SIGTERM");
      const forceStop = setTimeout(() => child.kill("SIGKILL"), 1000);
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      clearTimeout(forceStop);
    }
  }
}
