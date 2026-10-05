import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { eventSchema, JsonObject } from "../src/ui/schemas";

type StreamEvent = z.infer<typeof eventSchema>;

type Scenario = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly expected: string;
  readonly path: string;
  readonly method: string;
  readonly body: JsonObject;
  readonly check: "exact" | "json" | "text" | "tokens" | "compact" | "manual";
  readonly expectedText?: string;
};
type Evaluate = (
  scenario: Scenario,
  result: {
    readonly data: string;
    readonly streamed: boolean;
    readonly events: readonly StreamEvent[];
  },
) => {
  readonly technical: string;
  readonly behavior: string;
  readonly text: string;
  readonly detail: string;
};
const path = "../src/ui/test-verdict.ts";
const available = await Bun.file(new URL(path, import.meta.url)).exists();
const module = available ? await import(path) : {};
const implementation = z
  .object({ evaluateResult: z.custom<Evaluate>((value) => typeof value === "function") })
  .safeParse(module);
const scenario: Scenario = {
  id: "simple",
  title: "Simple",
  description: "",
  expected: "TEST_OK",
  path: "/v1/responses",
  method: "POST",
  body: {},
  check: "exact",
  expectedText: "TEST_OK",
};
function evaluate(
  value: unknown,
  check: Scenario["check"] = "exact",
  events: readonly StreamEvent[] = [],
  streamed = false,
) {
  if (!implementation.success) throw new TypeError("evaluateResult must be exported as a function");
  return implementation.data.evaluateResult(
    { ...scenario, check, body: { stream: streamed } },
    { data: typeof value === "string" ? value : JSON.stringify(value), events, streamed },
  );
}
const completed = (text: string) => ({
  id: "resp_test",
  object: "response",
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
});

describe("Responses verdict", () => {
  test("exports the evaluator when the module is discovered", () => {
    // Given: the module namespace. When: inspecting its contract. Then: a callable exists.
    expect(implementation.success).toBe(true);
  });
  test("passes exact output when completed", () => {
    // Given: completed response. When: evaluating. Then: both checks pass.
    const result = evaluate(completed("TEST_OK"));
    expect([result.technical, result.behavior, result.text]).toEqual([
      "passed",
      "passed",
      "TEST_OK",
    ]);
  });
  test("fails behavior when completed text differs", () => {
    // Given: wrong text. When: evaluating. Then: transport is valid but behavior fails.
    const result = evaluate(completed(" TEST_OK "));
    expect([result.technical, result.behavior]).toEqual(["passed", "failed"]);
  });
  for (const [name, value] of Object.entries({
    html: "<html>OK</html>",
    incomplete: { ...completed("TEST_OK"), status: "incomplete" },
    empty: {},
    error: { error: { message: "failed" } },
    malformed: {
      ...completed("TEST_OK"),
      output: [{ type: "message", content: [{ type: "output_text", text: 42 }] }],
    },
  })) {
    test(`fails technical verification when ${name}`, () => {
      // Given: invalid response. When: evaluating. Then: technical failure.
      expect(evaluate(value).technical).toBe("failed");
    });
  }
  test("fails when streamed deltas have no terminal event", () => {
    // Given: a truncated stream. When: evaluating. Then: technical failure.
    expect(
      evaluate(
        completed("TEST_OK"),
        "exact",
        [{ type: "response.output_text.delta", delta: "TEST_OK" }],
        true,
      ).technical,
    ).toBe("failed");
  });
  test("passes when a stream has a valid completed terminal response", () => {
    // Given: a completed stream. When: evaluating. Then: output passes.
    expect(
      evaluate(
        "",
        "exact",
        [
          { type: "response.output_text.delta", delta: "TEST_OK" },
          { type: "response.completed", response: completed("TEST_OK") },
        ],
        true,
      ).behavior,
    ).toBe("passed");
  });
  for (const requested of [true, false]) {
    test(`fails when requested stream=${requested} receives the other transport`, () => {
      // Given: an explicit transport request. When: the other transport completes. Then: fail.
      if (!implementation.success) throw new TypeError("evaluateResult must be exported");
      const result = implementation.data.evaluateResult(
        { ...scenario, body: { stream: requested } },
        {
          data: JSON.stringify(completed("TEST_OK")),
          streamed: !requested,
          events: [
            { type: "response.output_text.delta", delta: "TEST_OK" },
            { type: "response.completed", response: completed("TEST_OK") },
          ],
        },
      );
      expect(result.technical).toBe("failed");
    });
  }
  for (const delta of [undefined, "", 42]) {
    test(`fails when terminal text has no valid text delta (${delta})`, () => {
      // Given: terminal text without a nonempty text delta. When: evaluating SSE. Then: fail.
      const events: StreamEvent[] = [
        { type: "response.completed", response: completed("TEST_OK") },
      ];
      if (delta !== undefined) events.unshift({ type: "response.output_text.delta", delta });
      expect(evaluate("", "exact", events, true).technical).toBe("failed");
    });
  }
  for (const type of ["error", "response.failed", "response.incomplete"]) {
    test(`fails when stream contains ${type} even with completion`, () => {
      // Given: an error event followed by completion. When: evaluating. Then: failure persists.
      expect(
        evaluate(
          "",
          "exact",
          [{ type }, { type: "response.completed", response: completed("TEST_OK") }],
          true,
        ).technical,
      ).toBe("failed");
    });
  }
  test("requires valid terminal response structure", () => {
    // Given: a completion with no response. When: evaluating. Then: failure.
    expect(evaluate("", "exact", [{ type: "response.completed" }], true).technical).toBe("failed");
  });
  test("accepts tool-only completion for manual verification", () => {
    // Given: a completed tool call. When: evaluating. Then: technical pass, manual behavior.
    const result = evaluate(
      {
        ...completed(""),
        output: [
          { type: "function_call", name: "get_weather", call_id: "call_1", arguments: "{}" },
        ],
      },
      "manual",
    );
    expect([result.technical, result.behavior]).toEqual(["passed", "manual"]);
  });
  test("rejects empty output for text verification", () => {
    // Given: empty completed output. When: evaluating. Then: behavior fails.
    expect(evaluate({ ...completed(""), output: [] }, "text").behavior).toBe("failed");
  });
  for (const text of ['{"ok":true}', '{"ok":false}', "not json"]) {
    test(`checks structured output semantics for ${text}`, () => {
      // Given: model text. When: checking the structured fixture. Then: only expected schema succeeds.
      expect(evaluate(completed(text), "json").behavior).toBe(
        text === '{"ok":true}' ? "passed" : "failed",
      );
    });
  }
  for (const input_tokens of [0, 12, -1, "12"]) {
    test(`validates token count ${JSON.stringify(input_tokens)}`, () => {
      // Given: token count. When: evaluating. Then: only nonnegative integers pass.
      expect(evaluate({ object: "response.input_tokens", input_tokens }, "tokens").technical).toBe(
        typeof input_tokens === "number" && input_tokens >= 0 ? "passed" : "failed",
      );
    });
  }
  test("accepts a compact response with compacted output", () => {
    // Given: compact envelope. When: evaluating. Then: succeeds.
    expect(
      evaluate(
        {
          id: "resp_c",
          object: "response.compaction",
          output: [{ type: "compaction", encrypted_content: "encrypted" }],
        },
        "compact",
      ).technical,
    ).toBe("passed");
  });
  test("rejects unrelated JSON from compact endpoint", () => {
    // Given: arbitrary JSON. When: evaluating. Then: fails.
    expect(evaluate({ ok: true }, "compact").technical).toBe("failed");
  });
});
