import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import OpenAI from "openai";
import { z } from "zod";
import { createActivity } from "../src/server/activity";
import { createApp } from "../src/server/app";
import { parseConfig } from "../src/server/config";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ProxyOptions } from "../src/shared/contracts";

// Known 1x1 opaque white grayscale PNG; decoded scanline is filter=1, white=255, alpha=255.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVx8AAAAASUVORK5CYII=";
// 1x1 white fixtures decoded independently with the browser image decoder.
const formats = [
  { output_format: "png", encoded: png },
  {
    output_format: "jpeg",
    encoded:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgA//Z",
  },
  {
    output_format: "webp",
    encoded: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=",
  },
] as const;

function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  overrides: Partial<ProxyOptions> = {},
) {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const config = parseConfig({});
  const options = {
    ...config.proxy,
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    timeoutMs: 2000,
    ...overrides,
  };
  let credentialReads = 0;
  const credentials = {
    get: async () => {
      credentialReads++;
      return { accessToken: "fixture-upstream", accountId: "fixture-account" };
    },
    status: async () => ({ available: true, expiresAt: null }),
  };
  const relay = createResponsesGateway(options, credentials.get);
  const app = createApp({
    config,
    configPath: "unused-images-fixture.json",
    token: "fixture-local",
    credentials,
    activity: createActivity(10),
    startedAt: new Date(),
    address: () => ({ host: "127.0.0.1", port: 0 }),
    stop: async () => {},
    relay: relay.forward,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return {
    fetch: app.fetch,
    credentialReads: () => credentialReads,
    url: server.url.origin,
    client: new OpenAI({
      apiKey: "fixture-local",
      baseURL: `${server.url.origin}/v1`,
      maxRetries: 0,
    }),
    close() {
      relay.close();
      server.stop(true);
      upstream.stop(true);
    },
  };
}

test("Images SDK multipart edit becomes ordered native inline references without changing bytes", async () => {
  let received: unknown;
  const local = fixture(async (request) => {
    expect(new URL(request.url).pathname).toBe("/backend-api/codex/images/edits");
    expect(request.headers.get("content-type")).toBe("application/json");
    received = await request.json();
    return Response.json(
      { created: 1, data: [{ b64_json: png }] },
      {
        headers: { "x-codex-imagegen-request-id": "edit-fixture" },
      },
    );
  });
  try {
    const result = await local.client.images
      .edit({
        image: [
          new File([Buffer.from(png, "base64")], "first.png", { type: "image/png" }),
          new File([Buffer.from(formats[1].encoded, "base64")], "second.jpg", {
            type: "image/jpeg",
          }),
        ],
        model: "fixture-only",
        prompt: "Keep the white pixel",
        n: 1,
        quality: "low",
        size: "1024x1024",
      })
      .withResponse();
    expect(received).toEqual({
      images: [
        { image_url: `data:image/png;base64,${png}` },
        { image_url: `data:image/jpeg;base64,${formats[1].encoded}` },
      ],
      model: "fixture-only",
      prompt: "Keep the white pixel",
      n: 1,
      quality: "low",
      size: "1024x1024",
    });
    expect(result.data.data?.[0]?.b64_json).toBe(png);
    expect(result.response.headers.get("x-codex-imagegen-request-id")).toBe("edit-fixture");
  } finally {
    local.close();
  }
});

test("Images variations are refused independently before an upstream effect", async () => {
  let requests = 0;
  const local = fixture(() => {
    requests++;
    return Response.json({ created: 1, data: [] });
  });
  try {
    await expect(
      local.client.images
        .createVariation({
          image: new File([Buffer.from(png, "base64")], "pixel.png", { type: "image/png" }),
        })
        .asResponse(),
    ).rejects.toMatchObject({ status: 501, code: "image_variation_contract_unverified" });
    expect(requests).toBe(0);
    expect(local.credentialReads()).toBe(0);
  } finally {
    local.close();
  }
});

test("Images edit capabilities and Explorer example distinguish adaptation from live proof", async () => {
  const local = fixture(() => new Response("forbidden", { status: 500 }));
  try {
    const response = await fetch(`${local.url}/api/capabilities`, {
      headers: { authorization: "Bearer fixture-local" },
    });
    const body = z
      .object({ operations: z.array(z.object({ id: z.string() }).catchall(z.unknown())) })
      .parse(await response.json());
    expect(body.operations.find((op: { id: string }) => op.id === "createImageEdit")).toMatchObject(
      {
        supported: true,
        implementation: "adaptation",
        availability: "source-backed",
        requestBodyExample: {
          images: [{ file_id: "file-existing-authorized-image" }],
          model: "unverified-image-model",
          prompt: "Keep the image unchanged.",
        },
        evidence: { kind: "source", scope: expect.stringContaining("not live-verified") },
      },
    );
  } finally {
    local.close();
  }
});

test("Images native JSON references and extensions in upstream errors remain faithful", async () => {
  const body = {
    images: [{ image_url: `data:image/png;base64,${png}` }, { file_id: "file-existing" }],
    model: "fixture",
    prompt: "unchanged",
    n: 2,
    size: "source-string",
    background: "auto",
    quality: "high",
  };
  const local = fixture(async (request) => {
    expect(await request.json()).toEqual(body);
    expect(request.headers.get("authorization")).toBe("Bearer fixture-upstream");
    expect(request.headers.get("cookie")).toBeNull();
    return Response.json(
      { error: { code: "edit_fixture_refused", message: "no access", extra: true } },
      {
        status: 403,
        headers: { "x-request-id": "outer-edit", "x-codex-imagegen-request-id": "inner-edit" },
      },
    );
  });
  try {
    const result = await fetch(`${local.url}/v1/images/edits`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-local",
        "content-type": "application/json",
        cookie: "private=not-forwarded",
      },
      body: JSON.stringify(body),
    });
    expect(result.status).toBe(403);
    expect(result.headers.get("x-codex-imagegen-request-id")).toBe("inner-edit");
    expect(await result.json()).toEqual({
      error: { code: "edit_fixture_refused", message: "no access", extra: true },
    });
  } finally {
    local.close();
  }
});

test.each([
  { images: [{ image_url: "http://127.0.0.1:1/private" }] },
  { images: [{ image_url: "file:///etc/passwd" }] },
  { images: [{ image_url: "data:image/png;base64,Zm9v" }] },
  { images: [{ image_url: `data:image/jpeg;base64,${png}` }] },
  { images: [{ image_url: `data:image/png;base64,${png.slice(0, -1)}` }] },
  { images: [{ image_url: `data:image/png;base64,${png}`, file_id: "file-existing" }] },
  { images: [{ file_id: "/Users/you/.codex/auth.json" }] },
  { images: [{ file_id: "https://user:secret@example.com/image" }] },
  { images: [] },
  { images: null },
  { model: null },
  { n: -1 },
  { n: 1.5 },
  { n: Number.MAX_SAFE_INTEGER + 1 },
  { quality: "hd" },
  { input_fidelity: "high" },
  { mask: "file-mask" },
  { response_format: "b64_json" },
  { output_format: "webp" },
  { stream: false },
  { future_option: true },
  { image: "file-public-is-not-native" },
])("Images minimal refuses unsafe or unestablished JSON edit contract %#", async (extension) => {
  let requests = 0;
  const local = fixture(() => {
    requests++;
    return new Response("forbidden");
  });
  try {
    const result = await fetch(`${local.url}/v1/images/edits`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-local",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        images: [{ file_id: "file-existing" }],
        model: "fixture",
        prompt: "unchanged",
        ...extension,
      }),
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({
      error: { code: "unsupported_image_edit_contract" },
    });
    expect(requests).toBe(0);
    expect(local.credentialReads()).toBe(0);
  } finally {
    local.close();
  }
});

test.each(["mask", "duplicate", "mixed", "path", "mismatch", "malformed"])(
  "Images multipart rejects %s before credentials",
  async (kind) => {
    const local = fixture(() => new Response("forbidden"));
    const form = new FormData();
    form.set("model", "fixture");
    form.set("prompt", "unchanged");
    form.append(
      "image",
      new File([Buffer.from(png, "base64")], "../auth.json", {
        type: kind === "mismatch" ? "image/jpeg" : "image/png",
      }),
    );
    if (kind === "mask") form.set("mask", new File([Buffer.from(png, "base64")], "mask.png"));
    if (kind === "duplicate") form.append("prompt", "other");
    if (kind === "mixed")
      form.append("image[]", new File([Buffer.from(png, "base64")], "pixel.png"));
    if (kind === "path") form.set("image", "/etc/passwd");
    try {
      const result = await fetch(`${local.url}/v1/images/edits`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-local",
          ...(kind === "malformed"
            ? { "content-type": "multipart/form-data; boundary=missing" }
            : {}),
        },
        body: kind === "malformed" ? "broken" : form,
      });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({
        error: { code: "unsupported_image_edit_contract" },
      });
      expect(local.credentialReads()).toBe(0);
    } finally {
      local.close();
    }
  },
);

test.each([...formats])(
  "Images single SDK upload preserves $output_format bytes, ignoring client filenames",
  async ({ output_format, encoded }) => {
    const type = `image/${output_format}`;
    const local = fixture(async (request) => {
      expect(await request.json()).toEqual({
        images: [{ image_url: `data:${type};base64,${encoded}` }],
        model: "fixture",
        prompt: "unchanged",
      });
      return Response.json({ created: 1, data: [{ b64_json: encoded }] });
    });
    try {
      const result = await local.client.images.edit({
        image: new File([Buffer.from(encoded, "base64")], "../../credentials", { type }),
        model: "fixture",
        prompt: "unchanged",
      });
      expect(result.data?.[0]?.b64_json).toBe(encoded);
    } finally {
      local.close();
    }
  },
);

test("Images raw edit and variations preserve multipart bytes and unsupported fields", async () => {
  let expected = "";
  let received = 0;
  const local = fixture(
    async (request) => {
      expect(await request.text()).toBe(expected);
      received++;
      expect(request.headers.get("content-type")).toBe("multipart/form-data; boundary=fixture");
      return Response.json({ created: 1, data: [] });
    },
    { translationMode: "raw" },
  );
  try {
    for (const route of ["edits", "variations"]) {
      expected =
        '--fixture\r\nContent-Disposition: form-data; name="mask"\r\n\r\nunchanged-unknown\r\n--fixture--\r\n';
      const result = await fetch(`${local.url}/v1/images/${route}`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-local",
          "content-type": "multipart/form-data; boundary=fixture",
        },
        body: expected,
      });
      expect(result.status).toBe(200);
    }
    expect(received).toBe(2);
  } finally {
    local.close();
  }
});

test("Images edit bounds incoming and base64-expanded bodies before credentials", async () => {
  const local = fixture(() => new Response("forbidden"), { maxBodyBytes: 2000 });
  try {
    for (const count of [1400, 3000]) {
      const form = new FormData();
      form.set("model", "fixture");
      form.set("prompt", "unchanged");
      // Signature-only fixture: intentionally not decoded into pixels by the proxy.
      form.set(
        "image",
        new File([Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(count)])], "pixel.png", {
          type: "image/png",
        }),
      );
      const result = await fetch(`${local.url}/v1/images/edits`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-local" },
        body: form,
      });
      expect(result.status).toBe(413);
      expect(await result.json()).toMatchObject({ error: { code: "body_too_large" } });
    }
    expect(local.credentialReads()).toBe(0);
  } finally {
    local.close();
  }
});

test("Images edit deadline includes a stalled multipart upload before decoding or credentials", async () => {
  const local = fixture(() => new Response("forbidden"), { timeoutMs: 30 });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("--fixture\r\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    const result = await local.fetch(
      new Request(`${local.url}/v1/images/edits`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-local",
          "content-type": "multipart/form-data; boundary=fixture",
        },
        body,
      }),
    );
    expect(result.status).toBe(504);
    expect(cancelled).toBe(true);
    expect(local.credentialReads()).toBe(0);
  } finally {
    local.close();
  }
});

test("Images SDK edit cancellation protects the existing upstream byte relay", async () => {
  const aborted = Promise.withResolvers<void>();
  let attempts = 0;
  const local = fixture((request) => {
    attempts++;
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(png, "base64"));
        },
      }),
      {
        headers: { "content-type": "image/png" },
      },
    );
  });
  const controller = new AbortController();
  try {
    const response = await local.client.images
      .edit(
        {
          image: new File([Buffer.from(png, "base64")], "pixel.png", { type: "image/png" }),
          model: "fixture",
          prompt: "unchanged",
        },
        { signal: controller.signal },
      )
      .asResponse();
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value).toEqual(Buffer.from(png, "base64"));
    controller.abort();
    await aborted.promise;
    expect(attempts).toBe(1);
  } finally {
    controller.abort();
    local.close();
  }
}, 1500);

test("Images documentation distinguishes native JSON options from unverified public options", async () => {
  const local = fixture(() => new Response("must not be called", { status: 500 }));
  try {
    const response = await fetch(`${local.url}/openapi.json`);
    const record = z.record(z.string(), z.unknown());
    const spec = record.parse(await response.json());
    const image = record.parse(
      record.parse(record.parse(spec["paths"])["/v1/images/generations"])["post"],
    );
    expect(image["x-proxy-supported"]).toBe(true);
    expect(image["x-proxy-implementation"]).toBe("relay");
    expect(image["x-proxy-availability"]).toBe("source-backed");
    expect(image["x-proxy-evidence"]).toMatchObject({
      kind: "runtime",
      date: "2026-10-16",
      scope: expect.stringContaining("2026-10-16T22:27:36.855Z"),
    });
    expect(image["description"]).toContain("prompt, model, background, n, quality, size");
    const limitations = z.array(z.string()).parse(image["x-proxy-limitations"]).join(" ");
    expect(limitations).toContain("output_compression");
    expect(limitations).toContain("Unknown fields");
    expect(limitations).toContain("1374x1145");
    expect(limitations).toContain("not verified compatible");
    const body = record.parse(image["requestBody"]);
    const media = record.parse(record.parse(body["content"])["application/json"]);
    expect(media["example"]).toEqual({
      model: "gpt-image-2",
      prompt: "A single solid blue circle centered on a plain white background. No text.",
      n: 1,
      quality: "low",
      size: "1024x1024",
      background: "opaque",
    });
  } finally {
    local.close();
  }
});

test.each(["minimal", "raw"] as const)(
  "%s Images SDK preserves native envelope, actual PNG bytes and unknown options",
  async (translationMode) => {
    const body = {
      model: "gpt-image-1.5",
      prompt: "A white pixel",
      background: "opaque" as const,
      n: 1,
      quality: "low" as const,
      size: "1024x1024" as const,
    };
    const extensions = {
      output_format: "png" as const,
      future_option: { opaque: [null, "é"] },
      moderation: null,
    };
    const envelope = {
      created: 1778832973,
      data: [{ b64_json: png, generation_id: "gen_fixture", future_image: true }],
      output_format: "png",
      size: "1x1",
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      future_envelope: { retained: true },
    };
    let received: unknown;
    let path: string | undefined;
    const local = fixture(
      async (request) => {
        path = new URL(request.url).pathname;
        received = await request.json();
        return Response.json(envelope, {
          headers: { "x-request-id": "req_outer", "x-codex-imagegen-request-id": "req_image" },
        });
      },
      { translationMode },
    );
    try {
      const result = await local.client.images.generate({ ...body, ...extensions }).withResponse();
      expect(path).toBe("/backend-api/codex/images/generations");
      expect(received).toEqual({ ...body, ...extensions });
      expect(result.data).toMatchObject(envelope);
      expect(result.request_id).toBe("req_outer");
      expect(result.response.headers.get("x-codex-imagegen-request-id")).toBe("req_image");
      const bytes = Buffer.from(result.data.data?.[0]?.b64_json ?? "", "base64");
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1, 1]);
      expect(inflateSync(bytes.subarray(41, 52))).toEqual(Buffer.from([1, 255, 255]));
    } finally {
      local.close();
    }
  },
);

test.each([400, 403, 429, 503])(
  "Images SDK keeps upstream %i refusal and request IDs, without retry",
  async (status) => {
    let attempts = 0;
    const local = fixture(() => {
      attempts++;
      return Response.json(
        {
          error: {
            message: "Image option or account unavailable",
            type: "image_error",
            code: "image_refused",
            param: "model",
            future: true,
          },
        },
        {
          status,
          headers: {
            "x-request-id": "req_refused",
            "x-codex-imagegen-request-id": "req_image_refused",
          },
        },
      );
    });
    try {
      const error = await local.client.images
        .generate({ model: "unverified", prompt: "pixel" })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(OpenAI.APIError);
      if (!(error instanceof OpenAI.APIError)) throw new Error("Expected API error");
      expect(error.status).toBe(status);
      expect(error.code).toBe("image_refused");
      expect(error.param).toBe("model");
      expect(error.headers?.get("x-codex-imagegen-request-id")).toBe("req_image_refused");
      expect(error.requestID).toBe("req_refused");
      expect(attempts).toBe(1);
    } finally {
      local.close();
    }
  },
);

test("Images SDK can inspect non-JSON binary bytes without a fabricated JSON envelope", async () => {
  const bytes = Buffer.from(png, "base64");
  const local = fixture(() => new Response(bytes, { headers: { "content-type": "image/png" } }));
  try {
    const response = await local.client.images
      .generate({ model: "fixture", prompt: "pixel" })
      .asResponse();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    local.close();
  }
});

test.each([...formats])(
  "Images SDK preserves $output_format content and format options without transcoding",
  async ({ output_format, encoded }) => {
    const body = {
      model: "fixture-only",
      prompt: "white pixel",
      output_format,
      output_compression: 80,
      response_format: "b64_json" as const,
      size: "1536x1024" as const,
      moderation: "low" as const,
      partial_images: 2,
    };
    let received: unknown;
    const local = fixture(async (request) => {
      received = await request.json();
      return Response.json({
        created: 1,
        data: [{ b64_json: encoded }],
        output_format,
        size: "1x1",
      });
    });
    try {
      const result = await local.client.images.generate(body);
      expect(received).toEqual(body);
      expect(Buffer.from(result.data?.[0]?.b64_json ?? "", "base64")).toEqual(
        Buffer.from(encoded, "base64"),
      );
      expect(result).toMatchObject({ output_format, size: "1x1" });
    } finally {
      local.close();
    }
  },
);

test("Images relay does not repair malformed envelopes or fetch returned image URLs", async () => {
  let requests = 0;
  const envelope = {
    created: 1,
    data: [{ url: "http://127.0.0.1:1/not-fetched", b64_json: "not-an-image" }],
  };
  const local = fixture(() => {
    requests++;
    return Response.json(envelope);
  });
  try {
    const result = await local.client.images.generate({ prompt: "pixel", model: "fixture" });
    expect(result).toMatchObject(envelope);
    expect(requests).toBe(1);
    // SDK types do not validate image contents: transport success is not compatibility evidence.
    expect(Buffer.from(result.data?.[0]?.b64_json ?? "", "base64").subarray(0, 8)).not.toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  } finally {
    local.close();
  }
});

test("Images SDK gets an explicit request size refusal before upstream generation", async () => {
  let requests = 0;
  const local = fixture(
    () => {
      requests++;
      return Response.json({ created: 1, data: [] });
    },
    { maxBodyBytes: 128 },
  );
  try {
    await expect(
      local.client.images.generate({ model: "fixture", prompt: "x".repeat(1024) }).asResponse(),
    ).rejects.toMatchObject({
      status: 413,
      code: "body_too_large",
    });
    expect(requests).toBe(0);
  } finally {
    local.close();
  }
});

test("Images SDK gets an explicit deadline error while awaiting generation headers", async () => {
  const local = fixture(
    async () => {
      await Bun.sleep(150);
      return Response.json({ created: 1, data: [{ b64_json: png }] });
    },
    { timeoutMs: 30 },
  );
  try {
    await expect(
      local.client.images.generate({ model: "fixture", prompt: "pixel" }).asResponse(),
    ).rejects.toMatchObject({
      status: 504,
      code: "upstream_timeout",
    });
  } finally {
    local.close();
  }
});

test("Images SDK streaming cancellation reaches the local upstream without retry", async () => {
  const aborted = Promise.withResolvers<void>();
  let attempts = 0;
  const event = {
    type: "image_generation.partial_image" as const,
    b64_json: png,
    partial_image_index: 0,
    created_at: 1778832973,
    background: "opaque",
    output_format: "png",
    quality: "low",
    size: "1x1",
    future_event: true,
  } as const;
  const local = fixture((request) => {
    attempts++;
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const controller = new AbortController();
  try {
    const stream = await local.client.images.generate(
      { model: "fixture", prompt: "pixel", stream: true },
      { signal: controller.signal },
    );
    for await (const item of stream) {
      expect(item).toEqual(event);
      controller.abort();
      break;
    }
    await aborted.promise;
    expect(attempts).toBe(1);
  } finally {
    controller.abort();
    local.close();
  }
}, 1500);
