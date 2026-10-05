import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../api-tests/responses/test_stream.py", import.meta.url).pathname;
const message = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "TEST_OK", annotations: [] }],
};
const response = {
  id: "resp_fixture",
  object: "response",
  created_at: 1789900000,
  model: "fixture-model",
  status: "completed",
  error: null,
  parallel_tool_calls: true,
  tool_choice: "auto",
  tools: [],
  output: [message],
  usage: {
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};
const location = { output_index: 0, content_index: 0, item_id: "msg_fixture", logprobs: [] };
const events = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { ...response, status: "in_progress", output: [], usage: null },
  },
  { type: "response.output_text.delta", sequence_number: 1, ...location, delta: "TEST_" },
  { type: "response.output_text.delta", sequence_number: 2, ...location, delta: "OK" },
  { type: "response.output_text.done", sequence_number: 3, ...location, text: "TEST_OK" },
  { type: "response.completed", sequence_number: 4, response },
];
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
for (const scenario of [
  { name: "valid stream", wire: events.map(sse).join(""), pass: true },
  { name: "missing completion", wire: events.slice(0, -1).map(sse).join(""), pass: false },
  {
    name: "inconsistent text",
    wire: events.map(sse).join("").replace('"delta":"OK"', '"delta":"NO"'),
    pass: false,
  },
  { name: "invalid event JSON", wire: sse(events[0]) + "data: {broken\n\n", pass: false },
  {
    name: "out of order sequence",
    wire: events.map(sse).join("").replace('"sequence_number":2', '"sequence_number":0'),
    pass: false,
  },
]) {
  test(`stream CLI detects ${scenario.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "stream-cli-"));
    const bodies: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.text());
        return new Response(scenario.wire, { headers: { "content-type": "text/event-stream" } });
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
      expect({ code, detail: code === (scenario.pass ? 0 : 1) ? "" : stdout + stderr }).toEqual({
        code: scenario.pass ? 0 : 1,
        detail: "",
      });
      const file = (await readdir(directory))[0];
      if (!file) throw new TypeError("Missing report");
      const raw = await readFile(join(directory, file), "utf8");
      const report: unknown = JSON.parse(raw);
      expect(report).toMatchObject({
        technical_passed: scenario.pass,
        response_body: scenario.wire,
        request_body: bodies[0],
      });
      expect(raw + stdout + stderr).not.toContain("fixture-secret");
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0] ?? "null")).toMatchObject({
        stream: true,
        store: false,
        model: "fixture-model",
      });
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
}

test("receives a text fragment before the server releases the end of the stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-progress-"));
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(events.slice(0, 2).map(sse).join("")));
            await release.promise;
            controller.enqueue(new TextEncoder().encode(events.slice(2).map(sse).join("")));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
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
  const reader = child.stdout.getReader();
  const timeout = setTimeout(
    () => release.reject(new TypeError("No progress before stream completion")),
    15000,
  );
  try {
    const first = await Promise.race([
      reader.read(),
      release.promise.then(() => ({ done: true, value: undefined })),
    ]);
    expect(first.done).toBe(false);
    release.resolve();
    while (!(await reader.read()).done) {}
    expect(await child.exited).toBe(0);
  } finally {
    clearTimeout(timeout);
    release.resolve();
    reader.releaseLock();
    child.kill();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
