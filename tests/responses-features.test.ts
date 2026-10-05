import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const MODEL = "gpt-6-astra";
const LOCAL_KEY = "feature-fixture-key-never-log";
const ENCRYPTED_REASONING = "gAAAAA-encrypted-reasoning-fixture-secret";
const featureScript = new URL("../api-tests/responses/features.py", import.meta.url).pathname;
const requestSchema = z.record(z.string(), z.unknown());
const attemptSchema = z.looseObject({
  request_body: z.string(),
  response_body: z.string().nullable(),
  output_text: z.string().nullable(),
  status: z.number().nullable(),
  verdict: z.string(),
  detail: z.string(),
  usage: z
    .looseObject({
      raw_usage_present: z.boolean(),
      input_tokens: z.number().int().nullable(),
      cached_read: z.looseObject({
        state: z.enum(["absent", "null", "value", "malformed"]),
        value: z.number().int().nullable(),
      }),
      cache_write: z.looseObject({
        state: z.enum(["absent", "null", "value", "malformed"]),
        value: z.number().int().nullable(),
      }),
    })
    .nullable()
    .optional(),
});
const reportSchema = z.looseObject({
  sdk_version: z.string(),
  attempts: z.array(attemptSchema),
  technical_passed: z.boolean().nullable(),
  behavior_passed: z.boolean().nullable(),
  exit_code: z.number(),
});
type FeatureReport = z.infer<typeof reportSchema>;
type FeatureRequest = z.infer<typeof requestSchema>;
type WireHandler = (request: FeatureRequest, callNumber: number) => Response;

function completed(text: string, id: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1_789_900_000,
    model: MODEL,
    status: "completed",
    error: null,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    output: [
      {
        id: `msg_${id}`,
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
  };
}

function completedWithUsage(
  text: string,
  id: string,
  usage: Record<string, unknown>,
): Record<string, unknown> {
  return { ...completed(text, id), usage };
}

function message(text: string, id: string): Record<string, unknown> {
  return {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function fixture(handler: WireHandler) {
  const requests: FeatureRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const parsed = requestSchema.safeParse(await request.json());
      if (!parsed.success)
        return Response.json({ error: "invalid fixture request" }, { status: 400 });
      requests.push(parsed.data);
      return handler(parsed.data, requests.length);
    },
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("Fixture server did not bind an ephemeral port");
  }
  return { port, requests, server };
}

async function runScenario(
  baseUrl: string,
  scenario: "json-schema" | "function" | "parallel-tools" | "reasoning-replay" | "cache",
): Promise<{
  readonly code: number;
  readonly report: FeatureReport;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const outputDir = mkdtempSync(join(tmpdir(), "responses-features-report-"));
  try {
    const child = Bun.spawn(
      [
        "uv",
        "run",
        featureScript,
        "--scenario",
        scenario,
        "--base-url",
        baseUrl,
        "--model",
        MODEL,
        "--output-dir",
        outputDir,
      ],
      {
        env: { ...process.env, OPENAI_API_KEY: LOCAL_KEY, UV_NO_PROGRESS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const reportName = readdirSync(outputDir).find((name) => name.endsWith(".json"));
    if (!reportName) throw new Error(`Feature driver wrote no report: ${stderr}`);
    const report = reportSchema.parse(
      JSON.parse(readFileSync(join(outputDir, reportName), "utf8")),
    );
    expect(report.sdk_version).toBe("3.16.2");
    return { code, report, stdout, stderr };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

function functionCall(name: string, callId: string): Record<string, unknown> {
  return {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: "{}",
    status: "completed",
  };
}

function encryptedContents(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(encryptedContents);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "encrypted_content" && typeof child === "string" ? [child] : encryptedContents(child),
  );
}

test("feature driver distinguishes valid JSON Schema output from a wrong answer", async () => {
  // Given: a local Responses endpoint that returns a controlled JSON answer.
  let answer = '{"answer":42}';
  const server = fixture(() => Response.json(completed(answer, "resp_schema")));
  try {
    // When: the driver checks a valid strict JSON Schema result.
    const valid = await runScenario(baseUrl(server.port), "json-schema");
    // Then: transport and exact schema semantics pass.
    expect(valid.code).toBe(0);
    expect(valid.report).toMatchObject({
      technical_passed: true,
      behavior_passed: true,
      exit_code: 0,
    });
    expect(server.requests[0]?.["text"]).toMatchObject({ format: { type: "json_schema" } });

    // When: the same driver receives JSON that violates the answer constraint.
    answer = '{"answer":41}';
    const invalid = await runScenario(baseUrl(server.port), "json-schema");
    // Then: a valid HTTP/SDK response still fails behavior and exits unsuccessfully.
    expect(invalid.code).toBe(1);
    expect(invalid.report).toMatchObject({
      technical_passed: true,
      behavior_passed: false,
      exit_code: 1,
    });
  } finally {
    server.server.stop(true);
  }
});

test("feature driver requires two-turn function results and rejects a one-call parallel response", async () => {
  // Given: a local endpoint that records the SDK's function call and result requests.
  let finalText = "42";
  const server = fixture((request) => {
    if (!Array.isArray(request["input"])) {
      const output = [functionCall("answer", "call_one")];
      return Response.json({ ...completed("", "resp_call"), output });
    }
    return Response.json(completed(finalText, "resp_result"));
  });
  try {
    // When: the function scenario receives one call followed by its matching result.
    const passed = await runScenario(baseUrl(server.port), "function");
    // Then: the driver sends both turns and accepts only the exact result.
    expect(passed.code).toBe(0);
    expect(passed.report).toMatchObject({
      technical_passed: true,
      behavior_passed: true,
      exit_code: 0,
    });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.["input"]).toEqual([
      { type: "function_call", call_id: "call_one", name: "answer", arguments: "{}" },
      { type: "function_call_output", call_id: "call_one", output: "42" },
    ]);

    // When: a completed second response contains the wrong function result.
    finalText = "41";
    const wrongResult = await runScenario(baseUrl(server.port), "function");
    // Then: successful parsing does not turn the wrong answer into a behavior pass.
    expect(wrongResult.code).toBe(1);
    expect(wrongResult.report).toMatchObject({
      technical_passed: true,
      behavior_passed: false,
      exit_code: 1,
    });

    // When: parallel-tools asks for two calls but the upstream emits only one.
    finalText = "42";
    const parallel = await runScenario(baseUrl(server.port), "parallel-tools");
    // Then: the driver records a semantic failure despite a valid second response.
    expect(parallel.code).toBe(1);
    expect(parallel.report).toMatchObject({
      technical_passed: true,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(server.requests.at(-2)?.["tools"]).toHaveLength(2);
    expect(server.requests.at(-2)?.["parallel_tool_calls"]).toBe(true);
  } finally {
    server.server.stop(true);
  }
});

test("feature driver redacts nested encrypted reasoning and an echoed API key", async () => {
  // Given: a local response that echoes the fixture key and includes encrypted reasoning.
  const server = fixture((_request, callNumber) => {
    if (callNumber === 1) {
      return Response.json({
        ...completed(LOCAL_KEY, "resp_reasoning_first"),
        output: [
          {
            id: "rs_fixture",
            type: "reasoning",
            content: [],
            encrypted_content: ENCRYPTED_REASONING,
            summary: [],
          },
          message(LOCAL_KEY, "resp_reasoning_message"),
        ],
      });
    }
    return Response.json(completed("REPLAY_OK", "resp_reasoning_second"));
  });
  try {
    // When: the driver records the response and replays its reasoning item.
    const run = await runScenario(baseUrl(server.port), "reasoning-replay");
    const serialized = JSON.stringify(run.report);
    const firstResponseBody = run.report.attempts[0]?.response_body;
    if (firstResponseBody === null || firstResponseBody === undefined)
      throw new Error("The reasoning response body was not captured");
    const parsedFirstResponse: unknown = JSON.parse(firstResponseBody);
    // Then: the report masks both nested secrets in the response and replay request.
    expect(run.code).toBe(0);
    expect(run.report).toMatchObject({
      technical_passed: true,
      behavior_passed: true,
      exit_code: 0,
    });
    expect(serialized).not.toContain(LOCAL_KEY);
    expect(serialized).not.toContain(ENCRYPTED_REASONING);
    expect(serialized).not.toContain("gAAAAA");
    expect(serialized).toContain("[REDACTED]");
    expect(encryptedContents(parsedFirstResponse)).toEqual(["[REDACTED]"]);
    expect(server.requests).toHaveLength(2);
  } finally {
    server.server.stop(true);
  }
});

test("feature driver reports API rejection and transport failure without passing them", async () => {
  // Given: a local endpoint that rejects an otherwise valid SDK call.
  const server = fixture(() =>
    Response.json({ error: { message: "fixture rejected" } }, { status: 422 }),
  );
  try {
    // When: JSON Schema verification receives an upstream API rejection.
    const rejected = await runScenario(baseUrl(server.port), "json-schema");
    // Then: rejection remains a technical failure, not a compatibility pass.
    expect(rejected.code).toBe(1);
    expect(rejected.report).toMatchObject({
      technical_passed: false,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(rejected.report.attempts[0]).toMatchObject({
      status: 422,
      verdict: "upstream_rejected",
    });
  } finally {
    server.server.stop(true);
  }

  // Given: a loopback port with no listener.
  const unavailable = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unused"),
  });
  const port = unavailable.port;
  unavailable.stop(true);
  if (port === undefined) throw new Error("Closed-port fixture did not bind an ephemeral port");
  // When: the driver attempts the same scenario against the closed port.
  const transport = await runScenario(`http://127.0.0.1:${port}/v1`, "json-schema");
  // Then: transport failure remains unavailable and cannot count as PASS.
  expect(transport.code).toBe(2);
  expect(transport.report).toMatchObject({
    technical_passed: false,
    behavior_passed: false,
    exit_code: 2,
  });
  expect(transport.report.attempts[0]).toMatchObject({
    status: null,
    verdict: "transport_unavailable",
  });
});

test("feature driver classifies malformed JSON schema and HTML 200 responses without crashing", async () => {
  // Given: an endpoint that first omits required JSON fields, then returns HTML with status 200.
  const server = fixture((_request, callNumber) => {
    if (callNumber === 1) {
      const invalidResponse = completed('{"answer":42}', "resp_missing_output");
      delete invalidResponse["output"];
      return Response.json(invalidResponse);
    }
    return new Response("<html>fixture error</html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  try {
    // When: the driver validates a status-200 JSON body with a missing required field.
    const malformed = await runScenario(baseUrl(server.port), "json-schema");
    // Then: it records a schema failure with status and exits normally as a failed test.
    expect(malformed.code).toBe(1);
    expect(malformed.report).toMatchObject({
      technical_passed: false,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(malformed.report.attempts[0]).toMatchObject({
      status: 200,
      verdict: "sdk_or_contract_invalid",
    });
    expect(malformed.report.attempts[0]?.["content_type"]).toStartWith("application/json");

    // When: the same driver receives HTML with status 200.
    const html = await runScenario(baseUrl(server.port), "json-schema");
    // Then: it rejects the media type as a technical failure rather than parsing or passing it.
    expect(html.code).toBe(1);
    expect(html.report).toMatchObject({
      technical_passed: false,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(html.report.attempts[0]).toMatchObject({
      status: 200,
      verdict: "http_or_content_type_invalid",
    });
    expect(html.report.attempts[0]?.["content_type"]).toStartWith("text/html");
    expect(html.report.attempts[0]?.["response_body"]).toContain("<html>fixture error</html>");
  } finally {
    server.server.stop(true);
  }
});

test("missing encrypted reasoning stays technically valid with behavior unavailable", async () => {
  // Given: an accepted response with no reasoning output item.
  const server = fixture(() => Response.json(completed("REASON_OK", "resp_no_reasoning")));
  try {
    // When: the driver requests encrypted reasoning for replay.
    const run = await runScenario(baseUrl(server.port), "reasoning-replay");
    // Then: the accepted response is technically valid while replay is unavailable.
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({
      technical_passed: true,
      behavior_passed: null,
      exit_code: 1,
    });
    expect(run.report.attempts[0]).toMatchObject({ verdict: "accepted" });
    expect(run.report.attempts[0]?.detail).toContain(
      "encrypted_content requested by include was not exposed",
    );
    expect(server.requests).toHaveLength(1);
  } finally {
    server.server.stop(true);
  }
});

test("cache scenario requires a positive second cached-read counter and reports raw zero", async () => {
  // Given: two accepted Responses with a cache-sized input but an explicit zero cached-read counter.
  const usage = {
    input_tokens: 2_048,
    output_tokens: 3,
    total_tokens: 2_051,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const server = fixture((_request, callNumber) =>
    Response.json(completedWithUsage("CACHE_OK", `resp_cache_zero_${callNumber}`, usage)),
  );
  try {
    // When: the cache probe repeats the same cache key and stable prefix.
    const run = await runScenario(baseUrl(server.port), "cache");
    // Then: valid text remains technical success, but zero cache evidence cannot pass behavior.
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({
      technical_passed: true,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(run.report.attempts[1]?.usage).toEqual({
      raw_usage_present: true,
      input_tokens: 2_048,
      cached_read: { state: "value", value: 0 },
      cache_write: { state: "value", value: 0 },
    });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.["prompt_cache_key"]).toBe(server.requests[1]?.["prompt_cache_key"]);
    expect(server.requests[0]?.["input"]).toBe(server.requests[1]?.["input"]);
  } finally {
    server.server.stop(true);
  }
});

test("cache scenario passes only with an observed positive cache read", async () => {
  const server = fixture((_request, callNumber) =>
    Response.json(
      completedWithUsage("CACHE_OK", `resp_cache_hit_${callNumber}`, {
        input_tokens: 2_048,
        output_tokens: 3,
        total_tokens: 2_051,
        input_tokens_details: {
          cached_tokens: callNumber === 1 ? 0 : 1_792,
          cache_write_tokens: callNumber === 1 ? 1_792 : 0,
        },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ),
  );
  try {
    const run = await runScenario(baseUrl(server.port), "cache");
    const firstInput = server.requests[0]?.["input"];
    const secondInput = server.requests[1]?.["input"];
    expect(run.code).toBe(0);
    expect(run.report).toMatchObject({
      technical_passed: true,
      behavior_passed: true,
      exit_code: 0,
    });
    expect(run.report.attempts[1]?.usage).toMatchObject({
      raw_usage_present: true,
      input_tokens: 2_048,
      cached_read: { state: "value", value: 1_792 },
      cache_write: { state: "value", value: 0 },
    });
    expect(typeof firstInput).toBe("string");
    expect(firstInput).toBe(secondInput);
    if (typeof firstInput !== "string")
      throw new Error("Cache fixture did not receive string input");
    expect(Buffer.byteLength(firstInput)).toBeGreaterThan(4_096);
  } finally {
    server.server.stop(true);
  }
});

test("cache scenario preserves absent counters as a contract failure", async () => {
  const server = fixture((_request, callNumber) =>
    Response.json(
      completedWithUsage("CACHE_OK", `resp_cache_absent_${callNumber}`, {
        input_tokens: 16,
        output_tokens: 3,
        total_tokens: 19,
        input_tokens_details: { cache_write_tokens: null },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ),
  );
  try {
    const run = await runScenario(baseUrl(server.port), "cache");
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({
      technical_passed: false,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(run.report.attempts[1]).toMatchObject({ verdict: "sdk_or_contract_invalid" });
    expect(run.report.attempts[1]?.usage).toEqual({
      raw_usage_present: true,
      input_tokens: 16,
      cached_read: { state: "absent", value: null },
      cache_write: { state: "null", value: null },
    });
  } finally {
    server.server.stop(true);
  }
});

test("cache scenario does not pass a low-input zero-read fixture", async () => {
  const server = fixture((_request, callNumber) =>
    Response.json(
      completedWithUsage("CACHE_OK", `resp_cache_short_${callNumber}`, {
        input_tokens: 16,
        output_tokens: 3,
        total_tokens: 19,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ),
  );
  try {
    const run = await runScenario(baseUrl(server.port), "cache");
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({
      technical_passed: true,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(run.report.attempts[1]?.usage).toMatchObject({
      input_tokens: 16,
      cached_read: { state: "value", value: 0 },
    });
  } finally {
    server.server.stop(true);
  }
});

test("cache scenario rejects positive reads when input totals are zero or smaller", async () => {
  const zeroInput = fixture((_request, callNumber) =>
    Response.json(
      completedWithUsage("CACHE_OK", `resp_cache_zero_input_${callNumber}`, {
        input_tokens: 0,
        output_tokens: 3,
        total_tokens: 3,
        input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ),
  );
  const smallerInput = fixture((_request, callNumber) =>
    Response.json(
      completedWithUsage("CACHE_OK", `resp_cache_too_large_${callNumber}`, {
        input_tokens: 8,
        output_tokens: 3,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 9, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ),
  );
  try {
    const zeroRun = await runScenario(baseUrl(zeroInput.port), "cache");
    const smallerRun = await runScenario(baseUrl(smallerInput.port), "cache");
    expect(zeroRun.report).toMatchObject({
      technical_passed: true,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(smallerRun.report).toMatchObject({
      technical_passed: true,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(zeroRun.report.attempts[1]?.usage).toMatchObject({
      input_tokens: 0,
      cached_read: { state: "value", value: 1 },
    });
    expect(smallerRun.report.attempts[1]?.usage).toMatchObject({
      input_tokens: 8,
      cached_read: { state: "value", value: 9 },
    });
  } finally {
    zeroInput.server.stop(true);
    smallerInput.server.stop(true);
  }
});

test("cache scenario exposes missing input totals and cannot pass them", async () => {
  const server = fixture(() =>
    Response.json(
      completedWithUsage("CACHE_OK", "resp_cache_missing_input", {
        output_tokens: 3,
        total_tokens: 3,
        input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ),
  );
  try {
    const run = await runScenario(baseUrl(server.port), "cache");
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({
      technical_passed: false,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(run.report.attempts[0]?.usage).toMatchObject({
      raw_usage_present: true,
      input_tokens: null,
      cached_read: { state: "value", value: 1 },
    });
  } finally {
    server.server.stop(true);
  }
});

test("cache scenario retains malformed raw counters as a contract failure", async () => {
  const server = fixture(() =>
    Response.json(
      completedWithUsage("CACHE_OK", "resp_cache_malformed", {
        input_tokens: 2_048,
        output_tokens: 3,
        total_tokens: 2_051,
        input_tokens_details: { cached_tokens: "not-an-integer", cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ),
  );
  try {
    const run = await runScenario(baseUrl(server.port), "cache");
    expect(run.code).toBe(1);
    expect(run.report).toMatchObject({
      technical_passed: false,
      behavior_passed: false,
      exit_code: 1,
    });
    expect(run.report.attempts[0]).toMatchObject({ verdict: "sdk_or_contract_invalid" });
    expect(run.report.attempts[0]?.usage).toEqual({
      raw_usage_present: true,
      input_tokens: 2_048,
      cached_read: { state: "malformed", value: null },
      cache_write: { state: "value", value: 0 },
    });
  } finally {
    server.server.stop(true);
  }
});
