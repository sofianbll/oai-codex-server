import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/server/config";

const main = new URL("../src/cli/main.ts", import.meta.url).pathname;
let directory = "";
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codex-cli-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("CLI local setup", () => {
  test("shows available commands when help is requested", async () => {
    // Given / When
    const result = await cli("--help");
    // Then
    expect(result.code).toBe(0);
    for (const command of ["init", "serve", "start", "status", "stop", "token", "config"])
      expect(result.stdout).toContain(command);
  });

  test("creates config and a private gateway token when initialized", async () => {
    // Given / When
    const result = await cli(
      "init",
      "--port",
      "9876",
      "--model",
      "test-model",
      "--mode",
      "raw",
      "--no-docs",
    );
    // Then
    expect(result.code).toBe(0);
    const config = parseConfig(
      JSON.parse(await readFile(join(directory, "oai-codex.config.json"), "utf8")),
    );
    expect(config.server.port).toBe(9876);
    expect(config.proxy.defaultModel).toBe("test-model");
    expect(config.proxy.translationMode).toBe("raw");
    expect(config.docs.enabled).toBe(false);
    const token = (await readFile(join(directory, ".local/server-token"), "utf8")).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(result.stdout).not.toContain(token);
  });

  test("preserves existing configuration when init has no force flag", async () => {
    // Given
    const configPath = join(directory, "oai-codex.config.json");
    await writeFile(configPath, '{"server":{"port":9877}}');
    // When
    const result = await cli("init");
    // Then
    expect(result.code).toBe(1);
    expect(await readFile(configPath, "utf8")).toBe('{"server":{"port":9877}}');
  });

  test("anchors token storage to the config directory when a custom config is selected", async () => {
    // Given
    const configPath = join(directory, "nested", "config.json");
    await cli("init", "--config", configPath);
    const token = (await readFile(join(directory, "nested", ".local/server-token"), "utf8")).trim();
    // When
    const result = await cli("token", "--config", configPath);
    // Then
    expect(result).toEqual({ code: 0, stdout: `${token}\n`, stderr: "" });
  });

  test("fails validation when config contains unsupported fields", async () => {
    // Given
    await writeFile(join(directory, "oai-codex.config.json"), '{"secret":"private-token"}');
    // When
    const result = await cli("config", "validate");
    // Then
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("private-token");
  });

  test("waits for shutdown completion when the stop API only acknowledges acceptance", async () => {
    // Given
    await cli("init");
    const statePath = join(directory, ".local/server.json");
    await writeFile(
      statePath,
      JSON.stringify({
        pid: 12345,
        url: "http://127.0.0.1:9999",
        configPath: join(directory, "oai-codex.config.json"),
      }),
    );
    const fixture = join(directory, "accepted-stop.js");
    await writeFile(
      fixture,
      `import {unlink} from "node:fs/promises";
      globalThis.fetch = async () => {
        setTimeout(() => { void unlink(${JSON.stringify(statePath)}); }, 100).unref();
        return Response.json({accepted: true});
      };`,
    );
    // When
    const child = Bun.spawn([process.execPath, "--preload", fixture, main, "stop"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    // Then
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(await Bun.file(statePath).exists()).toBe(false);
  });
});
