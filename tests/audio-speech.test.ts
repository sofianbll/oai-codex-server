import { expect, test } from "bun:test";
import OpenAI from "openai";
import { z } from "zod";
import { createActivity } from "../src/server/activity";
import { createApp } from "../src/server/app";
import { parseConfig } from "../src/server/config";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ProxyOptions } from "../src/shared/contracts";
import { operationsSchema } from "../src/ui/schemas";

function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  overrides: Partial<ProxyOptions> = {},
) {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const config = parseConfig({});
  const credentials = {
    get: async () => ({ accessToken: "synthetic-secret", accountId: "synthetic-account" }),
    status: async () => ({ available: true, expiresAt: null }),
  };
  const options: ProxyOptions = {
    ...config.proxy,
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    timeoutMs: 1000,
    maxBodyBytes: 4096,
    ...overrides,
  };
  const gateway = createResponsesGateway(options, credentials.get);
  const app = createApp({
    config,
    configPath: "unused-speech-fixture.json",
    token: "local-key",
    activity: createActivity(10),
    credentials,
    startedAt: new Date(),
    address: () => ({ host: "127.0.0.1", port: 0 }),
    stop: async () => {},
    relay: (request) => gateway.forward(request),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return {
    url: `${server.url.origin}/v1`,
    client: new OpenAI({ apiKey: "local-key", baseURL: `${server.url.origin}/v1`, maxRetries: 0 }),
    close() {
      gateway.close();
      server.stop(true);
      upstream.stop(true);
    },
  };
}

const speech = {
  model: "gpt-4o-mini-tts",
  input: "This is a synthetic speech test.",
  voice: "alloy",
  response_format: "wav",
} as const;

test("SDK speech receives a qualified minimal-mode refusal, not invented audio or a backend attempt", async () => {
  let attempts = 0;
  const local = fixture(() => {
    attempts++;
    return new Response("not established");
  });
  try {
    await expect(Promise.resolve(local.client.audio.speech.create(speech))).rejects.toMatchObject({
      status: 501,
      code: "speech_contract_unverified",
      message: expect.stringContaining("Codex"),
    });
    expect(attempts).toBe(0);
  } finally {
    local.close();
  }
});

test("raw SDK speech preserves a controlled WAV file, useful headers and unknown request options", async () => {
  // A two-sample mono PCM WAV, not synthesized speech or backend evidence.
  const wav = Uint8Array.from([
    82, 73, 70, 70, 40, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 64, 31,
    0, 0, 128, 62, 0, 0, 2, 0, 16, 0, 100, 97, 116, 97, 4, 0, 0, 0, 0, 0, 0, 0,
  ]);
  let received: unknown;
  let path = "";
  const receivedHeaders = new Headers();
  const local = fixture(
    async (request) => {
      received = await request.json();
      path = new URL(request.url).pathname;
      receivedHeaders.set("accept", request.headers.get("accept") ?? "");
      return new Response(wav, {
        headers: {
          "content-type": "audio/wav",
          "content-disposition": 'attachment; filename="synthetic.wav"',
          "x-request-id": "req_speech_local",
        },
      });
    },
    { translationMode: "raw" },
  );
  try {
    const body = { ...speech, future_option: { opaque: true } };
    const result = await local.client.audio.speech.create(body);
    expect(path).toBe("/backend-api/codex/audio/speech");
    expect(receivedHeaders.get("accept")).toBe("application/octet-stream");
    expect(received).toEqual({ ...speech, future_option: { opaque: true } });
    expect(result.headers.get("content-type")).toBe("audio/wav");
    expect(result.headers.get("content-disposition")).toBe('attachment; filename="synthetic.wav"');
    expect(result.headers.get("x-request-id")).toBe("req_speech_local");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(wav);
  } finally {
    local.close();
  }
});

test("raw speech preserves an upstream refusal rather than wrapping it as audio", async () => {
  const local = fixture(
    () =>
      new Response("<html>Not enabled</html>", {
        status: 403,
        headers: { "content-type": "text/html", "x-request-id": "req_refused" },
      }),
    { translationMode: "raw" },
  );
  try {
    await expect(Promise.resolve(local.client.audio.speech.create(speech))).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Not enabled"),
      requestID: "req_refused",
    });
  } finally {
    local.close();
  }
});

test("minimal speech bounds request bytes before its qualified refusal without fetching media references", async () => {
  let attempts = 0;
  const local = fixture(
    () => {
      attempts++;
      return new Response("unexpected");
    },
    { maxBodyBytes: 256 },
  );
  try {
    const response = await fetch(`${local.url}/audio/speech`, {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify({
        ...speech,
        input: "x".repeat(257),
        voice: { id: "https://untrusted.invalid/voice" },
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "body_too_large" } });
    expect(attempts).toBe(0);
  } finally {
    local.close();
  }
});

test("capabilities and OpenAPI expose the speech refusal and voice prerequisites independently of transcription", async () => {
  const local = fixture(() => new Response("unused"));
  try {
    const headers = { authorization: "Bearer local-key" };
    const capabilities = operationsSchema.parse(
      await (await fetch(new URL("/api/capabilities", local.url), { headers })).json(),
    );
    const operation = capabilities.operations.find((entry) => entry.id === "createSpeech");
    if (!operation) throw new Error("Missing speech operation");
    expect(operation).toMatchObject({
      supported: true,
      availability: "unverified",
      evidence: {
        kind: "historical-refusal",
        date: "2026-10-16",
        scope: expect.stringMatching(/raw.*gpt-4o-mini-tts-2025-12-15.*403/),
      },
    });
    expect(operation.limitations).toContainEqual(
      expect.stringContaining("speech_contract_unverified"),
    );
    expect(operation.prerequisites).toContainEqual(expect.stringContaining("consent"));
    expect(operation.limitations).toContainEqual(expect.stringContaining("1/1"));
    const spec = z
      .object({
        paths: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))),
      })
      .parse(await (await fetch(new URL("/openapi.json", local.url))).json());
    expect(spec.paths["/v1/audio/speech"]?.["post"]?.["x-proxy-limitations"]).toEqual(
      operation.limitations,
    );
    expect(operation.requestBodyExample?.["response_format"]).toBe("wav");
  } finally {
    local.close();
  }
});

test("raw speech timeout cancels the local upstream but does not invent an audio terminal marker", async () => {
  const cancelled = Promise.withResolvers<void>();
  const prefix = Uint8Array.from([82, 73, 70, 70]);
  const local = fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(prefix);
          },
          cancel() {
            cancelled.resolve();
          },
        }),
        { headers: { "content-type": "audio/wav" } },
      ),
    { translationMode: "raw", timeoutMs: 100 },
  );
  try {
    const response = await local.client.audio.speech.create(speech);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(prefix);
    await cancelled.promise;
    expect(response.status).toBe(200);
    // The incomplete RIFF is intentionally not declared a valid synthesis result.
  } finally {
    local.close();
  }
});
