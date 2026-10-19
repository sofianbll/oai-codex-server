import { expect, test } from "bun:test";
import OpenAI from "openai";
import { createActivity } from "../src/server/activity";
import { createApp } from "../src/server/app";
import { parseConfig } from "../src/server/config";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ProxyOptions } from "../src/shared/contracts";

// A valid 10 ms silent PCM WAV, not a speech-recognition accuracy fixture.
function audioFile() {
  const bytes = Buffer.alloc(364);
  bytes.write("RIFF");
  bytes.writeUInt32LE(356, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(320, 40);
  return new File([bytes], "synthetic.wav", { type: "audio/x-wav" });
}

function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  overrides: Partial<ProxyOptions> = {},
) {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const config = parseConfig({});
  const gateway = createResponsesGateway(
    {
      ...config.proxy,
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      timeoutMs: 2000,
      ...overrides,
    },
    async () => ({ accessToken: "synthetic-upstream-token", accountId: "synthetic-account" }),
  );
  const app = createApp({
    config,
    configPath: "unused-synthetic-config.json",
    token: "local-key",
    activity: createActivity(10),
    credentials: {
      get: async () => ({ accessToken: "unused", accountId: "unused" }),
      status: async () => ({ available: true, expiresAt: null }),
    },
    startedAt: new Date(),
    address: () => ({ host: "127.0.0.1", port: 0 }),
    stop: async () => {},
    relay: (request) => gateway.forward(request),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const client = new OpenAI({
    baseURL: `${server.url.origin}/v1`,
    apiKey: "local-key",
    maxRetries: 0,
  });
  return {
    client,
    url: `${server.url.origin}/v1`,
    close() {
      gateway.close();
      server.stop(true);
      upstream.stop(true);
    },
  };
}

test("SDK Audio multipart stays separate, unchanged and under the Codex prefix in both modes", async () => {
  for (const translationMode of ["minimal", "raw"] as const) {
    const received: {
      path: string;
      form: Awaited<ReturnType<Request["formData"]>>;
      headers: Headers;
    }[] = [];
    const local = fixture(
      async (request) => {
        received.push({
          path: new URL(request.url).pathname,
          form: await request.formData(),
          headers: request.headers,
        });
        return Response.json({ text: "fixture response only", opaque: { retained: true } });
      },
      { translationMode },
    );
    try {
      const transcription = await local.client.audio.transcriptions.create({
        file: audioFile(),
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word", "segment"],
        language: "fr",
      });
      const translation = await local.client.audio.translations.create({
        file: audioFile(),
        model: "whisper-1",
        response_format: "json",
        prompt: "English context",
        temperature: 0,
      });
      expect<unknown>(transcription).toEqual({
        text: "fixture response only",
        opaque: { retained: true },
      });
      expect(translation).toEqual(transcription);
      expect(received.map(({ path }) => path)).toEqual([
        "/backend-api/codex/audio/transcriptions",
        "/backend-api/codex/audio/translations",
      ]);
      expect(received[0]?.form.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
      expect(received[0]?.form.get("language")).toBe("fr");
      expect(received[1]?.form.get("prompt")).toBe("English context");
      expect(received[1]?.form.get("temperature")).toBe("0");
      for (const { form, headers } of received) {
        const file = form.get("file");
        expect(file).toBeInstanceOf(File);
        if (!(file instanceof File)) throw new Error("Missing uploaded file");
        expect(file.name).toBe("synthetic.wav");
        expect(file.type).toBe("audio/x-wav");
        expect(await file.arrayBuffer()).toEqual(await audioFile().arrayBuffer());
        expect(form.get("model")).toBe("whisper-1");
        expect(headers.get("authorization")).toBe("Bearer synthetic-upstream-token");
        expect(headers.get("chatgpt-account-id")).toBe("synthetic-account");
      }
    } finally {
      local.close();
    }
  }
});

test("Audio HTTP relays response formats and future fields without deriving transcript metadata", async () => {
  const formats = [
    ["json", "application/json", '{"text":"fixture only","future":true}'],
    ["verbose_json", "application/json", '{"text":"fixture only"}'],
    ["diarized_json", "application/json", '{"text":"fixture only","segments":[]}'],
    ["text", "text/plain", "fixture only\n"],
    ["srt", "application/x-subrip", "1\n00:00:00,000 --> 00:00:00,010\nfixture only\n"],
    ["vtt", "text/vtt", "WEBVTT\n\n00:00.000 --> 00:00.010\nfixture only\n"],
  ] as const;
  for (const translationMode of ["minimal", "raw"] as const) {
    const local = fixture(
      async (request) => {
        const form = await request.formData();
        expect(form.getAll("future[]")).toEqual(["one", "two"]);
        const format = formats.find(([name]) => name === form.get("response_format"));
        if (!format) throw new Error("Unexpected fixture format");
        return new Response(format[2], { headers: { "content-type": format[1] } });
      },
      { translationMode },
    );
    try {
      for (const path of ["transcriptions", "translations"]) {
        for (const [format, contentType, text] of formats) {
          // diarized_json is transcription-only; this is transport, not format validation.
          if (path === "translations" && format === "diarized_json") continue;
          const form = new FormData();
          form.set("file", audioFile());
          form.set("model", "fixture-model");
          form.set("response_format", format);
          form.append("future[]", "one");
          form.append("future[]", "two");
          const response = await fetch(`${local.url}/audio/${path}`, {
            method: "POST",
            headers: { authorization: "Bearer local-key" },
            body: form,
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(contentType);
          expect(await response.text()).toBe(text);
        }
      }
    } finally {
      local.close();
    }
  }
});

test("SDK transcription SSE stays Audio events, not Responses or fabricated metadata", async () => {
  const events = [
    { type: "transcript.text.delta", delta: "fixture " },
    { type: "transcript.text.done", text: "fixture only", future: true },
  ];
  const local = fixture(async (request) => {
    expect((await request.formData()).get("stream")).toBe("true");
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const stream = await local.client.audio.transcriptions.create({
      file: audioFile(),
      model: "gpt-4o-transcribe",
      stream: true,
    });
    expect<unknown>(await Array.fromAsync(stream)).toEqual(events);
  } finally {
    local.close();
  }
});

test("Audio upstream refusals stay failures in SDK and HTTP without retries or fallback", async () => {
  for (const status of [400, 413, 415, 422, 429, 503]) {
    let calls = 0;
    const error = { error: { code: "fixture_refusal", message: "Audio prerequisite unavailable" } };
    const local = fixture(() => {
      calls++;
      return Response.json(error, { status });
    });
    try {
      await expect(
        Promise.resolve(
          local.client.audio.transcriptions.create({
            file: audioFile(),
            model: "gpt-4o-transcribe",
          }),
        ),
      ).rejects.toMatchObject({ status, code: "fixture_refusal" });
      await expect(
        Promise.resolve(
          local.client.audio.translations.create({
            file: audioFile(),
            model: "whisper-1",
          }),
        ),
      ).rejects.toMatchObject({ status, code: "fixture_refusal" });
      expect(calls).toBe(2);
    } finally {
      local.close();
    }
  }
  const local = fixture(
    () =>
      new Response("<html>fixture gate</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
  );
  try {
    const form = new FormData();
    form.set("file", new File(["not audio"], "invalid.wav"));
    const response = await fetch(`${local.url}/audio/translations`, {
      method: "POST",
      headers: { authorization: "Bearer local-key" },
      body: form,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("<html>fixture gate</html>");
  } finally {
    local.close();
  }
});

test("Audio whole-multipart byte limit accepts the boundary and rejects one byte over before upstream", async () => {
  const form = new FormData();
  form.set("file", audioFile());
  form.set("model", "whisper-1");
  const request = new Request("http://fixture", { method: "POST", body: form });
  const body = await request.arrayBuffer();
  for (const path of ["transcriptions", "translations"]) {
    for (const excess of [0, 1]) {
      let calls = 0;
      const local = fixture(
        () => {
          calls++;
          return Response.json({ text: "fixture only" });
        },
        {
          maxBodyBytes: body.byteLength - excess,
        },
      );
      try {
        const response = await fetch(`${local.url}/audio/${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer local-key",
            "content-type": request.headers.get("content-type") ?? "",
          },
          body,
        });
        expect(response.status).toBe(excess ? 413 : 200);
        const result = await response.json();
        if (excess) expect(result).toMatchObject({ error: { code: "body_too_large" } });
        else expect(result).toEqual({ text: "fixture only" });
        expect(calls).toBe(excess ? 0 : 1);
      } finally {
        local.close();
      }
    }
  }
});
