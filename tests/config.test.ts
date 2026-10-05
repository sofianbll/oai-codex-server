import { describe, expect, test } from "bun:test";
import { parseConfig, publicConfig } from "../src/server/config";

describe("server configuration boundary", () => {
  test("defaults retain a fixed Codex origin and bounded requests", () => {
    const config = parseConfig({});
    expect(config.proxy.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(config.server.port).toBe(8787);
    expect(config.proxy.translationMode).toBe("minimal");
    expect(config.limits.maxConcurrent).toBe(16);
  });
  test("rejects unknown keys, unbounded limits and credential destinations", () => {
    expect(() => parseConfig({ proxy: { baseUrl: "https://example.com" } })).toThrow();
    expect(() => parseConfig({ proxy: { timeoutMs: 0 } })).toThrow();
    expect(() => parseConfig({ server: { port: 70000 } })).toThrow();
    expect(() => parseConfig({ auth: { disable: true } })).toThrow();
  });
  test("public configuration excludes credential and token locations", () => {
    const config = parseConfig({
      auth: { codexHome: "/private/auth", tokenFile: "/secret/token" },
    });
    expect(JSON.stringify(publicConfig(config))).not.toContain("/private/auth");
    expect(JSON.stringify(publicConfig(config))).not.toContain("/secret/token");
  });
});
