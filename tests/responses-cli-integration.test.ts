import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = new URL("../src/cli/main.ts", import.meta.url).pathname;

function response(id: string, text: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1_789_900_000,
    model: "fixture-model",
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

test("runs the numbered previous-response scenario through the CLI with its lifecycle runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "responses-cli-integration-"));
  let secret = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      if (body.includes("previous_response_id")) {
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: response("resp_second", secret) })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const found = body.match(/LIFECYCLE_PREVIOUS_[0-9a-f]+/);
      if (found) secret = found[0];
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: response("resp_first", "ACK") })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const keyFile = join(directory, "token");
  const configFile = join(directory, "config.json");
  const reports = join(directory, "reports");
  await writeFile(keyFile, "fixture-secret\n");
  await writeFile(
    configFile,
    JSON.stringify({
      server: { host: "127.0.0.1", port: server.port },
      proxy: { defaultModel: "fixture-model" },
      auth: { tokenFile: keyFile },
    }),
  );
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        main,
        "--config",
        configFile,
        "test",
        "responses",
        "--scenario",
        "previous-response",
        "--base-url",
        `http://127.0.0.1:${server.port}/v1`,
        "--output-dir",
        reports,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, detail: stdout + stderr }).toEqual({
      exitCode: 0,
      detail: expect.any(String),
    });
    const reportName = (await readdir(reports))[0];
    if (!reportName) throw new TypeError("Missing lifecycle report");
    const report = JSON.parse(await readFile(join(reports, reportName), "utf8"));
    expect(report).toMatchObject({
      scenario: "previous-response",
      verdict: "passed",
      functional_passed: true,
    });
    expect(stdout + stderr).not.toContain("fixture-secret");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
