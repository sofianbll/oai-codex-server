import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivity } from "../src/server/activity";
import { createApp } from "../src/server/app";
import { parseConfig, publicConfig, saveConfig } from "../src/server/config";
import { operationsSchema } from "../src/ui/schemas";

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
test("capabilities distinguish relayable Images from native source proof for dashboard clients", async () => {
  const { app, headers, forwarded } = await fixture();
  const response = await app.request("/api/capabilities", { headers });
  expect(response.status).toBe(200);
  const { operations } = operationsSchema.parse(await response.json());
  expect(operations.find((operation) => operation.id === "createImage")).toMatchObject({
    supported: true,
    availability: "source-backed",
    implementation: "relay",
    evidence: {
      kind: "source",
      date: "2026-10-16",
      scope: expect.stringContaining("images/generations"),
      sources: expect.arrayContaining([
        expect.stringContaining("83086188ae0614bd882818ff1aa23f3194962012"),
      ]),
    },
    prerequisites: expect.arrayContaining([expect.stringContaining("account")]),
    limitations: expect.arrayContaining([expect.stringContaining("mask")]),
  });
  expect(forwarded()).toBe(0);
});
test("capabilities retain exact-count uncertainty, historical option refusals and tool prerequisites", async () => {
  const { app, headers } = await fixture();
  const { operations } = operationsSchema.parse(
    await (await app.request("/api/capabilities", { headers })).json(),
  );
  const count = operations.find((operation) => operation.path === "/v1/responses/input_tokens");
  expect(count).toMatchObject({
    supported: true,
    implementation: "relay",
    availability: "unverified",
    evidence: { kind: "historical-refusal", date: "2026-09-20" },
    limitations: expect.arrayContaining([expect.stringContaining("not an exact preflight count")]),
  });
  const create = operations.find((operation) => operation.id === "createResponse");
  expect(create).toMatchObject({
    implementation: "adaptation",
    evidence: { kind: "runtime", date: "2026-09-20", scope: expect.stringContaining("basic text") },
    prerequisites: expect.arrayContaining([
      expect.stringContaining("File Search"),
      expect.stringContaining("MCP"),
    ]),
    limitations: expect.arrayContaining([
      expect.stringContaining("temperature, top_p, max_output_tokens"),
      expect.stringContaining("Code Interpreter"),
    ]),
  });
  expect(operations.some((operation) => /\/v1\/(chat|conversations)/.test(operation.path))).toBe(
    false,
  );
  expect(operations.find((operation) => operation.id === "createImageVariation")).toMatchObject({
    implementation: "relay",
    availability: "unverified",
    evidence: { kind: "unknown", scope: expect.stringContaining("variations") },
  });
});
test("capabilities separate Audio REST, Realtime WebSocket, WebRTC and effectful controls", async () => {
  const { app, headers, forwarded } = await fixture();
  const { operations } = operationsSchema.parse(
    await (await app.request("/api/capabilities", { headers })).json(),
  );
  for (const id of ["createSpeech", "createTranscription", "createTranslation"]) {
    expect(operations.find((operation) => operation.id === id)).toMatchObject({
      implementation: "relay",
      availability: "unverified",
      evidence: { kind: "unknown", scope: expect.stringContaining("Audio REST") },
      limitations: expect.arrayContaining([
        expect.stringContaining("outside the authorized Codex prefix"),
      ]),
    });
  }
  expect(operations.find((operation) => operation.id === "connectRealtimeWebSocket")).toMatchObject(
    {
      method: "GET",
      path: "/v1/realtime",
      supported: true,
      implementation: "relay",
      availability: "source-backed",
      evidence: { kind: "source", date: "2026-10-16", scope: expect.stringContaining("WebSocket") },
      prerequisites: expect.arrayContaining([
        expect.stringContaining("API key auth"),
        expect.stringContaining("ChatGPT bearer"),
      ]),
      limitations: expect.arrayContaining([
        expect.stringContaining("RealtimeV2"),
        expect.stringContaining("quicksilver"),
        expect.stringContaining("Frameless Bidi"),
        expect.stringContaining("thread/realtime"),
        expect.stringContaining("SDK"),
      ]),
    },
  );
  expect(operations.find((operation) => operation.id === "create-realtime-call")).toMatchObject({
    implementation: "relay",
    availability: "source-backed",
    limitations: expect.arrayContaining([
      expect.stringContaining("JSON {sdp, session}"),
      expect.stringContaining("multipart"),
    ]),
  });
  for (const id of [
    "createVoice",
    "createVoiceConsent",
    "refer-realtime-call",
    "refer-live-session",
  ]) {
    expect(operations.find((operation) => operation.id === id)).toMatchObject({
      availability: "unverified",
      prerequisites: expect.arrayContaining([expect.stringContaining("explicit authorization")]),
    });
  }
  expect(forwarded()).toBe(0);
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
