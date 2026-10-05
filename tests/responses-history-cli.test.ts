import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const script = new URL("../api-tests/responses/test_history.py", import.meta.url).pathname;
const requestSchema = z.object({
  model: z.string(),
  stream: z.literal(false),
  store: z.literal(false),
  input: z.array(z.object({ role: z.string(), content: z.string() })),
});
function response(text: string) {
  return {
    id: "resp_fixture",
    object: "response",
    created_at: 1789900000,
    model: "fixture-model",
    status: "completed",
    error: null,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    output: [
      {
        id: "msg_fixture",
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
for (const scenario of [
  {
    name: "remembered context",
    wrong: false,
    invalid: false,
    calls: 2,
    technical: true,
    behavior: true,
    code: 0,
  },
  {
    name: "forgotten context",
    wrong: true,
    invalid: false,
    calls: 2,
    technical: true,
    behavior: false,
    code: 1,
  },
  {
    name: "invalid first response",
    wrong: false,
    invalid: true,
    calls: 1,
    technical: false,
    behavior: null,
    code: 1,
  },
]) {
  test(`history CLI distinguishes ${scenario.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "history-cli-"));
    const requests: z.infer<typeof requestSchema>[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const raw: unknown = await request.json();
        expect(raw).not.toHaveProperty("previous_response_id");
        expect(raw).not.toHaveProperty("conversation");
        const body = requestSchema.parse(raw);
        requests.push(body);
        if (scenario.invalid) return Response.json({ object: "response" });
        const code = requests[0]?.input[0]?.content.match(/CONTEXT_[0-9a-f]+/)?.[0];
        if (!code) throw new TypeError("Missing context marker");
        return Response.json(
          response(requests.length === 1 ? "ACK" : scenario.wrong ? "UNKNOWN" : code),
        );
      },
    });
    try {
      const child = Bun.spawn(
        [
          "uv",
          "run",
          script,
          "--base-url",
          `http://127.0.0.1:${server.port}/v1`,
          "--model",
          "fixture-model",
          "--output-dir",
          directory,
        ],
        {
          env: { ...process.env, OPENAI_API_KEY: "fixture-secret" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, detail: code === scenario.code ? "" : stdout + stderr }).toEqual({
        code: scenario.code,
        detail: "",
      });
      const file = (await readdir(directory))[0];
      if (!file) throw new TypeError("Missing report");
      const raw = await readFile(join(directory, file), "utf8");
      const report: unknown = JSON.parse(raw);
      expect(report).toMatchObject({
        technical_passed: scenario.technical,
        behavior_passed: scenario.behavior,
        exit_code: scenario.code,
      });
      expect(raw + stdout + stderr).not.toContain("fixture-secret");
      expect(requests).toHaveLength(scenario.calls);
      if (scenario.calls === 2) {
        expect(requests[1]?.input).toHaveLength(3);
        expect(requests[1]?.input[0]).toEqual(requests[0]?.input[0]);
        expect(requests[1]?.input[1]).toEqual({ role: "assistant", content: "ACK" });
        expect(requests[1]?.input[2]?.role).toBe("user");
        expect(requests[1]?.input[2]?.content).not.toMatch(/CONTEXT_[0-9a-f]+/);
      }
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
}
