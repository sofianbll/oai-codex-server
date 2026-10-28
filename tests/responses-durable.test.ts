import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { parseConfig } from "../src/server/config";
import { createResponsesGateway } from "../src/server/responses-gateway";
import { startServer } from "../src/server/runtime";

test("SDK retrieves JSON and SSE opt-in Responses and paginates inputs after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-responses-"));
  let turn = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket) {
        turn++;
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_${turn}`,
              object: "response",
              status: "completed",
              store: false,
              output: [
                {
                  id: `msg_${turn}`,
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "DURABLE", annotations: [] }],
                },
              ],
            },
          }),
        );
      },
    },
  });
  const options = {
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    defaultModel: "fixture",
    clientVersion: "fixture",
    translationMode: "minimal" as const,
    timeoutMs: 2000,
    maxBodyBytes: 4096,
  };
  const credentials = async () => ({ accessToken: "fixture", accountId: "account-a" });
  const storage = { path: join(directory, "proxy.sqlite") };
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
  try {
    const input = [
      { role: "user" as const, content: "first" },
      { role: "user" as const, content: "second" },
    ];
    const json = await client.responses.create({ model: "fixture", input, store: true });
    const stream = await client.responses.create({
      model: "fixture",
      input: "stream",
      store: true,
      stream: true,
    });
    for await (const event of stream)
      if (event.type === "response.completed")
        expect(event.response).toMatchObject({ store: true });
    await client.responses.create({ model: "fixture", input: "ephemeral" });
    gateway.close();
    gateway = createResponsesGateway(options, credentials, storage);
    expect((await client.responses.retrieve(json.id)).output_text).toBe("DURABLE");
    expect(await client.responses.retrieve("resp_2")).toMatchObject({ store: true });
    await expect(client.responses.retrieve("resp_3").asResponse()).rejects.toMatchObject({
      status: 404,
    });
    const first = await client.responses.inputItems.list(json.id, { order: "asc", limit: 1 });
    expect(first.data).toMatchObject([{ role: "user", content: "first" }]);
    expect(first.has_more).toBe(true);
    const second = await client.responses.inputItems.list(json.id, {
      order: "asc",
      after: first.data[0]?.id ?? "",
      limit: 1,
    });
    expect(second.data).toMatchObject([{ role: "user", content: "second" }]);
    await client.responses.delete(json.id);
    gateway.close();
    gateway = createResponsesGateway(options, credentials, storage);
    await expect(client.responses.retrieve(json.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    gateway.close();
    await server.stop(true);
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime anchors private durable data to server configuration and preserves other accounts across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-runtime-"));
  const home = join(directory, "synthetic-auth");
  await mkdir(home);
  const account = async (id: string) =>
    writeFile(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: `fixture-${id}`, account_id: id } }),
    );
  await account("a");
  const config = parseConfig({
    server: { port: 0 },
    auth: { codexHome: "synthetic-auth", tokenFile: "token" },
    storage: { path: "private/store.sqlite" },
  });
  const configPath = join(directory, "server.json");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(directory, "token"), "fixture-proxy-token-0123456789abcdef");
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket) {
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: "resp_runtime", object: "response", status: "completed", output: [] },
          }),
        );
      },
    },
  });
  Object.assign(config.proxy, { baseUrl: `${upstream.url.origin}/backend-api/codex` });
  let runtime = await startServer(config, configPath);
  const client = () =>
    new OpenAI({
      baseURL: `${runtime.url}/v1`,
      apiKey: "fixture-proxy-token-0123456789abcdef",
      maxRetries: 0,
    });
  try {
    await client().responses.create({ input: "private-a", model: "fixture", store: true });
    const publicConfig = (await fetch(`${runtime.url}/api/config`, {
      headers: { authorization: "Bearer fixture-proxy-token-0123456789abcdef" },
    }).then((r) => r.json())) as Record<string, unknown>;
    expect(publicConfig).not.toHaveProperty("storage");
    const edited = await fetch(`${runtime.url}/api/config`, {
      method: "PUT",
      headers: {
        authorization: "Bearer fixture-proxy-token-0123456789abcdef",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...publicConfig, storage: { path: "elsewhere.sqlite" } }),
    });
    expect(edited.status).toBe(400);
    await runtime.stop();
    runtime = await startServer(config, configPath);
    expect((await client().responses.retrieve("resp_runtime")).id).toBe("resp_runtime");
    await account("b");
    await expect(client().responses.retrieve("resp_runtime").asResponse()).rejects.toMatchObject({
      status: 404,
    });
    await expect(client().responses.delete("resp_runtime").asResponse()).rejects.toMatchObject({
      status: 404,
    });
    await account("a");
    expect((await client().responses.retrieve("resp_runtime")).id).toBe("resp_runtime");
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "private/store.sqlite"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(home, "auth.json"), "utf8")).toContain("fixture-a");
  } finally {
    await runtime.stop();
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("exclusive storage keeps concurrent quota reservations and account budgets global without eviction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-quota-"));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let turns = 0;
  let time = 1_800_000_000_000;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      async message(socket) {
        turns++;
        started.resolve();
        await finish.promise;
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: `resp_quota_${turns}`, status: "completed", output: [] },
          }),
        );
      },
    },
  });
  const options = {
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    defaultModel: "fixture",
    clientVersion: "fixture",
    translationMode: "minimal" as const,
    timeoutMs: 2000,
    maxBodyBytes: 4096,
  };
  const storage = {
    path: join(directory, "proxy.sqlite"),
    maxBytes: 4096,
    maxRecordBytes: 4096,
    now: () => time,
  };
  expect(new URL(options.baseUrl).hostname).toBe("127.0.0.1");
  let accountId = "a";
  const a = createResponsesGateway(
    options,
    async () => ({ accessToken: `fixture-${accountId}`, accountId }),
    storage,
  );
  const create = (gateway: typeof a, input = "retain") =>
    gateway.forward(
      new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ input, store: true }),
      }),
    );
  try {
    const pending = create(a);
    await started.promise;
    // Multiple handles no longer arbitrate writes: a second owner must fail at open.
    expect(() =>
      createResponsesGateway(
        options,
        async () => ({ accessToken: "fixture-b", accountId: "b" }),
        storage,
      ),
    ).toThrow("already has an active owner");
    const conflict = await create(a);
    expect(conflict.status).toBe(507);
    expect(await conflict.json()).toMatchObject({ error: { code: "storage_capacity_exceeded" } });
    expect(turns).toBe(1);
    finish.resolve();
    expect((await pending).status).toBe(200);
    accountId = "b";
    expect((await create(a)).status).toBe(507);
    accountId = "a";
    expect((await a.forward(new Request("http://local/v1/responses/resp_quota_1"))).status).toBe(
      200,
    );
    time += 30 * 24 * 60 * 60 * 1000 - 1;
    expect((await a.forward(new Request("http://local/v1/responses/resp_quota_1"))).status).toBe(
      200,
    );
    time++;
    expect((await a.forward(new Request("http://local/v1/responses/resp_quota_1"))).status).toBe(
      404,
    );
    accountId = "b";
    expect((await create(a)).status).toBe(200);
    expect((await a.forward(new Request("http://local/v1/responses/resp_quota_2"))).status).toBe(
      200,
    );
    expect((await stat(storage.path)).size).toBeLessThan(128 * 1024);
  } finally {
    finish.resolve();
    a.close();
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an await cannot swap generation content onto credentials of another account", async () => {
  let lookups = 0;
  const received: { account: string | null; input: unknown }[] = [];
  const upstream = Bun.serve<{ account: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, {
        data: { account: request.headers.get("chatgpt-account-id") },
      })
        ? undefined
        : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const value = JSON.parse(String(message)) as Record<string, unknown>;
        received.push({ account: socket.data.account, input: value["input"] });
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: "resp_pinned", output: [] },
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
    async () => {
      const accountId = ++lookups === 1 ? "a" : "b";
      await Bun.sleep(5);
      return { accountId, accessToken: `fixture-${accountId}` };
    },
  );
  try {
    const response = await gateway.forward(
      new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ input: "private-a", store: true }),
      }),
    );
    expect(response.status).toBe(200);
    expect(received).toMatchObject([
      { account: "a", input: [{ content: [{ text: "private-a" }] }] },
    ]);
    const foreign = await gateway.forward(new Request("http://local/v1/responses/resp_pinned"));
    expect(foreign.status).toBe(404);
    const continuation = await gateway.forward(
      new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ input: "new-b", previous_response_id: "resp_pinned" }),
      }),
    );
    expect(continuation.status).toBe(404);
    expect(received).toHaveLength(1);
  } finally {
    gateway.close();
    await upstream.stop(true);
  }
});

test("storage failures never advertise a stored JSON or SSE success and release reservations", async () => {
  let turn = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket) {
        turn++;
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_limit_${turn}`,
              output: [],
              extra: turn <= 2 ? "x".repeat(1024) : "small",
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
    { maxRecordBytes: 512, maxBytes: 512 },
  );
  const create = (stream: boolean) =>
    gateway.forward(
      new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ input: "hi", store: true, stream }),
      }),
    );
  try {
    const json = await create(false);
    expect(json.status).toBe(507);
    expect(await json.json()).toMatchObject({ error: { code: "stored_response_too_large" } });
    const sse = await create(true);
    const text = await sse.text();
    expect(text).toContain('"code":"stored_response_too_large"');
    expect(text).not.toContain('"type":"response.completed"');
    expect(
      (await gateway.forward(new Request("http://local/v1/responses/resp_limit_2"))).status,
    ).toBe(404);
    expect((await create(false)).status).toBe(200);
  } finally {
    gateway.close();
    await upstream.stop(true);
  }
});

test("stored failed and incomplete terminals keep their upstream error status and remain readable", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const payload = JSON.parse(String(message)) as Record<string, unknown>;
        const status = payload["metadata"] === "failed" ? "failed" : "incomplete";
        socket.send(
          JSON.stringify({
            type: `response.${status}`,
            response: {
              id: `resp_${status}`,
              object: "response",
              status,
              output: [],
              error: { code: "fixture_failure" },
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
  );
  try {
    for (const status of ["failed", "incomplete"]) {
      const response = await gateway.forward(
        new Request("http://local/v1/responses", {
          method: "POST",
          body: JSON.stringify({ input: "hi", store: true, metadata: status }),
        }),
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        id: `resp_${status}`,
        status,
        store: true,
        error: { code: "fixture_failure" },
      });
      const stored = await gateway.forward(new Request(`http://local/v1/responses/resp_${status}`));
      expect(stored.status).toBe(200);
      expect(await stored.json()).toMatchObject({ status, store: true });
    }
  } finally {
    gateway.close();
    await upstream.stop(true);
  }
});

test("runtime refuses a foreign database without changing its existing bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-foreign-"));
  const path = join(directory, "foreign.sqlite");
  const fixture = new Database(path);
  fixture.exec(
    "CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('preserve-existing-data')",
  );
  fixture.close();
  await chmod(path, 0o600);
  const before = await readFile(path);
  await writeFile(join(directory, "token"), "synthetic-proxy-token-0123456789abcdef");
  const config = parseConfig({
    server: { port: 0 },
    auth: { codexHome: "synthetic-auth", tokenFile: "token" },
    storage: { path: "foreign.sqlite" },
  });
  try {
    await expect(startServer(config, join(directory, "config.json"))).rejects.toThrow(
      "foreign database",
    );
    expect(await readFile(path)).toEqual(before);
    config.proxy.translationMode = "raw";
    config.auth.codexHome = ".";
    const raw = await startServer(config, join(directory, "config.json"));
    try {
      expect((await fetch(`${raw.url}/health`)).status).toBe(200);
      expect(await readFile(path)).toEqual(before);
    } finally {
      await raw.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw relay does not create or open configured local storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-raw-"));
  const path = join(directory, "never-created/store.sqlite");
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ upstream: true }),
  });
  const gateway = createResponsesGateway(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      defaultModel: "fixture",
      clientVersion: "fixture",
      translationMode: "raw",
      timeoutMs: 2000,
      maxBodyBytes: 4096,
    },
    async () => ({ accessToken: "fixture", accountId: "a" }),
    { path },
  );
  try {
    const response = await gateway.forward(
      new Request("http://local/v1/responses", {
        method: "POST",
        body: JSON.stringify({ input: "raw", store: true }),
      }),
    );
    expect(await response.json()).toEqual({ upstream: true });
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    gateway.close();
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
