import { expect, test } from "bun:test";

const main = new URL("../src/cli/main.ts", import.meta.url).pathname;

test("exposes endpoint and target options when test help is requested", async () => {
  const child = Bun.spawn([process.execPath, main, "test", "--help"], { stdout: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain("--base-url");
  expect(output).toContain("--key-file");
  expect(output).toContain("--output-dir");
  expect(output).toContain("01 — Texte simple");
  expect(output).toContain("24 — Fichier en entrée");
});

test("rejects unavailable endpoints before making a request", async () => {
  const child = Bun.spawn([process.execPath, main, "test", "images"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(output).toContain("models");
});

test("keeps the expanded Responses scenarios in stable numeric order", async () => {
  const child = Bun.spawn([process.execPath, main, "test", "responses", "--help"], {
    stdout: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.indexOf("01 — Texte simple")).toBeLessThan(
    output.indexOf("04 — previous_response_id"),
  );
  expect(output.indexOf("04 — previous_response_id")).toBeLessThan(
    output.indexOf("11 — WebSocket"),
  );
  expect(output.indexOf("11 — WebSocket")).toBeLessThan(output.indexOf("24 — Fichier en entrée"));
});
