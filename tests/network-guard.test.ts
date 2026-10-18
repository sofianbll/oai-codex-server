import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

test("configured Bun test preload blocks remote global transports before any external API effect", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "test-network-guard-"));
  const config = z
    .object({ test: z.object({ preload: z.array(z.string()) }) })
    .parse(Bun.TOML.parse(await Bun.file(join(root, "bunfig.toml")).text()));
  const preloads = [
    join(root, "tests/fixtures/network-boundary-stub.ts"),
    ...config.test.preload.map((path) => resolve(root, path)),
  ];
  try {
    await writeFile(
      join(directory, "bunfig.toml"),
      `[test]\npreload = ${JSON.stringify(preloads)}\n`,
    );
    await writeFile(
      join(directory, "guard.test.ts"),
      `import ${JSON.stringify(join(root, "tests/fixtures/network-guard-probe.ts"))};\n`,
    );
    const child = Bun.spawn([process.execPath, "test", "./guard.test.ts"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
