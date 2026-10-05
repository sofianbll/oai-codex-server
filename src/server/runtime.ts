import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GatewayError } from "../shared/contracts";
import { authorized, checkOrigin, loadServerToken } from "./access";
import { createActivity } from "./activity";
import { createApp, errorResponse } from "./app";
import { type AppConfig, resolveHost } from "./config";
import { createCredentialStore } from "./credentials";
import { createResponsesGateway } from "./responses-gateway";
import { createWebSocketProxy, type WebSocketData } from "./websocket";

export async function startServer(config: AppConfig, configPath: string) {
  const directory = dirname(resolve(configPath));
  const infoPath = resolve(directory, ".local/server.json");
  const token = await loadServerToken(resolve(directory, config.auth.tokenFile));
  const credentials = createCredentialStore(resolve(directory, config.auth.codexHome));
  const websocket = createWebSocketProxy(config.proxy, credentials.get);
  const responses = createResponsesGateway(config.proxy, credentials.get);
  const host = resolveHost(config.server.host);
  let stopped = false;
  let server: Bun.Server<WebSocketData> | undefined;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    websocket.close();
    responses.close();
    await server?.stop(true);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      const saved: unknown = JSON.parse(await readFile(infoPath, "utf8"));
      if (
        typeof saved === "object" &&
        saved !== null &&
        "pid" in saved &&
        saved.pid === process.pid
      )
        await unlink(infoPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        console.error("Impossible de retirer le fichier d'état du serveur.");
    }
  };
  const app = createApp({
    config,
    configPath,
    token,
    credentials,
    activity: createActivity(config.limits.activityEntries),
    startedAt: new Date(),
    address: () => ({ host, port: server?.port ?? config.server.port }),
    stop,
    relay: (request) => responses.forward(request),
  });
  server = Bun.serve<WebSocketData>({
    hostname: host,
    port: config.server.port,
    idleTimeout: 0,
    maxRequestBodySize: config.proxy.maxBodyBytes,
    websocket: websocket.websocket,
    async fetch(request, runtime) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        try {
          if (!new URL(request.url).pathname.startsWith("/v1/"))
            throw new GatewayError(404, "not_found", "Route inconnue.");
          if (!checkOrigin(request))
            throw new GatewayError(403, "origin_rejected", "Origine non autorisée.");
          if (!authorized(request, token))
            throw new GatewayError(401, "unauthorized", "Clé du serveur requise.");
          return await websocket.upgrade(request, runtime);
        } catch (error) {
          return errorResponse(error);
        }
      }
      return app.fetch(request);
    },
    error: errorResponse,
  });
  const reachable =
    host === "0.0.0.0"
      ? "127.0.0.1"
      : host === "::"
        ? "[::1]"
        : host.includes(":")
          ? `[${host}]`
          : host;
  const url = `http://${reachable}:${server.port}`;
  try {
    await mkdir(dirname(infoPath), { recursive: true, mode: 0o700 });
    await writeFile(
      infoPath,
      `${JSON.stringify({ pid: process.pid, url, configPath: resolve(configPath) })}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    await stop();
    throw error;
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { url, stop };
}
