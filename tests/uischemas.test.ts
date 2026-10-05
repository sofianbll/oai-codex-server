import { expect, test } from "bun:test";
import { parseConfig, publicConfig } from "../src/server/config";
import { configSchema } from "../src/ui/schemas";

test("dashboard config preserves custom client version through read and save", () => {
  const active = parseConfig({ proxy: { clientVersion: "0.160.1" } });
  const editorValue = configSchema.parse(publicConfig(active));
  const submitted = configSchema.parse(JSON.parse(JSON.stringify(editorValue)));
  const saved = parseConfig({ ...active, ...submitted });
  expect(submitted.proxy.clientVersion).toBe("0.160.1");
  expect(saved.proxy.clientVersion).toBe("0.160.1");
});

test("dashboard accepts an ephemeral server port from the server config", () => {
  const active = parseConfig({ server: { port: 0 } });
  expect(configSchema.parse(publicConfig(active)).server.port).toBe(0);
});
