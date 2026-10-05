import { expect, test } from "bun:test";
import { z } from "zod";

const MODEL = "gpt-6-astra";
const LOCAL_KEY = "local-test-secret-key";
const INLINE_SECRET = "inline-test-secret-value";
const inputSchema = z.looseObject({ stream: z.boolean().optional() });
const reportSchema = z.looseObject({
  request_method: z.string().nullable(),
  response_status: z.number().nullable(),
  response_content_type: z.string().nullable(),
  response_body: z.string().nullable(),
  request_headers: z.record(z.string(), z.string()),
  request_body: z.string().nullable(),
  strict_response_valid: z.boolean().nullable(),
  error_classification: z.string(),
  technical_passed: z.boolean(),
  behavior_passed: z.boolean().nullable(),
});

const responseBody = {
  id: "resp_local_fixture",
  object: "response",
  created_at: 1_758_000_000,
  model: MODEL,
  output: [],
  parallel_tool_calls: true,
  tool_choice: "auto",
  tools: [],
  status: "completed",
};

test("captures SDK JSON, completed SSE, generic calls, and HTTP errors with redaction", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [] });
      if (url.pathname === "/v1/responses/nonjson")
        return new Response("upstream text error", {
          status: 422,
          headers: { "content-type": "text/plain" },
        });
      if (url.pathname === "/v1/responses/invalid")
        return Response.json({ id: "resp_invalid", object: "response" });
      const parsed = inputSchema.safeParse(await request.json());
      if (parsed.success && parsed.data.stream === true) {
        const event = JSON.stringify({ type: "response.completed", response: responseBody });
        return new Response(`event: response.completed\ndata: ${event}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(responseBody);
    },
  });

  try {
    const driver = `
import json
import sys
sys.path.insert(0, "api-tests/responses")
from lifecycle_capture import CaptureSession

base_url = sys.argv[1]
with CaptureSession(base_url=base_url, api_key="${LOCAL_KEY}", extra_secrets=("${INLINE_SECRET}",)) as session:
    created = session.call(
        lambda client: client.responses.create(
            model="${MODEL}", input="fixture", store=False,
            metadata={"api_key": "${INLINE_SECRET}"},
        ),
        validate_response=True,
        behavior_check=lambda value: value.status == "completed" if value is not None else None,
    )
    streamed = session.stream(
        lambda client: client.responses.create(model="${MODEL}", input="fixture", store=False, stream=True),
        behavior_check=lambda value: value.status == "completed" if value is not None else None,
    )
    generic = session.call(lambda client: client.models.list())
    failed = session.call(lambda client: client.responses.retrieve("nonjson"), validate_response=True)
    invalid = session.call(lambda client: client.responses.retrieve("invalid"), validate_response=True)
    print(json.dumps([run.report.model_dump(mode="json") for run in (created, streamed, generic, failed, invalid)]))
`;
    const child = Bun.spawn(
      [
        "uv",
        "run",
        "--with",
        "openai==3.16.2",
        "--with",
        "pydantic>=2,<3",
        "--",
        "python",
        "-c",
        driver,
        `http://127.0.0.1:${server.port}/v1`,
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).not.toContain(LOCAL_KEY);
    expect(stdout).not.toContain(INLINE_SECRET);
    const reports = z.array(reportSchema).parse(JSON.parse(stdout));

    const [created, streamed, generic, failed, invalid] = reports;
    expect(created).toMatchObject({
      request_method: "POST",
      response_status: 200,
      strict_response_valid: true,
      technical_passed: true,
      behavior_passed: true,
    });
    expect(JSON.stringify(created)).toContain("[REDACTED]");
    expect(streamed).toMatchObject({
      response_status: 200,
      response_content_type: "text/event-stream",
      strict_response_valid: true,
      technical_passed: true,
      behavior_passed: true,
    });
    expect(generic).toMatchObject({ response_status: 200, technical_passed: true });
    expect(failed).toMatchObject({
      response_status: 422,
      response_content_type: "text/plain",
      response_body: "upstream text error",
      error_classification: "http_status",
      technical_passed: false,
      strict_response_valid: null,
    });
    expect(invalid).toMatchObject({
      response_status: 200,
      error_classification: "response_schema_error",
      strict_response_valid: false,
      technical_passed: false,
    });
  } finally {
    server.stop(true);
  }
});
