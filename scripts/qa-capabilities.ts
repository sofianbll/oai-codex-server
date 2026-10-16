import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createActivity } from "../src/server/activity";
import { createApp } from "../src/server/app";
import { parseConfig } from "../src/server/config";

let relayed = 0;
const app = createApp({
  config: parseConfig({}),
  configPath: "/unused-qa-config",
  token: "fixture-only",
  activity: createActivity(10),
  startedAt: new Date(),
  credentials: {
    get: async () => {
      throw Error("No credentials allowed");
    },
    status: async () => ({ available: false, expiresAt: null }),
  },
  address: () => ({ host: "127.0.0.1", port: 0 }),
  stop: async () => {},
  relay: async () => {
    relayed++;
    throw Error("No backend allowed");
  },
});
const browser = await chromium.launch({ channel: "msedge", headless: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem("oai-codex-token", "fixture-only"));
  await page.goto(`http://127.0.0.1:${server.port}/#explorer`);
  await page
    .getByRole("button", { name: "POST /v1/images/edits Create image edit", exact: true })
    .click();
  await expect(page.getByText("Preuve statique · 2026-10-16", { exact: true })).toBeVisible();
  await page.getByText("Sources", { exact: true }).click();
  const source =
    "https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/images.rs";
  await expect(page.getByRole("link", { name: source, exact: true })).toHaveAttribute(
    "href",
    source,
  );
  const local = page.getByText("docs/research/2026-10-16-codex-compatibility-frontier.md", {
    exact: true,
  });
  await expect(local).toBeVisible();
  assert.equal(await local.evaluate((node) => node.closest("a") !== null), false);
  await expect(page.locator('a[href*="blob/d46d975"]')).toHaveCount(0);
  await page.getByText("Limites et refus", { exact: true }).click();
  await expect(page.locator("main")).toContainText("mask, size");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const sizes = await page.locator("main").evaluate((main) => ({
      width: main.clientWidth,
      content: main.scrollWidth,
    }));
    assert.ok(sizes.content <= sizes.width, JSON.stringify(sizes));
    await expect(local).toBeVisible();
  }
  await page
    .getByRole("button", { name: "GET /v1/realtime Connect Realtime WebSocket", exact: true })
    .click();
  await expect(page.getByLabel("Chemin WebSocket")).toHaveValue("/v1/realtime");
  await expect(page.getByLabel("Trame JSON")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Envoyer la trame" })).toBeDisabled();
  assert.deepEqual(errors, []);
  assert.equal(relayed, 0);
  console.log(
    "PASS Explorer source links/labels, desktop/390px bounds and Realtime editor; no backend",
  );
} finally {
  await browser.close();
  server.stop(true);
}
