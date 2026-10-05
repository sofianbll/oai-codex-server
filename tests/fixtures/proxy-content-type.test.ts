import { expect, test } from "bun:test";
import OpenAI from "openai";
import type { TranslationMode } from "../../src/shared/contracts";
import { completed, fixture, sse } from "./proxy-harness";

const finalResponse = completed();
const event = { type: "response.completed", response: finalResponse };
const wire = sse(event);

function responseBody(body: string, headers: Headers, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { headers, status },
  );
}

test.each([null, "text/plain; charset=utf-8", "text/event-stream"])(
  "returns SDK JSON helpers when Codex SSE has content type %s",
  async (contentType) => {
    // Given: Codex sends SSE with an absent or generic media type.
    const headers = new Headers();
    if (contentType) headers.set("content-type", contentType);
    headers.set("x-request-id", "req_header_fixture");
    const server = fixture(() => responseBody(wire, headers));
    try {
      // When: the official SDK requests a nonstreaming response.
      const client = new OpenAI({ apiKey: "fixture", baseURL: server.url, maxRetries: 0 });
      const { data, response } = await client.responses
        .create({ model: "fixture", input: "Hi", stream: false })
        .withResponse();
      // Then: the completed object and SDK output helper are available.
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(data).toMatchObject(finalResponse);
      expect(data.output_text).toBe("Bonjour 🌍");
      expect(response.headers.get("x-request-id")).toBe("req_header_fixture");
    } finally {
      server.close();
    }
  },
);

test.each([null, "text/plain; charset=utf-8"])(
  "labels successful minimal Responses SSE when Codex content type is %s",
  async (contentType) => {
    // Given: the upstream media type does not identify its SSE body.
    const headers = new Headers();
    if (contentType) headers.set("content-type", contentType);
    const server = fixture(() => responseBody(wire, headers));
    try {
      // When: the caller requests streaming through the minimal adapter.
      const result = await fetch(`${server.url}/responses`, {
        method: "POST",
        body: '{"input":[],"stream":true}',
      });
      // Then: browsers identify the SSE stream and its bytes remain unchanged.
      expect(result.headers.get("content-type")).toBe("text/event-stream");
      expect(await result.text()).toBe(wire);
    } finally {
      server.close();
    }
  },
);

const passthroughCases = [
  { mode: "raw", path: "/responses", status: 200, contentType: null },
  { mode: "minimal", path: "/images/generations", status: 200, contentType: null },
  { mode: "minimal", path: "/responses", status: 429, contentType: null },
  { mode: "minimal", path: "/responses", status: 200, contentType: "application/json" },
  { mode: "minimal", path: "/responses", status: 400, contentType: "text/plain" },
] satisfies readonly {
  mode: TranslationMode;
  path: string;
  status: number;
  contentType: string | null;
}[];

test.each(passthroughCases)(
  "preserves media type outside successful minimal SSE: %j",
  async (scenario) => {
    // Given: a response outside the narrow Codex SSE compatibility case.
    const headers = new Headers();
    if (scenario.contentType) headers.set("content-type", scenario.contentType);
    const body = '{"error":{"code":"fixture_error","future":true}}';
    const server = fixture(() => responseBody(body, headers, scenario.status), {
      translationMode: scenario.mode,
    });
    try {
      // When: a conventional request passes through the transport.
      const result = await fetch(`${server.url}${scenario.path}`, {
        method: "POST",
        body: '{"input":[],"stream":false}',
      });
      // Then: raw mode, other paths, errors and explicit JSON remain unchanged.
      expect(result.status).toBe(scenario.status);
      expect(result.headers.get("content-type")).toBe(scenario.contentType);
      expect(await result.text()).toBe(body);
    } finally {
      server.close();
    }
  },
);
