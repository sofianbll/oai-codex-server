import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { parseConfig } from "../src/server/config";
import { createDurableStore, type DurableStoreOptions } from "../src/server/durable-store";
import { createResponsesGateway } from "../src/server/responses-gateway";
import { startServer } from "../src/server/runtime";

test("SDK Conversation metadata and ordered items survive runtime restart and account changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conversations-"));
  await mkdir(join(directory, "auth"));
  const account = (id: string) =>
    writeFile(
      join(directory, "auth/auth.json"),
      JSON.stringify({ tokens: { access_token: `fixture-${id}`, account_id: id } }),
    );
  await account("a");
  const token = "fixture-proxy-token-0123456789abcdef";
  await writeFile(join(directory, "token"), token);
  const config = parseConfig({
    server: { port: 0 },
    auth: { codexHome: "auth", tokenFile: "token" },
    storage: { path: "private/store.sqlite" },
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      throw new Error("Conversation CRUD must not contact an upstream");
    },
  });
  Object.assign(config.proxy, { baseUrl: `${upstream.url.origin}/backend-api/codex` });
  let runtime = await startServer(config, join(directory, "config.json"));
  const client = () => new OpenAI({ baseURL: `${runtime.url}/v1`, apiKey: token, maxRetries: 0 });
  const programs = [
    {
      type: "program" as const,
      id: "program_original",
      call_id: "call_program",
      code: 'throw new Error("inert history only");',
      fingerprint: "opaque\u0000fingerprint/é==",
    },
    {
      type: "program_output" as const,
      id: "program_result",
      call_id: "call_program",
      status: "completed" as const,
      result: '{"nested":{"values":[1,null,"é"]},"__proto__":{"inert":true}}',
    },
  ];
  try {
    const conversation = await client().conversations.create({
      metadata: { purpose: "test" },
      items: [{ role: "user", content: "first" }],
    });
    expect(conversation).toMatchObject({ object: "conversation", metadata: { purpose: "test" } });
    const added = await client().conversations.items.create(conversation.id, {
      items: [
        { role: "user", content: "second" },
        { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{}" },
        ...programs,
      ],
    });
    expect(added).toMatchObject({ object: "list", has_more: false });
    await client().conversations.update(conversation.id, { metadata: { purpose: "updated" } });
    await runtime.stop();
    runtime = await startServer(config, join(directory, "config.json"));
    expect(await client().conversations.retrieve(conversation.id)).toMatchObject({
      metadata: { purpose: "updated" },
      created_at: conversation.created_at,
    });
    const first = await client().conversations.items.list(conversation.id, {
      order: "asc",
      limit: 1,
    });
    expect(first.data).toMatchObject([
      { type: "message", status: "completed", content: [{ type: "input_text", text: "first" }] },
    ]);
    expect(first.has_more).toBe(true);
    const all = [];
    for await (const item of client().conversations.items.list(conversation.id, {
      order: "asc",
      limit: 1,
    }))
      all.push(item);
    expect(all).toHaveLength(5);
    expect(all[2]).toMatchObject({ type: "function_call", call_id: "call_fixture" });
    expect(all.slice(3)).toEqual(programs);
    for (const program of programs)
      expect(
        await client().conversations.items.retrieve(program.id, {
          conversation_id: conversation.id,
        }),
      ).toEqual(program);
    const descending = await client().conversations.items.list(conversation.id, { limit: 1 });
    expect(descending.data[0]?.id).toBe(added.data[3]?.id);
    const itemId = first.data[0]?.id ?? "";
    expect(
      await client().conversations.items.retrieve(itemId, { conversation_id: conversation.id }),
    ).toMatchObject({ id: itemId });
    await account("b");
    await expect(
      client()
        .conversations.items.retrieve("program_original", { conversation_id: conversation.id })
        .asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client().conversations.retrieve(conversation.id).asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client()
        .conversations.items.delete(itemId, { conversation_id: conversation.id })
        .asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    await account("a");
    expect(
      await client().conversations.items.delete(itemId, { conversation_id: conversation.id }),
    ).toMatchObject({
      id: conversation.id,
      object: "conversation",
      metadata: { purpose: "updated" },
    });
    expect(await client().conversations.delete(conversation.id)).toEqual({
      id: conversation.id,
      object: "conversation.deleted",
      deleted: true,
    });
    await expect(
      client().conversations.items.list(conversation.id).asResponse(),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await runtime.stop();
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(
  options: DurableStoreOptions = {},
  generation?: { started: () => void; finish: Promise<void> },
) {
  const directory = await mkdtemp(join(tmpdir(), "conversation-store-"));
  const store = createDurableStore({ path: join(directory, "store.sqlite"), ...options });
  let calls = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response("unexpected upstream", { status: 502 }),
    websocket: {
      async message(socket) {
        calls++;
        generation?.started();
        await generation?.finish;
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_shared",
              object: "response",
              status: "completed",
              output: [
                {
                  id: "msg_budget",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "independent copy", annotations: [] }],
                },
              ],
            },
          }),
        );
      },
    },
  });
  const proxy = {
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    defaultModel: "fixture",
    clientVersion: "fixture",
    translationMode: "minimal" as const,
    maxBodyBytes: 16384,
    timeoutMs: 2000,
  };
  const a = createResponsesGateway(
    proxy,
    async () => ({ accessToken: "fixture", accountId: "a" }),
    { ...options, store },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => a.forward(request),
  });
  const client = new OpenAI({
    baseURL: `${server.url.origin}/v1`,
    apiKey: "fixture",
    maxRetries: 0,
  });
  return {
    client,
    url: server.url.origin,
    calls: () => calls,
    close: async () => {
      a.close();
      store.close();
      await server.stop(true);
      await upstream.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("SDK Conversation metadata round-trips literal prototype-like keys without pollution", async () => {
  const f = await fixture();
  const metadata = JSON.parse('{"__proto__":"literal","constructor":"data","prototype":"value"}');
  try {
    const created = await f.client.conversations.create({ metadata });
    expect(created.metadata).toEqual(metadata);
    expect((await f.client.conversations.retrieve(created.id)).metadata).toEqual(metadata);
    const updated = JSON.parse('{"__proto__":"updated","toString":"literal"}');
    expect(
      (await f.client.conversations.update(created.id, { metadata: updated })).metadata,
    ).toEqual(updated);
    for (const invalid of [
      { key: 1 },
      { key: null },
      { key: "x".repeat(513) },
      { ["x".repeat(65)]: "value" },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, "value"])),
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ]) {
      await expect(
        f.client.conversations.update(created.id, { metadata: invalid }).asResponse(),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect((await f.client.conversations.retrieve(created.id)).metadata).toEqual(updated);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("twenty-item batches validate every public item before mutation, reject collisions and serialize concurrent adds", async () => {
  const f = await fixture();
  const request = (path: string, value: unknown) =>
    fetch(`${f.url}/v1${path}`, { method: "POST", body: JSON.stringify(value) });
  try {
    const items = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `initial-${i}`,
    }));
    expect((await request("/conversations", { items: [...items, items[0]] })).status).toBe(400);
    const conversation = await f.client.conversations.create({ items });
    expect(
      (await f.client.conversations.items.list(conversation.id, { limit: 100 })).data,
    ).toHaveLength(20);
    for (const bad of [
      { type: "made_up", value: "no" },
      { type: "function_call", arguments: {} },
      { role: "user", content: [{ type: "input_text", text: 1 }] },
      { role: "user", content: [{ type: "output_text", text: "invalid role", annotations: [] }] },
      { type: "program", id: "program_bad", call_id: "call", code: "inert" },
      { type: "program", id: "program_bad", call_id: "call", code: 1, fingerprint: "opaque" },
      {
        type: "program_output",
        id: "program_bad",
        call_id: "call",
        result: "opaque",
        status: "in_progress",
      },
      { type: "program_output", id: "program_bad", call_id: "call", status: "completed" },
      {
        type: "program_output",
        id: "program_bad",
        call_id: "call",
        result: {},
        status: "completed",
      },
    ]) {
      expect(
        (
          await request(`/conversations/${conversation.id}/items`, {
            items: [{ role: "user", content: "must not persist" }, bad],
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (await request(`/conversations/${conversation.id}/items`, { items: [...items, items[0]] }))
        .status,
    ).toBe(400);
    expect(
      (await request(`/conversations/${conversation.id}`, { metadata: { x: "a".repeat(513) } }))
        .status,
    ).toBe(400);
    const duplicate = {
      type: "function_call",
      id: "fc_collision",
      call_id: "call_unique",
      name: "fixture",
      arguments: "{}",
    };
    const results = await Promise.all([
      request(`/conversations/${conversation.id}/items`, { items: [duplicate] }),
      request(`/conversations/${conversation.id}/items`, { items: [duplicate] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(
      (await f.client.conversations.items.list(conversation.id, { limit: 100 })).data,
    ).toHaveLength(21);
    expect(
      (
        await request(`/conversations/${conversation.id}/items`, {
          items: [{ role: "user", content: "rollback" }, duplicate],
        })
      ).status,
    ).toBe(400);
    const added = await f.client.conversations.items.create(conversation.id, { items });
    expect(added.data).toHaveLength(20);
    const all = await f.client.conversations.items.list(conversation.id, {
      order: "asc",
      limit: 100,
    });
    expect(all.data).toHaveLength(41);
    await expect(
      f.client.conversations.items.list(conversation.id, { after: "foreign_cursor" }).asResponse(),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("Conversations and Response reservations share one budget and deleting the container does not purge a Response copy", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const f = await fixture(
    { maxBytes: 2048, maxRecordBytes: 1024 },
    { started: () => started.resolve(), finish: finish.promise },
  );
  try {
    const pending = f.client.responses
      .create({ model: "fixture", input: "short", store: true })
      .then((response) => response);
    await started.promise;
    const items = [
      {
        type: "message" as const,
        id: "msg_budget",
        role: "user" as const,
        content: "x".repeat(600),
      },
    ];
    await expect(f.client.conversations.create({ items }).asResponse()).rejects.toMatchObject({
      status: 507,
    });
    finish.resolve();
    await pending;
    const conversation = await f.client.conversations.create({ items });
    expect((await f.client.conversations.items.list(conversation.id)).data).toHaveLength(1);
    await expect(
      f.client.responses.create({ model: "fixture", input: "blocked", store: true }).asResponse(),
    ).rejects.toMatchObject({ status: 507 });
    await f.client.conversations.delete(conversation.id);
    await expect(
      f.client.responses
        .create({ model: "fixture", input: "still counted", store: true })
        .asResponse(),
    ).rejects.toMatchObject({ status: 507 });
    expect((await f.client.responses.retrieve("resp_shared")).output_text).toBe("independent copy");
    expect(f.calls()).toBe(1);
  } finally {
    finish.resolve();
    await f.close();
  }
});

test("quota rollback is atomic and deleting a Conversation retains orphan items in the shared budget without TTL", async () => {
  let now = 1_800_000_000_000;
  const f = await fixture({ maxRecords: 4, now: () => now });
  try {
    const conversation = await f.client.conversations.create();
    await expect(
      f.client.conversations.items
        .create(conversation.id, {
          items: [
            {
              type: "program",
              id: "program_quota",
              call_id: "call_quota",
              code: "inert",
              fingerprint: "opaque",
            },
            {
              type: "program_output",
              id: "program_quota_result",
              call_id: "call_quota",
              result: "opaque",
              status: "incomplete",
            },
          ],
        })
        .asResponse(),
    ).rejects.toMatchObject({ status: 507 });
    expect((await f.client.conversations.items.list(conversation.id)).data).toEqual([]);
    await expect(
      f.client.conversations.items
        .create(conversation.id, {
          items: [
            {
              type: "program_output",
              id: "program_oversize",
              call_id: "call_quota",
              result: "x".repeat(17000),
              status: "completed",
            },
          ],
        })
        .asResponse(),
    ).rejects.toMatchObject({ status: 413 });
    const added = await f.client.conversations.items.create(conversation.id, {
      items: [{ role: "user", content: "retained" }],
    });
    now += 60 * 24 * 60 * 60 * 1000;
    expect((await f.client.conversations.items.list(conversation.id)).data[0]?.id).toBe(
      added.data[0]?.id,
    );
    await f.client.conversations.delete(conversation.id);
    const next = await f.client.conversations.create();
    await expect(
      f.client.conversations.items
        .create(next.id, { items: [{ role: "user", content: "quota" }] })
        .asResponse(),
    ).rejects.toMatchObject({ status: 507 });
    expect((await f.client.conversations.items.list(next.id)).data).toEqual([]);
    // Orphan content remains counted after its container is gone; it has no public retrieval route.
    await expect(
      f.client.conversations.items
        .retrieve(added.data[0]?.id ?? "", { conversation_id: conversation.id })
        .asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});
