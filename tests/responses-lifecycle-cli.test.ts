import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

const script = new URL("../api-tests/responses/test_lifecycle.py", import.meta.url).pathname;

test("lifecycle runner exposes every native capability scenario", async () => {
  const child = Bun.spawn(["uv", "run", script, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // Sur GitHub Actions, rich colore l'aide : les codes ANSI coupent « --base-url ».
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text().then(stripVTControlCharacters),
    new Response(child.stderr).text(),
  ]);
  expect({ code, detail: stdout + stderr }).toEqual({
    code: 0,
    detail: expect.stringContaining("previous-response"),
  });
  expect(stdout).toContain("conversation");
  expect(stdout).toContain("retrieve");
  expect(stdout).toContain("delete");
  expect(stdout).toContain("background-cancel");
  expect(stdout).toContain("input-tokens");
  expect(stdout).toContain("compact");
  expect(stdout).toContain("--base-url");
  expect(stdout).toContain("--key-file");
  expect(stdout).toContain("--model");
  expect(stdout).toContain("--output-dir");
}, 30_000);
