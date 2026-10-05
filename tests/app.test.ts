import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivity } from "../src/server/activity";
import { createApp } from "../src/server/app";
import { parseConfig, publicConfig, saveConfig } from "../src/server/config";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "oai-app-"));
  temporary.push(directory);
  const configPath = join(directory, "config.json");
  const config = parseConfig({});
  await saveConfig(configPath, config);
  let forwarded = 0;
  const app = createApp({
    config,
    configPath,
    token: "local-gateway-token",
    activity: createActivity(10),
    credentials: {
      get: async () => ({ accessToken: "upstream-secret", accountId: "account-secret" }),
      status: async () => ({ available: true, expiresAt: null }),
    },
    startedAt: new Date(),
    address: () => ({ host: "127.0.0.1", port: 8787 }),
    stop: async () => {},
    relay: async () => {
      forwarded++;
      return new Response("upstream bytes", {
        status: 418,
        headers: { "x-request-id": "req-test" },
      });
    },
  });
  const headers = { authorization: "Bearer local-gateway-token" };
  return { app, headers, forwarded: () => forwarded };
}
test("public liveness and spec; API requires local token and same-origin", async () => {
  const { app, headers, forwarded } = await fixture();
  expect((await app.request("/health")).status).toBe(200);
  expect((await app.request("/openapi.json")).status).toBe(200);
  expect((await app.request("/api/status")).status).toBe(401);
  expect(
    (
      await app.request("/v1/responses", {
        method: "POST",
        headers: { ...headers, origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(forwarded()).toBe(0);
  const response = await app.request("/api/status", { headers });
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("secret");
});
test("authenticated route preserves response and records only metadata", async () => {
  const { app, headers } = await fixture();
  const response = await app.request("/v1/future?secret=hidden", {
    method: "POST",
    headers,
    body: "private prompt",
  });
  expect(response.status).toBe(418);
  expect(await response.text()).toBe("upstream bytes");
  expect(response.headers.get("x-request-id")).toBe("req-test");
  const activity = await (await app.request("/api/activity", { headers })).text();
  expect(activity).toContain("/v1/future");
  expect(activity).not.toContain("private prompt");
  expect(activity).not.toContain("hidden");
});
test("config validates, persists, requires restart and cannot alter auth", async () => {
  const { app, headers } = await fixture();
  const initial = publicConfig(parseConfig({}));
  const invalid = await app.request("/api/config", {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...initial, auth: { tokenFile: "bad" } }),
  });
  expect(invalid.status).toBe(400);
  const updated = { ...initial, server: { host: "127.0.0.1", port: 9898 } };
  const saved = await app.request("/api/config", {
    method: "PUT",
    headers,
    body: JSON.stringify(updated),
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ saved: true, restartRequired: true });
  expect(await (await app.request("/api/config", { headers })).json()).toMatchObject({
    server: { port: 9898 },
  });
  expect(await (await app.request("/api/status", { headers })).json()).toMatchObject({
    network: { port: 8787 },
  });
});
