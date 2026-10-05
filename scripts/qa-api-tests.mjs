import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const base = "http://100.64.0.1:8788";
const out = "artifacts/qa/api-tests";
const red = process.argv.includes("--red");
const live = process.argv.includes("--live");
const browser = await chromium.launch();
const log = [];
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const token = (await readFile(".local/server-token", "utf8")).trim();
  await context.addInitScript((token) => sessionStorage.setItem("oai-codex-token", token), token);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  let mode = "ok";
  let calls = 0;
  let sent;
  if (!live) {
    await page.route("**/v1/models", (route) =>
      route.fulfill({ json: { data: [{ id: "qa-model" }] } }),
    );
    await page.route("**/v1/responses", async (route) => {
      calls++;
      sent = route.request().postDataJSON();
      if (mode === "html")
        return route.fulfill({ contentType: "text/html", body: "<html>Access denied</html>" });
      if (mode === "error")
        return route.fulfill({ status: 429, json: { error: { message: "Quota de test" } } });
      const response = {
        id: "resp_qa",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: mode === "wrong" ? "AUTRE" : "TEST_OK" }],
          },
        ],
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
      };
      if (sent.stream) {
        const events = [
          { type: "response.created", response: { id: "resp_qa", status: "in_progress" } },
          { type: "response.output_text.delta", delta: "TEST_OK" },
        ];
        if (mode !== "incomplete") events.push({ type: "response.completed", response });
        return route.fulfill({
          contentType: "text/event-stream",
          body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        });
      }
      return route.fulfill({ json: response });
    });
  }
  await page.goto(base + "/#explorer");
  await expect(page.getByRole("heading", { name: "Explorateur API", exact: true })).toBeVisible();
  await page.getByPlaceholder("Rechercher une route…").fill("input_tokens");
  await expect(page.locator(".operation")).toHaveCount(1);
  log.push("PIN PASS Explorer filtering");
  await page.goto(base + "/#activity");
  await expect(
    page.getByRole("heading", { name: "Journal des requêtes", exact: true }),
  ).toBeVisible();
  log.push("PIN PASS Activity");
  await page.goto(base + "/#tests");
  if (red) {
    await page.screenshot({ path: out + "/red.png", fullPage: true });
    const found = await page.getByRole("heading", { name: "Tests API", exact: true }).count();
    log.push(
      found
        ? "UNEXPECTED GREEN Tests API already exists"
        : "RED C1 C2 C3: Tests API absent; current surface is Playground; guided steps/verdicts unavailable",
    );
    if (found) throw new Error("Expected RED");
  } else {
    await expect(page.getByRole("heading", { name: "Tests API", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "01. Réponse simple", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Votre message", { exact: true }).fill("Réponds exactement : TEST_OK");
    await page.getByRole("button", { name: "Lancer le test", exact: true }).click();
    await expect(page.locator("[data-testid=technical]:visible")).toContainText("Réussi", {
      timeout: 180000,
    });
    await expect(page.locator("[data-testid=behavior]:visible")).toContainText("Réussi");
    await expect(page.locator("[data-testid=response-text]:visible")).toContainText("TEST_OK");
    if (!live) {
      expect(sent.stream).toBe(false);
      expect(sent.model).toBe("qa-model");
    }
    await page.getByText("Voir les échanges techniques", { exact: true }).click();
    await expect(page.locator("[data-testid=sent-request]")).toContainText("/v1/responses");
    await page.screenshot({ path: out + (live ? "/live.png" : "/success.png"), fullPage: true });
    log.push("PASS C1 simple request, independent verdicts, technical evidence");
    if (!live) {
      await page.getByLabel("Votre message", { exact: true }).fill("");
      const before = calls;
      await page.getByRole("button", { name: "Lancer le test", exact: true }).click();
      await expect(page.locator("[data-testid=test-feedback]")).toContainText("message");
      expect(calls).toBe(before);
      await expect(page.locator("[data-testid=technical]:visible")).not.toContainText("Réussi");
      log.push("PASS C2 empty input blocked and stale result invalidated");
      await page.getByLabel("Votre message", { exact: true }).fill("Réponds exactement : TEST_OK");
      mode = "html";
      await page.getByRole("button", { name: "Lancer le test", exact: true }).click();
      await expect(page.locator("[data-testid=technical]:visible")).toContainText("Échec");
      await page.screenshot({ path: out + "/html-error.png", fullPage: true });
      mode = "wrong";
      await page.getByRole("button", { name: "Réessayer", exact: true }).click();
      await expect(page.locator("[data-testid=technical]:visible")).toContainText("Réussi");
      await expect(page.locator("[data-testid=behavior]:visible")).toContainText("Échec");
      log.push("PASS C2 HTTP200 HTML rejected and wrong answer independent verdict");
      await page.getByRole("button", { name: "Passer au streaming", exact: true }).click();
      mode = "incomplete";
      await page.getByRole("button", { name: "Lancer le test", exact: true }).click();
      await expect(page.locator("[data-testid=technical]:visible")).toContainText("Échec");
      mode = "ok";
      await page.getByRole("button", { name: "Réessayer", exact: true }).click();
      await expect(page.locator("[data-testid=technical]:visible")).toContainText("Réussi");
      expect(sent.stream).toBe(true);
      log.push("PASS C3 streaming and missing terminal rejection");
      await page.getByRole("button", { name: /01\. Réponse simple/ }).click();
      await expect(page.locator("[data-testid=behavior]:visible")).toContainText("Échec");
      log.push("PASS C2 step result retained");
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 950 });
        await page.screenshot({ path: `${out}/tests-${width}.png`, fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      log.push("PASS C4 responsive no horizontal overflow 375 768 1280");
    }
    expect(errors).toEqual([]);
  }
} finally {
  await browser.close();
  log.push("CLEANUP browser contexts closed");
  await writeFile(
    `${out}/${red ? "red" : live ? "live" : "green"}.json`,
    JSON.stringify({ log, errors }, null, 2),
  );
  console.log(log.join("\n"));
}
