import { expect, test } from "bun:test";

test("Node SDK acceptance runner is available", async () => {
  const script = new URL("../api-tests/responses/test_node.ts", import.meta.url).pathname;

  // Given: the documented Node acceptance command.
  // When: Bun resolves its script entrypoint.
  const entrypoint = Bun.file(script);

  // Then: the runner exists for the CLI integration layer to invoke.
  expect(await entrypoint.exists()).toBe(true);
});
