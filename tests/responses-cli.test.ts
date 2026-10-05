import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../api-tests/responses/test_create_text.py", import.meta.url).pathname;
const good = {
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
      content: [{ type: "output_text", text: "TEST_OK", annotations: [] }],
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

for (const scenario of [
  {
    name: "HTML instead of JSON",
    body: "<html>upstream error</html>",
    technical: false,
    behavior: null,
    code: 1,
  },
  { name: "conforming response", body: good, technical: true, behavior: true, code: 0 },
  {
    name: "invalid required type",
    body: { ...good, created_at: "yesterday" },
    technical: false,
    behavior: null,
    code: 1,
  },
  {
    name: "different text",
    body: {
      ...good,
      output: [
        { ...good.output[0], content: [{ type: "output_text", text: "Bonjour", annotations: [] }] },
      ],
    },
    technical: true,
    behavior: false,
    code: 1,
  },
  {
    name: "inconsistent usage",
    body: { ...good, usage: { ...good.usage, total_tokens: 99 } },
    technical: false,
    behavior: true,
    code: 1,
  },
  {
    name: "boolean counter",
    body: { ...good, usage: { ...good.usage, input_tokens: true } },
    technical: false,
    behavior: null,
    code: 1,
  },
]) {
  test(`reports separate verdicts for ${scenario.name}`, async () => {
    const output = await mkdtemp(join(tmpdir(), "responses-cli-"));
    const requests: Request[] = [];
    const bodies: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(request);
        bodies.push(await request.text());
        return typeof scenario.body === "string"
          ? new Response(scenario.body, { headers: { "content-type": "text/html" } })
          : Response.json(scenario.body);
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
          output,
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
      expect({ code, stderr: code === scenario.code ? "" : stderr }).toEqual({
        code: scenario.code,
        stderr: "",
      });
      const file = (await readdir(output))[0];
      if (!file) throw new TypeError("Missing report");
      const raw = await readFile(join(output, file), "utf8");
      const report: unknown = JSON.parse(raw);
      expect(report).toMatchObject({
        technical_passed: scenario.technical,
        behavior_passed: scenario.behavior,
        exit_code: scenario.code,
        request_body: bodies[0],
        response_body:
          typeof scenario.body === "string" ? scenario.body : JSON.stringify(scenario.body),
      });
      expect(raw + stdout + stderr).not.toContain("fixture-secret");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(new URL(requests[0]?.url ?? "http://invalid").pathname).toBe("/v1/responses");
      expect(JSON.parse(bodies[0] ?? "null")).toMatchObject({
        model: "fixture-model",
        stream: false,
        store: false,
      });
    } finally {
      server.stop(true);
      await rm(output, { recursive: true, force: true });
    }
  }, 60000);
}
