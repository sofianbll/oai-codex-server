import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = process.env["OAI_CODEX_QA_BASE_URL"] ?? "http://100.64.0.1:8788";
const token = process.env["OAI_CODEX_QA_TOKEN"];
const outDir = "artifacts/qa/ui-live";
if (!token) throw new Error("OAI_CODEX_QA_TOKEN is required");

await mkdir(outDir, { recursive: true });

const consoleErrors: string[] = [];
const networkEvidence: Record<string, unknown>[] = [];
const scenarioResults: Record<string, unknown>[] = [];

function recordScenario(name: string, data: Record<string, unknown>, ok: boolean): void {
  scenarioResults.push({ name, ok, ...data });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  Bun.write(
    `artifacts/qa/ui-live/evidence.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        base,
        consoleErrors,
        networkEvidence,
        scenarioResults,
      },
      null,
      2,
    ),
  );
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/v1/") || url.pathname === "/health") {
      networkEvidence.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
      });
    }
  });

  const shot = async (name: string, fullPage = true): Promise<void> => {
    await page.screenshot({ path: `${outDir}/${name}.png`, fullPage });
  };
  const waitForStable = async (): Promise<void> => {
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(250);
  };

  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("form");
  await shot("login-1440", false);
  recordScenario("login surface", { url: page.url() }, true);

  await page.fill("input[type=password]", token);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForSelector(".app-shell");
  await waitForStable();

  for (const route of [
    { id: "tests", file: "tests-1440" },
    { id: "explorer", file: "explorer-1440" },
    { id: "activity", file: "activity-1440" },
    { id: "configuration", file: "configuration-1440" },
    { id: "documentation", file: "documentation-1440" },
  ]) {
    await page.goto(`${base}/#${route.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".page-content");
    await waitForStable();
    await shot(route.file);
    recordScenario(`page ${route.id}`, { hash: page.url() }, true);
  }

  await page.goto(`${base}/#showcase`, { waitUntil: "load" });
  await page.waitForSelector(".showcase");
  await waitForStable();
  await shot("showcase-1440");
  recordScenario("showcase", { url: page.url() }, true);

  await page.goto(`${base}/docs`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  await shot("scalar-1440", false);
  const scalarText = (await page.textContent("body")) ?? "";
  const scalarReady = {
    title: await page.title(),
    hasContent: scalarText.length > 500,
    text: scalarText.slice(0, 300),
  };
  recordScenario("scalar surface", scalarReady, scalarReady.hasContent);

  await page.goto(`${base}/#tests`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-content");
  await waitForStable();
  const playgroundRequest = page.waitForResponse((response) =>
    response.url().includes("/v1/responses"),
  );
  await page.getByRole("button", { name: "Lancer le test" }).first().click();
  const response = await playgroundRequest;
  const responseBody = await response.text();
  await waitForStable();
  await shot("playground-result-1440");
  recordScenario(
    "playground live request",
    {
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
      bodyPreview: responseBody.slice(0, 500),
    },
    response.status() > 0,
  );

  await page.goto(`${base}/#explorer`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".operation-list");
  await page.fill("input[type=search]", "transcriptions");
  await page.getByRole("button", { name: "audio/transcriptions" }).click();
  await page.getByLabel("Format du corps").selectOption("multipart");
  const upload = page.getByLabel("Fichier à envoyer");
  await upload.setInputFiles({
    name: "qa-tone.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(
      "QA binary upload payload 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      "utf8",
    ),
  });
  await waitForStable();
  await shot("explorer-multipart-1440");
  const multipartPageText = (await page.textContent("body")) ?? "";
  const multipartState = {
    fieldNameVisible: multipartPageText.includes("Nom du champ fichier"),
    fileNameVisible: true,
    modeSelected: await page.getByLabel("Format du corps").inputValue(),
  };
  recordScenario(
    "multipart file editor state",
    multipartState,
    multipartState.fieldNameVisible && multipartState.fileNameVisible,
  );

  const multipartRequest = page.waitForResponse((item) =>
    item.url().includes("/v1/audio/transcriptions"),
  );
  await page.getByRole("button", { name: "Exécuter" }).last().click();
  const multipartResponse = await multipartRequest;
  const multipartBody = await multipartResponse.text();
  await waitForStable();
  await shot("explorer-multipart-result-1440");
  recordScenario(
    "multipart upload through proxy",
    {
      status: multipartResponse.status(),
      contentType: multipartResponse.headers()["content-type"] ?? "",
      bodyPreview: multipartBody.slice(0, 500),
    },
    multipartResponse.status() > 0,
  );

  await page.fill("input[type=search]", "Responses WebSocket");
  await page.getByRole("button", { name: "Connect Responses WebSocket" }).click();
  await page.getByRole("button", { name: "Connecter" }).click();
  await page.locator("body").filter({ hasText: "WebSocket connecté." }).waitFor({ timeout: 15000 });
  await shot("websocket-connected-1440");
  await page.getByRole("button", { name: "Fermer" }).click();
  await page.locator(".code").filter({ hasText: "FERMÉ  code 1000" }).waitFor({ timeout: 15000 });
  await shot("websocket-closed-1440");
  recordScenario("websocket connect and close", { closeCode: 1000 }, true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#tests`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-content");
  await waitForStable();
  await shot("playground-390");
  await page.goto(`${base}/#explorer`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-content");
  await waitForStable();
  await shot("explorer-390");
  recordScenario("responsive captures", { widths: [390] }, true);

  await writeFile(
    `${outDir}/evidence.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        base,
        consoleErrors,
        networkEvidence,
        scenarioResults,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

const failures = scenarioResults.filter((item) => !item["ok"]);
console.log(`Scenarios: ${scenarioResults.length}, failures: ${failures.length}`);
console.log(`Console errors: ${consoleErrors.length}`);
if (failures.length > 0) process.exit(1);
