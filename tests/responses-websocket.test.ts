import { expect, test } from "bun:test";

test("WebSocket two-turn acceptance runner is available", async () => {
  const script = new URL("../api-tests/responses/test_websocket.ts", import.meta.url).pathname;

  // Given: the documented WebSocket acceptance command.
  // When: Bun resolves its script entrypoint.
  const entrypoint = Bun.file(script);

  // Then: the runner exists for a real authenticated session.
  expect(await entrypoint.exists()).toBe(true);
});
