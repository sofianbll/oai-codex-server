import { expect, test } from "bun:test";

type Scenario =
  | "previous-response"
  | "conversation"
  | "store-json"
  | "retrieve"
  | "delete"
  | "background-cancel"
  | "compact";
type WireRequest = { method: string; path: string; body: Record<string, unknown> };
type FixtureMode = {
  scenario: Scenario;
  wrong: boolean;
  requests: WireRequest[];
  emptyDeleteResponse: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const script = new URL("../api-tests/responses/test_lifecycle.py", import.meta.url).pathname;
const outputResponse = (
  id: string,
  text: string,
  status = "completed",
): Record<string, unknown> => ({
  id,
  object: "response",
  created_at: 1789900000,
  model: "fixture-model",
  status,
  store: true,
  error: null,
  parallel_tool_calls: true,
  tool_choice: "auto",
  tools: [],
  output: [
    {
      id: `msg-${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});

const responseJson = (value: unknown, status = 200): Response => Response.json(value, { status });

const handle = async (request: Request, state: FixtureMode): Promise<Response> => {
  const url = new URL(request.url);
  const rawBody =
    request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
  let parsed: unknown = {};
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      parsed = {};
    }
  }
  const body = isRecord(parsed) ? parsed : {};
  state.requests.push({ method: request.method, path: url.pathname, body });
  const scenario = state.scenario;
  if (url.pathname.endsWith("/conversations") && request.method === "POST") {
    return responseJson({ id: "conv-fixture", object: "conversation", created_at: 1789900000 });
  }
  if (
    url.pathname.endsWith("/responses/input_tokens") ||
    url.pathname.endsWith("/responses/input_tokens/count")
  ) {
    return responseJson({ object: "response.input_tokens", input_tokens: 3 });
  }
  if (url.pathname.endsWith("/compact")) {
    const compacted = {
      id: "cmp-fixture",
      object: "response.compaction",
      created_at: 1789900000,
      output: [{ id: "compact-item", type: "compaction", encrypted_content: "opaque-fixture" }],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    return responseJson(compacted);
  }
  const responseMatch = url.pathname.match(/\/responses\/([^/]+)(?:\/(cancel|input_items))?$/);
  if (responseMatch !== null) {
    const [, id = "", action = ""] = responseMatch;
    if (action === "input_items") {
      const marker = state.wrong
        ? "unrelated input"
        : JSON.stringify(
            state.requests.find(
              (entry) =>
                entry.path.endsWith("/responses") &&
                JSON.stringify(entry.body).includes("LIFECYCLE_INPUT_ITEMS_"),
            )?.body ?? {},
          );
      return responseJson({
        object: "list",
        data: [{ type: "message", role: "user", content: [{ type: "input_text", text: marker }] }],
      });
    }
    if (action === "cancel")
      return responseJson(outputResponse(id, "", state.wrong ? "completed" : "cancelled"));
    if (request.method === "DELETE" && scenario === "delete" && state.emptyDeleteResponse)
      return new Response(null, { status: 204 });
    if (request.method === "DELETE")
      return responseJson({ id, object: "response.deleted", deleted: !state.wrong });
    if (request.method === "GET") {
      if (scenario === "delete")
        return responseJson({ error: { message: "not found", type: "not_found" } }, 404);
      if (scenario === "background-cancel")
        return responseJson(outputResponse(id, "", state.wrong ? "completed" : "cancelled"));
      return responseJson(outputResponse(id, "ACK"));
    }
  }
  if (request.method === "POST" && url.pathname.endsWith("/responses")) {
    const id =
      scenario === "previous-response" && JSON.stringify(body).includes("LIFECYCLE_PREVIOUS_")
        ? "resp-source"
        : `resp-${state.requests.length}`;
    let text = "ACK";
    if (scenario === "previous-response" && body["previous_response_id"] !== undefined)
      text = state.wrong ? "wrong recall" : findSecret(state.requests, "PREVIOUS");
    if (
      scenario === "conversation" &&
      typeof body["input"] === "string" &&
      body["input"].includes("remembered secret")
    )
      text = state.wrong ? "wrong recall" : findSecret(state.requests, "CONVERSATION");
    if (scenario === "compact" && Array.isArray(body["input"])) {
      const hasOutput = body["input"].some(
        (item) => isRecord(item) && item["type"] === "compaction",
      );
      if (!hasOutput) return responseJson({ error: { message: "compacted output missing" } }, 400);
      text = state.wrong ? "wrong recall" : findSecret(state.requests, "COMPACT");
    }
    if (scenario === "background-cancel")
      return responseJson(outputResponse(id, "", state.wrong ? "completed" : "queued"));
    const value = outputResponse(id, text);
    if (body["stream"] === true)
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: value })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    return responseJson(value);
  }
  return responseJson({ error: { message: `unhandled ${request.method} ${url.pathname}` } }, 404);
};

const findSecret = (requests: WireRequest[], kind: string): string => {
  const source = requests.find((entry) =>
    JSON.stringify(entry.body).includes(`LIFECYCLE_${kind}_`),
  );
  const match = JSON.stringify(source?.body ?? "").match(new RegExp(`LIFECYCLE_${kind}_[a-f0-9]+`));
  return match?.[0] ?? "missing-secret";
};

const runScenario = async (
  scenario: Scenario,
  wrong: boolean,
  emptyDeleteResponse = false,
): Promise<{ exitCode: number; report: Record<string, unknown>; requests: WireRequest[] }> => {
  const state: FixtureMode = { scenario, wrong, requests: [], emptyDeleteResponse };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => handle(request, state),
  });
  try {
    const outputDir = await Bun.$`mktemp -d`.text();
    const child = Bun.spawn(
      [
        "uv",
        "run",
        "--offline",
        script,
        "--scenario",
        scenario,
        "--base-url",
        `http://127.0.0.1:${server.port}/v1`,
        "--model",
        "fixture-model",
        "--output-dir",
        outputDir.trim(),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENAI_API_KEY: "local-fixture-key",
          UV_NO_PROGRESS: "1",
          PYTHONWARNINGS: "ignore",
        },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr, `${scenario} stderr; stdout=${stdout}`).toBe("");
    const reportPaths: string[] = [];
    for await (const path of new Bun.Glob("lifecycle-*.json").scan(outputDir.trim()))
      reportPaths.push(`${outputDir.trim()}/${path}`);
    if (reportPaths.length !== 1)
      throw new Error(`${scenario} expected one report, found ${reportPaths.length}: ${stdout}`);
    const parsedReport: unknown = await Bun.file(reportPaths[0] ?? "").json();
    const report = isRecord(parsedReport) ? parsedReport : {};
    await Bun.$`rm -rf ${outputDir.trim()}`;
    return { exitCode, report, requests: state.requests };
  } finally {
    server.stop(true);
  }
};

test("lifecycle scenarios prove their semantics over the SDK HTTP wire", async () => {
  const cases: Scenario[] = [
    "previous-response",
    "conversation",
    "retrieve",
    "store-json",
    "delete",
    "background-cancel",
    "compact",
  ];
  for (const scenario of cases) {
    const good = await runScenario(scenario, false);
    expect(
      good.exitCode,
      `${scenario} happy path ${JSON.stringify(good.report)} requests=${JSON.stringify(good.requests)}`,
    ).toBe(0);
    expect(good.report["verdict"], `${scenario} happy verdict`).toBe("passed");
    const bad = await runScenario(scenario, true);
    expect(bad.exitCode, `${scenario} wrong behavior`).toBe(1);
    expect(bad.report["verdict"], `${scenario} wrong verdict`).toBe("rejected");
  }
}, 120_000);

test("follow-up lifecycle requests carry real server state and avoid repeating the remembered secret", async () => {
  const previous = await runScenario("previous-response", false);
  const previousRequests = previous.requests.filter((entry) => entry.path.endsWith("/responses"));
  const sourceSecret = findSecret(previousRequests, "PREVIOUS");
  const follow = previousRequests.find((entry) => entry.body["previous_response_id"] !== undefined);
  expect(follow?.body["previous_response_id"]).toBe("resp-source");
  expect(JSON.stringify(follow?.body["input"])).not.toContain(sourceSecret);

  const conversation = await runScenario("conversation", false);
  const turns = conversation.requests.filter((entry) => entry.path.endsWith("/responses"));
  expect(turns).toHaveLength(2);
  expect(turns[0]?.body["conversation"]).toBe("conv-fixture");
  expect(turns[1]?.body["conversation"]).toBe("conv-fixture");
  expect(JSON.stringify(turns[1]?.body["input"])).not.toContain(findSecret(turns, "CONVERSATION"));

  const compact = await runScenario("compact", false);
  const compactInput = compact.requests.find((entry) => entry.path.endsWith("/compact"))?.body[
    "input"
  ];
  const replay = compact.requests.find(
    (entry) => entry.path.endsWith("/responses") && Array.isArray(entry.body["input"]),
  );
  expect(compactInput).toEqual([
    { role: "user", content: expect.stringContaining(findSecret(compact.requests, "COMPACT")) },
  ]);
  expect(JSON.stringify(replay?.body["input"])).toContain("opaque-fixture");
  expect(replay?.body["previous_response_id"]).toBeUndefined();
  expect(JSON.stringify(replay?.body["input"])).not.toContain(
    findSecret(compact.requests, "COMPACT"),
  );

  const deleted = await runScenario("delete", false);
  const deletedId = deleted.requests.find(
    (entry) => entry.path.endsWith("/responses") && entry.method === "POST",
  )?.body;
  const resourceIds: string[] = Array.isArray(deleted.report["resource_ids"])
    ? deleted.report["resource_ids"].filter((item): item is string => typeof item === "string")
    : [];
  const resourceId = resourceIds[0] ?? "";
  expect(
    deleted.requests.some(
      (entry) => entry.method === "DELETE" && entry.path.endsWith(`/responses/${resourceId}`),
    ),
  ).toBe(true);
  expect(
    deleted.requests.some(
      (entry) => entry.method === "GET" && entry.path.endsWith(`/responses/${resourceId}`),
    ),
  ).toBe(true);
  expect(deletedId).toBeDefined();
  expect(deleted.report["functional_passed"]).toBe(true);

  const deletedEmpty = await runScenario("delete", false, true);
  expect(deletedEmpty.exitCode).toBe(0);
  expect(deletedEmpty.report["functional_passed"]).toBe(true);
  expect(deletedEmpty.requests.some((entry) => entry.method === "DELETE")).toBe(true);
  expect(deletedEmpty.requests.some((entry) => entry.method === "GET")).toBe(true);

  const cancelled = await runScenario("background-cancel", false);
  const backgroundCreate = cancelled.requests.find((entry) => entry.path.endsWith("/responses"));
  expect(backgroundCreate?.body["background"]).toBe(true);
  expect(backgroundCreate?.body["store"]).toBe(true);
  expect(backgroundCreate?.body["stream"]).toBe(false);
  expect(
    cancelled.requests.some((entry) => entry.method === "POST" && entry.path.endsWith("/cancel")),
  ).toBe(true);
}, 30_000);

test("storage probes request persistence and compaction replay omits null SDK fields", async () => {
  for (const scenario of ["retrieve", "delete"] as const) {
    const result = await runScenario(scenario, false);
    const creation = result.requests.find((entry) => entry.path.endsWith("/responses"));
    expect(creation?.body["store"]).toBe(true);
  }
  const compact = await runScenario("compact", false);
  const replay = compact.requests.find((entry) => entry.path.endsWith("/responses"));
  expect(JSON.stringify(replay?.body)).not.toContain('"created_by":null');
}, 30_000);
