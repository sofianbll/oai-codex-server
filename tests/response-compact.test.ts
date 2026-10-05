import { expect, test } from "bun:test";
import { compactResponse } from "../src/server/response-compact";
import type { CredentialProvider, ProxyOptions } from "../src/shared/contracts";

const options: ProxyOptions = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  timeoutMs: 2_000,
  maxBodyBytes: 1024 * 1024,
  defaultModel: "fixture-model",
  clientVersion: "0.0.1-fixture",
  translationMode: "minimal",
};
const credentials: CredentialProvider = async () => ({
  accessToken: "fixture-token",
  accountId: "fixture",
});
const encryptedContent = "opaque-encrypted-compaction-fixture";

test("translates public compact requests through native compaction trigger and preserves output", async () => {
  // Given: a public compact request and a native completed response with an opaque compaction item.
  let forwarded: Request | undefined;
  const request = new Request("http://gateway.test/v1/responses/compact?trace=1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model: "fixture-model", input: "keep this history" }),
  });
  const relay = async (
    nativeRequest: Request,
    relayOptions: ProxyOptions,
    relayCredentials: CredentialProvider,
  ) => {
    forwarded = nativeRequest;
    expect(relayOptions).toBe(options);
    expect(relayCredentials).toBe(credentials);
    return Response.json({
      id: "resp_compacted",
      created_at: 1_789_900_000,
      status: "completed",
      output: [
        { id: "msg_history", type: "message", role: "user", content: [] },
        { id: "cmp_fixture", type: "compaction", encrypted_content: encryptedContent },
      ],
      usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
    });
  };

  // When: the public compact route delegates to the native Responses stream path.
  const response = await compactResponse(request, options, credentials, relay);

  // Then: native input gains one trigger and the public envelope preserves opaque output and usage.
  expect(forwarded).toBeDefined();
  expect(new URL(forwarded?.url ?? "").pathname).toBe("/v1/responses");
  expect(new URL(forwarded?.url ?? "").search).toBe("?trace=1");
  const nativeBody = await forwarded?.json();
  expect(nativeBody).toMatchObject({
    input: [
      { role: "user", content: [{ type: "input_text", text: "keep this history" }] },
      { type: "compaction_trigger" },
    ],
    stream: false,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: "resp_compacted",
    created_at: 1_789_900_000,
    object: "response.compaction",
    output: [
      { id: "msg_history", type: "message", role: "user", content: [] },
      { id: "cmp_fixture", type: "compaction", encrypted_content: encryptedContent },
    ],
    usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
  });
});

test("does not fabricate a compaction item when the native result omits one", async () => {
  // Given: a successful native response without an opaque compaction result.
  const request = new Request("http://gateway.test/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({ input: [{ role: "user", content: [] }] }),
  });

  // When: compaction adaptation receives that response.
  const operation = compactResponse(request, options, credentials, async () =>
    Response.json({
      id: "resp_missing_compaction",
      created_at: 1_789_900_000,
      status: "completed",
      output: [],
      usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
    }),
  );

  // Then: the adapter fails closed instead of inventing encrypted output.
  await expect(operation).rejects.toMatchObject({
    status: 502,
    code: "invalid_compaction_response",
  });
});
