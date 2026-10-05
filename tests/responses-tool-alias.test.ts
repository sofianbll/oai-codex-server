import { expect, test } from "bun:test";
import { adaptRequest } from "../src/server/response-adapter";
import type { ProxyOptions } from "../src/shared/contracts";

const options: ProxyOptions = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  timeoutMs: 2_000,
  maxBodyBytes: 1024 * 1024,
  defaultModel: "fixture-model",
  clientVersion: "0.0.1-fixture",
  translationMode: "minimal",
};

test("normalizes legacy web search names in tools and tool selectors only", async () => {
  // Given: the public Responses request uses the legacy preview tool name.
  const publicRequest = {
    input: "Search for a fixture page.",
    tools: [
      { type: "web_search_preview" },
      {
        type: "web_search",
        allowed_tools: [
          "web_search_preview",
          { type: "web_search_preview" },
          { type: "web_search" },
        ],
        parameters: { properties: { type: "web_search_preview" } },
      },
    ],
    tool_choice: {
      type: "allowed_tools",
      allowed_tools: ["web_search_preview", { type: "web_search_preview" }],
      tools: [{ type: "web_search_preview" }],
    },
  };
  // When: minimal request adaptation runs.
  const adapted = adaptRequest(
    await new Response(JSON.stringify(publicRequest)).arrayBuffer(),
    options,
  );
  // Then: tool names normalize while unrelated nested payload values remain exact.
  const body = JSON.parse(adapted.body);
  expect(body).toMatchObject({
    tools: [
      { type: "web_search" },
      {
        type: "web_search",
        allowed_tools: ["web_search", { type: "web_search" }, { type: "web_search" }],
        parameters: { properties: { type: "web_search_preview" } },
      },
    ],
    tool_choice: {
      type: "allowed_tools",
      allowed_tools: ["web_search", { type: "web_search" }],
      tools: [{ type: "web_search" }],
    },
  });
});
