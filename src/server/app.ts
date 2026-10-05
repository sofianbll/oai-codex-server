import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { GatewayError, type PublicStatus } from "../shared/contracts";
import { authorized, checkOrigin } from "./access";
import type { Activity } from "./activity";
import { operations } from "./catalog";
import { type AppConfig, loadConfig, parseConfig, publicConfig, saveConfig } from "./config";
import type { createCredentialStore } from "./credentials";
import { createOpenApi } from "./openapi";
import { staticRoutes } from "./static";
import { forward } from "./upstream";

export type AppOptions = {
  config: AppConfig;
  configPath: string;
  token: string;
  activity: Activity;
  credentials: ReturnType<typeof createCredentialStore>;
  startedAt: Date;
  address: () => { host: string; port: number };
  stop: () => Promise<void>;
  relay?: typeof forward;
};

export function errorResponse(error: unknown): Response {
  const known = error instanceof GatewayError;
  const status = known ? error.status : 500;
  return Response.json(
    {
      error: {
        message: known ? error.message : "Erreur interne du proxy.",
        type: status < 500 ? "invalid_request_error" : "server_error",
        code: known ? error.code : "internal_error",
        param: null,
      },
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function createApp(options: AppOptions) {
  const { config, token, activity, credentials } = options;
  const app = new Hono();
  let specification: ReturnType<typeof createOpenApi> | undefined;
  app.use("*", async (context, next) => {
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "no-referrer");
    context.header("x-frame-options", "DENY");
    if (!context.req.path.startsWith("/v1/")) context.header("cache-control", "no-store");
    await next();
  });
  for (const prefix of ["/api/*", "/v1/*"]) {
    app.use(prefix, async (context, next) => {
      if (!checkOrigin(context.req.raw))
        throw new GatewayError(403, "origin_rejected", "Origine non autorisée.");
      if (!authorized(context.req.raw, token))
        throw new GatewayError(
          401,
          "unauthorized",
          "Clé du serveur requise (Authorization: Bearer).",
        );
      await next();
    });
  }
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 65536,
      onError: () =>
        errorResponse(new GatewayError(413, "body_too_large", "Configuration trop volumineuse.")),
    }),
  );
  app.get("/health", (context) => context.json({ status: "ok", service: "oai-codex" }));
  app.get("/openapi.json", async (context) => {
    specification ??= createOpenApi(config.proxy.defaultModel);
    return context.json(await specification);
  });
  app.get("/api/status", async (context) => {
    const address = options.address();
    const auth = await credentials.status();
    const status: PublicStatus = {
      version: "0.1.0",
      startedAt: options.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - options.startedAt.getTime()) / 1000),
      requests: activity.stats(),
      auth: { mode: "chatgpt", ...auth },
      upstream: {
        origin: config.proxy.baseUrl,
        mode: config.proxy.translationMode,
        defaultModel: config.proxy.defaultModel,
      },
      network: { bind: address.host, port: address.port, addresses: [address.host] },
    };
    return context.json(status);
  });
  app.get("/api/capabilities", (context) => context.json({ operations }));
  app.get("/api/activity", (context) => context.json({ entries: activity.entries() }));
  app.get("/api/config", async (context) =>
    context.json(publicConfig(await loadConfig(options.configPath))),
  );
  app.put("/api/config", async (context) => {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      throw new GatewayError(400, "invalid_json", "JSON invalide.");
    }
    const parsed = z
      .strictObject({
        server: z.unknown(),
        proxy: z.unknown(),
        dashboard: z.unknown(),
        docs: z.unknown(),
      })
      .safeParse(input);
    if (!parsed.success)
      throw new GatewayError(400, "invalid_config", "Champs de configuration invalides.");
    const current = await loadConfig(options.configPath);
    const next = parseConfig({ ...current, ...parsed.data });
    await saveConfig(options.configPath, next);
    return context.json({ saved: true, restartRequired: true, config: publicConfig(next) });
  });
  app.post("/api/server/stop", (context) => {
    setTimeout(() => {
      void options.stop();
    }, 100);
    return context.json({ stopping: true });
  });
  app.all("/v1/*", async (context) => {
    if (activity.stats().active >= config.limits.maxConcurrent)
      throw new GatewayError(429, "too_many_requests", "Limite de requêtes simultanées atteinte.");
    const transaction = activity.begin(context.req.raw);
    try {
      const response = await (options.relay ?? forward)(
        context.req.raw,
        config.proxy,
        credentials.get,
      );
      return activity.observe(response, transaction);
    } catch (error) {
      transaction.finish(error instanceof GatewayError ? error.status : 500, 0, "failed");
      throw error;
    }
  });
  app.route("/", staticRoutes(config.dashboard.enabled, config.docs.enabled));
  app.notFound(() => errorResponse(new GatewayError(404, "not_found", "Route inconnue.")));
  app.onError((error) => errorResponse(error));
  return app;
}
