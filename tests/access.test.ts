import { describe, expect, test } from "bun:test";
import { authorized, checkOrigin } from "../src/server/access";

const token = "local-server-token-for-testing-0123456789";
describe("local server access boundary", () => {
  test("requires the server token and rejects a Codex or wrong key", () => {
    expect(authorized(new Request("http://localhost/v1/models"), token)).toBe(false);
    expect(
      authorized(
        new Request("http://localhost/v1/models", { headers: { authorization: token } }),
        token,
      ),
    ).toBe(false);
    expect(
      authorized(
        new Request("http://localhost/v1/models", { headers: { authorization: "Bearer wrong" } }),
        token,
      ),
    ).toBe(false);
    expect(
      authorized(
        new Request("http://localhost/v1/models", {
          headers: { authorization: `Bearer ${token}` },
        }),
        token,
      ),
    ).toBe(true);
  });
  test("allows same-origin UI and CLI while rejecting foreign origins", () => {
    expect(checkOrigin(new Request("http://100.64.0.1:8787/v1/responses"))).toBe(true);
    expect(
      checkOrigin(
        new Request("http://100.64.0.1:8787/v1/responses", {
          headers: { origin: "http://100.64.0.1:8787" },
        }),
      ),
    ).toBe(true);
    expect(
      checkOrigin(
        new Request("http://100.64.0.1:8787/v1/responses", {
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toBe(false);
  });
  test("only accepts browser token subprotocol for an actual upgrade", () => {
    const headers = { "sec-websocket-protocol": `oai-codex, oai-codex-token.${token}` };
    expect(authorized(new Request("http://localhost/v1/responses", { headers }), token)).toBe(
      false,
    );
    expect(
      authorized(
        new Request("http://localhost/v1/responses", {
          headers: { ...headers, upgrade: "websocket" },
        }),
        token,
      ),
    ).toBe(true);
  });
});
