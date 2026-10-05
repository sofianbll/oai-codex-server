import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { loadServerToken } from "../src/server/access";
import { loadConfig } from "../src/server/config";

const configPath = resolve(process.argv[2] ?? "oai-codex.config.json");
const config = await loadConfig(configPath);
const state = z
  .object({ url: z.string().url() })
  .parse(JSON.parse(await readFile(resolve(dirname(configPath), ".local/server.json"), "utf8")));
const token = await loadServerToken(resolve(dirname(configPath), config.auth.tokenFile));
const client = new OpenAI({
  apiKey: token,
  baseURL: `${state.url}/v1`,
  maxRetries: 0,
  timeout: 45000,
  logLevel: "off",
});
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  baseURL: state.url,
  mode: config.proxy.translationMode,
};
try {
  const unauthorized = await fetch(`${state.url}/v1/models`);
  assert.equal(unauthorized.status, 401);
  report["unauthorized"] = unauthorized.status;
  const models = await client.models.list();
  assert.ok(models.data.some((model) => model.id === config.proxy.defaultModel));
  report["models"] = { count: models.data.length, defaultModelFound: true };
  const started = performance.now();
  const response = await client.responses.create({
    model: config.proxy.defaultModel,
    input: "Reply exactly PROXY_JSON_OK",
    reasoning: { effort: "low" },
  });
  report["jsonObserved"] = {
    status: response.status,
    output: response.output_text,
    itemTypes: response.output.map((item) => item.type),
  };
  assert.equal(response.status, "completed");
  assert.equal(response.output_text.trim(), "PROXY_JSON_OK");
  report["json"] = {
    output: response.output_text,
    durationMs: Math.round(performance.now() - started),
  };
  const streamStart = performance.now();
  const stream = await client.responses.create({
    model: config.proxy.defaultModel,
    input: "Reply exactly PROXY_SSE_OK",
    stream: true,
    reasoning: { effort: "low" },
  });
  let text = "";
  let events = 0;
  let firstEventMs = 0;
  let completed = false;
  for await (const event of stream) {
    if (events++ === 0) firstEventMs = Math.round(performance.now() - streamStart);
    if (event.type === "response.output_text.delta") text += event.delta;
    if (event.type === "response.completed") completed = true;
  }
  assert.equal(text.trim(), "PROXY_SSE_OK");
  assert.ok(completed);
  report["stream"] = {
    output: text,
    events,
    firstEventMs,
    durationMs: Math.round(performance.now() - streamStart),
  };
  report["passed"] = true;
} catch (error) {
  report["passed"] = false;
  report["error"] =
    error instanceof OpenAI.APIError
      ? { status: error.status, code: error.code, type: error.type }
      : { type: error instanceof Error ? error.name : "unknown" };
  process.exitCode = 1;
}
await mkdir(new URL("../artifacts/qa/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../artifacts/qa/live-proxy.json", import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
