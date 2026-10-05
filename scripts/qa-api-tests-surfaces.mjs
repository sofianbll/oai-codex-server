import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const base = "http://100.64.0.1:8788";
const out = "artifacts/qa/api-tests";
const browser = await chromium.launch();
const log = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await context.addInitScript(
    (token) => sessionStorage.setItem("oai-codex-token", token),
    (await readFile(".local/server-token", "utf8")).trim(),
  );
  const page = await context.newPage();
  await page.goto(base + "/#tests");
  await expect(page.getByRole("button", { name: "Lancer le test", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /02\. Streaming SSE/ }).click();
  await page
    .getByLabel("Votre message", { exact: true })
    .filter({ visible: true })
    .fill("Écris une liste numérotée de 300 phrases, une par ligne, sur les océans.");
  await page.getByRole("button", { name: "Lancer le test", exact: true }).click();
  const output = page.locator("[data-testid=response-text]:visible");
  await expect(output).not.toContainText("En attente", { timeout: 120000 });
  await expect(page.getByRole("button", { name: "Interrompre", exact: true })).toBeVisible();
  await page.screenshot({ path: out + "/stream-in-progress.png", fullPage: true });
  const partial = await output.textContent();
  await page.getByRole("button", { name: "Interrompre", exact: true }).click();
  await expect(page.locator("[data-testid=technical]:visible")).toContainText("Interrompu");
  await expect(output).toContainText(partial);
  await expect(page.locator("[data-testid=behavior]:visible")).toContainText("Non vérifié");
  await page.screenshot({ path: out + "/stream-interrupted.png", fullPage: true });
  log.push(
    "PASS incremental text observed while request active; cancel retained text and never passed",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Lancer le test", exact: true })).toBeEnabled();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    await page.locator(".test-rail").evaluate((n) => (n.open = true));
    const labels = await page.locator(".test-step-link").allTextContents();
    for (let index = 0; index < labels.length; index++) {
      await page.locator(".test-rail").evaluate((n) => (n.open = true));
      await page.locator(".test-step-link").nth(index).click();
      await page.screenshot({ path: `${out}/step-${index + 1}-${width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    for (const group of ["Images", "Audio", "Realtime", "Live"]) {
      await page.locator(".test-rail").evaluate((n) => (n.open = true));
      await page.getByRole("button", { name: group, exact: true }).click();
      await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
      await page.screenshot({ path: `${out}/group-${group}-${width}.png`, fullPage: true });
    }
    await page.locator(".test-rail").evaluate((n) => (n.open = true));
    await page.getByRole("button", { name: "Responses", exact: true }).click();
  }
  log.push(
    "PASS all 16 scenarios and four future groups captured at 375/768/1280; no page overflow",
  );
  await page.route("**/v1/models", (route) => route.fulfill({ json: { data: [] } }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Lancer le test", exact: true })).toBeDisabled();
  await expect(page.locator("[data-testid=test-feedback]:visible")).toContainText("indisponibles");
  await page.screenshot({ path: out + "/models-empty.png", fullPage: true });
  log.push("PASS empty models blocks execution");
} finally {
  await browser.close();
  log.push("CLEANUP browser closed");
  await writeFile(out + "/surfaces.json", JSON.stringify(log, null, 2));
  console.log(log.join("\n"));
}
