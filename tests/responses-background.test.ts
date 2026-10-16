import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { parseConfig } from "../src/server/config";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ResponsesStoreOptions } from "../src/server/responses-store";
import { startServer } from "../src/server/runtime";
import type { CredentialProvider, ProxyOptions } from "../src/shared/contracts";

async function fixture(
  handler: (socket: Bun.ServerWebSocket<undefined>, data: string) => unknown = () => {},
  storage: ResponsesStoreOptions = {},
  credentials: CredentialProvider = async () => ({ accessToken: "fixture", accountId: "a" }),
) {
  let emissions = 0;
  const upstream = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket, data) {
        emissions++;
        void handler(socket, String(data));
      },
    },
  });
  const options: ProxyOptions = {
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    defaultModel: "fixture",
    clientVersion: "fixture",
    translationMode: "minimal",
    timeoutMs: 1000,
    maxBodyBytes: 16384,
  };
  let gateway = createResponsesGateway(options, credentials, storage);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => gateway.forward(request),
  });
  const client = new OpenAI({
    baseURL: `${server.url.origin}/v1`,
    apiKey: "fixture",
    maxRetries: 0,
  });
  return {
    client,
    server,
    options,
    emissions: () => emissions,
    restart() {
      gateway.close();
      gateway = createResponsesGateway(options, credentials, storage);
    },
    async close() {
      gateway.close();
      await server.stop(true);
      await upstream.stop(true);
    },
  };
}

async function terminal(client: OpenAI, id: string) {
  for (let i = 0; i < 200; i++) {
    const response = await client.responses.retrieve(id);
    if (response.status !== "queued" && response.status !== "in_progress") return response;
    await Bun.sleep(5);
  }
  throw new Error("Job did not terminate");
}

test("background polling preserves native cancelled, failed and incomplete terminals and their details", async () => {
  const f = await fixture((socket, data) => {
    const status = JSON.parse(data).input[0].content[0].text as string;
    socket.send(
      JSON.stringify({
        type: `response.${status}`,
        response: {
          id: "resp_native",
          object: "response",
          status,
          output: [],
          error: status === "failed" ? { code: "fixture_error", message: "native failure" } : null,
          incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
          fixture_extension: "preserved",
        },
      }),
    );
  });
  try {
    for (const status of ["cancelled", "failed", "incomplete"] as const) {
      const created = await f.client.responses.create({ input: status, background: true });
      const result = await terminal(f.client, created.id);
      expect(result).toMatchObject({ id: created.id, status, fixture_extension: "preserved" });
      if (status === "failed") expect(result.error).toMatchObject({ code: "fixture_error" });
      if (status === "incomplete")
        expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" });
    }
  } finally {
    await f.close();
  }
});

test("invalid background options and missing SSE journal fail explicitly before any upstream emission", async () => {
  const f = await fixture();
  try {
    for (const options of [
      { store: null },
      { stream: null },
      { background: null },
      { background: "yes" },
    ]) {
      const result = await fetch(`${f.server.url.origin}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "private", background: true, ...options }),
      });
      expect(result.status).toBe(400);
      await result.text();
    }
    await expect(
      f.client.responses.create({ input: "stream", background: true, stream: true }).asResponse(),
    ).rejects.toMatchObject({ status: 501, code: "background_stream_not_ready" });
    expect(f.emissions()).toBe(0);
  } finally {
    await f.close();
  }
});

test("a crash before the queued producer starts recovers under a full reservation without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-crash-"));
  const path = join(directory, "store.sqlite");
  const module = new URL("../src/server/responses-gateway.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { writeSync } from "node:fs";
    import { createResponsesGateway } from ${JSON.stringify(module)};
    const gateway = createResponsesGateway({ baseUrl: "http://127.0.0.1:1/backend-api/codex", defaultModel: "fixture", clientVersion: "fixture", translationMode: "minimal", timeoutMs: 1000, maxBodyBytes: 4096 }, async () => ({ accountId: "a", accessToken: "fixture" }), { path: ${JSON.stringify(path)}, maxBytes: 4096, maxRecordBytes: 4096, maxRecords: 2 });
    const response = await gateway.forward(new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ input: "never sent", background: true }) }));
    writeSync(1, JSON.stringify(await response.json()));
    process.kill(process.pid, "SIGKILL");
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const queued = JSON.parse(await new Response(child.stdout).text()) as {
    id: string;
    status: string;
  };
  await child.exited;
  expect(queued.status).toBe("queued");
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(undefined, {
      path,
      maxBytes: 4096,
      maxRecordBytes: 4096,
      maxRecords: 2,
      now: () => Date.now() + 365 * 24 * 60 * 60_000,
    });
    expect(await f.client.responses.retrieve(queued.id)).toMatchObject({
      status: "failed",
      error: { code: "background_interrupted" },
    });
    await Bun.sleep(30);
    expect(f.emissions()).toBe(0);
  } finally {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("account changes during queued credential and pre-emission awaits never send the job", async () => {
  for (const barrier of [2, 3]) {
    let accountId = "a";
    let reads = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(undefined, {}, async () => {
      if (++reads === barrier) {
        entered.resolve();
        await release.promise;
      }
      return { accessToken: `fixture-${accountId}`, accountId };
    });
    try {
      const queued = await f.client.responses.create({
        input: "belongs-only-to-a",
        background: true,
        store: true,
      });
      await entered.promise;
      accountId = "b";
      await expect(f.client.responses.retrieve(queued.id).asResponse()).rejects.toMatchObject({
        status: 404,
      });
      release.resolve();
      await Bun.sleep(30);
      accountId = "a";
      expect(await terminal(f.client, queued.id)).toMatchObject({
        status: "failed",
        error: { code: "upstream_account_changed" },
      });
      expect(f.emissions()).toBe(0);
    } finally {
      release.resolve();
      await f.close();
    }
  }
});

test("disconnect is not cancellation; concurrent explicit cancel is idempotent and cannot overwrite completion", async () => {
  const started = Promise.withResolvers<void>();
  let socket: Bun.ServerWebSocket<undefined> | undefined;
  const f = await fixture((ws) => {
    socket = ws;
    started.resolve();
  });
  try {
    const controller = new AbortController();
    const queued = await f.client.responses.create(
      { input: "detached", background: true },
      { signal: controller.signal },
    );
    controller.abort();
    await started.promise;
    expect(await f.client.responses.retrieve(queued.id)).toMatchObject({ status: "in_progress" });
    await expect(f.client.responses.delete(queued.id).asResponse()).rejects.toMatchObject({
      status: 409,
    });
    const cancellations = await Promise.all(
      Array.from({ length: 8 }, () => f.client.responses.cancel(queued.id)),
    );
    expect(cancellations.every((result) => result.status === "cancelled")).toBe(true);
    socket?.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_late", status: "completed", output: [] },
      }),
    );
    await Bun.sleep(10);
    expect(await f.client.responses.retrieve(queued.id)).toMatchObject({ status: "cancelled" });
    await f.client.responses.delete(queued.id);
    await expect(f.client.responses.retrieve(queued.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await f.close();
  }

  const completed = await fixture((ws) =>
    ws.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_done", status: "completed", output: [] },
      }),
    ),
  );
  try {
    const queued = await completed.client.responses.create({
      input: "complete first",
      background: true,
    });
    expect(await terminal(completed.client, queued.id)).toMatchObject({ status: "completed" });
    const cancellations = await Promise.all(
      Array.from({ length: 8 }, () => completed.client.responses.cancel(queued.id)),
    );
    expect(cancellations.every((result) => result.status === "completed")).toBe(true);
  } finally {
    await completed.close();
  }
});

test("quota is reserved before generation and oversized output never appears as stored success", async () => {
  const recordLimit = await fixture(undefined, { maxRecords: 1 });
  try {
    await expect(
      recordLimit.client.responses
        .create({ input: "requires object and reservation slots", background: true })
        .asResponse(),
    ).rejects.toMatchObject({ status: 507, code: "storage_capacity_exceeded" });
    expect(recordLimit.emissions()).toBe(0);
  } finally {
    await recordLimit.close();
  }
  const saturated = await fixture(undefined, { maxBytes: 4096, maxRecordBytes: 4096 });
  try {
    const queued = await saturated.client.responses.create({ input: "reserved", background: true });
    await expect(
      saturated.client.responses.create({ input: "must not emit", background: true }).asResponse(),
    ).rejects.toMatchObject({ status: 507, code: "storage_capacity_exceeded" });
    expect(saturated.emissions()).toBeLessThanOrEqual(1);
    await saturated.client.responses.cancel(queued.id);
    expect(await saturated.client.responses.retrieve(queued.id)).toMatchObject({
      status: "cancelled",
    });
  } finally {
    await saturated.close();
  }
  const oversized = await fixture(
    (socket) =>
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_big",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "x".repeat(5000) }],
              },
            ],
          },
        }),
      ),
    { maxRecordBytes: 2048 },
  );
  try {
    const queued = await oversized.client.responses.create({
      input: "bounded",
      background: true,
      store: true,
    });
    expect(await terminal(oversized.client, queued.id)).toMatchObject({
      status: "failed",
      error: { code: "stored_response_too_large" },
      output: [],
      store: true,
    });
  } finally {
    await oversized.close();
  }
});

test("explicit background storage survives restart for thirty days without renewing at reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-ttl-"));
  let time = 1_800_000_000_000;
  const f = await fixture(
    (socket) =>
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: { id: "resp_ttl", status: "completed", output: [] },
        }),
      ),
    { path: join(directory, "store.sqlite"), now: () => time },
  );
  try {
    const queued = await f.client.responses.create({
      input: "retained",
      background: true,
      store: true,
    });
    expect(await terminal(f.client, queued.id)).toMatchObject({ store: true, status: "completed" });
    await expect(
      f.client.responses.retrieve(queued.id, { stream: true, starting_after: 0 }).asResponse(),
    ).rejects.toMatchObject({ status: 501, code: "background_stream_not_ready" });
    f.restart();
    time += 10 * 60_000;
    expect(await f.client.responses.retrieve(queued.id)).toMatchObject({ store: true });
    expect((await f.client.responses.inputItems.list(queued.id)).data).toMatchObject([
      { content: [{ type: "input_text", text: "retained" }] },
    ]);
    time += 30 * 24 * 60 * 60_000 - 10 * 60_000;
    await expect(f.client.responses.retrieve(queued.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending concurrency and generation duration are bounded and release producer slots", async () => {
  const f = await fixture();
  try {
    const jobs = await Promise.all(
      Array.from({ length: 16 }, () =>
        f.client.responses.create({ input: "wait", background: true }),
      ),
    );
    await expect(
      f.client.responses.create({ input: "overflow", background: true }).asResponse(),
    ).rejects.toMatchObject({ status: 429, code: "background_capacity_exceeded" });
    const results = await Promise.all(jobs.map((job) => terminal(f.client, job.id)));
    expect(
      results.every(
        (result) => result.status === "failed" && String(result.error?.code) === "upstream_timeout",
      ),
    ).toBe(true);
    expect(f.emissions()).toBe(16);
    const next = await f.client.responses.create({ input: "slot released", background: true });
    expect(next.status).toBe("queued");
    await f.client.responses.cancel(next.id);
  } finally {
    await f.close();
  }
});

test("integrated runtime stops producers before closing durable storage and never restarts them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-runtime-"));
  await mkdir(join(directory, "synthetic-auth"));
  await writeFile(
    join(directory, "synthetic-auth/auth.json"),
    JSON.stringify({ tokens: { access_token: "fixture", account_id: "a" } }),
  );
  const token = "fixture-runtime-token-0123456789abcdef";
  await writeFile(join(directory, "token"), token);
  const started = Promise.withResolvers<void>();
  const f = await fixture(() => {
    started.resolve();
  });
  const config = parseConfig({
    server: { port: 0 },
    auth: { codexHome: "synthetic-auth", tokenFile: "token" },
    storage: { path: "private/store.sqlite" },
  });
  Object.assign(config.proxy, { baseUrl: f.options.baseUrl });
  const configPath = join(directory, "server.json");
  let runtime = await startServer(config, configPath);
  const client = () => new OpenAI({ baseURL: `${runtime.url}/v1`, apiKey: token, maxRetries: 0 });
  try {
    const spec = (await fetch(`${runtime.url}/openapi.json`).then((response) =>
      response.json(),
    )) as {
      paths: Record<
        string,
        Record<string, { description: string; "x-proxy-implementation": string }>
      >;
    };
    expect(spec.paths["/v1/responses/{response_id}/cancel"]?.["post"]).toMatchObject({
      "x-proxy-implementation": "local",
    });
    expect(spec.paths["/v1/responses"]?.["post"]?.description).toContain(
      "Local background JSON example",
    );
    const queued = await client().responses.create({
      input: "runtime stop",
      background: true,
      store: true,
    });
    await started.promise;
    await runtime.stop();
    runtime = await startServer(config, configPath);
    expect(await client().responses.retrieve(queued.id)).toMatchObject({
      status: "failed",
      store: true,
      error: { code: "background_interrupted" },
    });
    await Bun.sleep(20);
    expect(f.emissions()).toBe(1);
  } finally {
    await runtime.stop();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart fails both queued and running jobs without emitting and retains temporary results ten minutes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-restart-"));
  let time = 1_800_000_000_000;
  const started = Promise.withResolvers<void>();
  const f = await fixture(
    () => {
      started.resolve();
    },
    { path: join(directory, "store.sqlite"), now: () => time },
  );
  try {
    const running = await f.client.responses.create({ input: "running", background: true });
    await started.promise;
    // HTTP creation completes before the scheduled producer gets its first turn.
    const queued = await f.client.responses.create({ input: "queued", background: true });
    f.restart();
    for (const id of [running.id, queued.id]) {
      expect(await f.client.responses.retrieve(id)).toMatchObject({
        status: "failed",
        error: { code: "background_interrupted" },
      });
    }
    const sent = f.emissions();
    await Bun.sleep(30);
    expect(f.emissions()).toBe(sent);
    time += 10 * 60_000 - 1;
    expect(await f.client.responses.retrieve(running.id)).toMatchObject({ status: "failed" });
    time += 1;
    await expect(f.client.responses.retrieve(running.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SDK background creation returns a stable ID before generation and polls its completed output", async () => {
  const finish = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const directory = await mkdtemp(join(tmpdir(), "background-"));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      async message(socket, data) {
        expect(JSON.parse(String(data))).toMatchObject({ store: false, background: false });
        started.resolve();
        await finish.promise;
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_native",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  id: "msg_fixture",
                  content: [{ type: "output_text", text: "BACKGROUND", annotations: [] }],
                },
              ],
            },
          }),
        );
      },
    },
  });
  const gateway = createResponsesGateway(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      defaultModel: "fixture",
      clientVersion: "fixture",
      translationMode: "minimal",
      timeoutMs: 2000,
      maxBodyBytes: 4096,
    },
    async () => ({ accessToken: "fixture", accountId: "a" }),
    { path: join(directory, "store.sqlite") },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => gateway.forward(request),
  });
  const client = new OpenAI({
    baseURL: `${server.url.origin}/v1`,
    apiKey: "fixture",
    maxRetries: 0,
  });
  try {
    const queued = await client.responses.create({
      model: "fixture",
      input: "hello",
      background: true,
    });
    expect(queued).toMatchObject({
      object: "response",
      status: "queued",
      background: true,
      store: false,
    });
    await started.promise;
    expect(await client.responses.retrieve(queued.id)).toMatchObject({
      id: queued.id,
      status: "in_progress",
    });
    finish.resolve();
    let result = await client.responses.retrieve(queued.id);
    for (let i = 0; result.status === "in_progress" && i < 100; i++) {
      await Bun.sleep(5);
      result = await client.responses.retrieve(queued.id);
    }
    expect(result).toMatchObject({
      id: queued.id,
      status: "completed",
      background: true,
      store: false,
    });
    expect(result.output_text).toBe("BACKGROUND");
    expect(await client.responses.cancel(queued.id)).toMatchObject({ status: "completed" });
  } finally {
    finish.resolve();
    gateway.close();
    await server.stop(true);
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
