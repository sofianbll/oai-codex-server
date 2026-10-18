import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { createDurableStore, type DurableStoreOptions } from "../src/server/durable-store";
import { createResponsesGateway } from "../src/server/responses-gateway";

async function fixture(limits: DurableStoreOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chat-storage-"));
  const closed = Promise.withResolvers<void>();
  const state = {
    account: "a",
    turn: 0,
    output: [
      {
        id: "msg_final",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Saved" }],
      },
    ] as Record<string, unknown>[],
    partial: false,
    hold: false,
  };
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      close() {
        closed.resolve();
      },
      message(socket) {
        state.turn++;
        if (state.hold) {
          socket.send(
            JSON.stringify({
              type: "response.created",
              response: {
                id: `resp_${state.turn}`,
                created_at: state.turn,
                model: "fixture",
                status: "in_progress",
              },
            }),
          );
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Partial" }));
          return;
        }
        if (state.partial) {
          socket.send(
            JSON.stringify({
              type: "response.created",
              response: {
                id: `resp_${state.turn}`,
                created_at: state.turn,
                model: "fixture",
                status: "in_progress",
              },
            }),
          );
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Partial" }));
          socket.send(
            JSON.stringify({
              type: "response.failed",
              response: {
                id: `resp_${state.turn}`,
                status: "failed",
                error: { code: "fixture_error", message: "Interrupted" },
              },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_${state.turn}`,
              created_at: state.turn,
              model: "fixture",
              status: "completed",
              output: state.output,
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
    maxBodyBytes: 16384,
  };
  let store = createDurableStore({ path: join(directory, "store.sqlite"), ...limits });
  const storage = () => ({ store, ...limits });
  const credentials = async () => ({ accessToken: "fixture", accountId: state.account });
  let gateway = createResponsesGateway(options, credentials, storage());
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
    state,
    closed: closed.promise,
    client,
    url: server.url.origin,
    restart() {
      gateway.close();
      store.close();
      store = createDurableStore({ path: join(directory, "store.sqlite"), ...limits });
      gateway = createResponsesGateway(options, credentials, storage());
    },
    async close() {
      gateway.close();
      store.close();
      await server.stop(true);
      await upstream.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("SDK stored Chat retains its messages and metadata after restart, without storing a Response", async () => {
  const local = await fixture();
  const { client } = local;
  try {
    const result = await client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: [{ type: "text", text: "Keep original" }] }],
      store: true,
      metadata: { project: "test" },
    });
    local.restart();
    expect(await client.chat.completions.retrieve(result.id)).toEqual(result);
    expect(result).toMatchObject({
      object: "chat.completion",
      metadata: { project: "test" },
      choices: [{ message: { content: "Saved" } }],
    });
    const messages = await client.chat.completions.messages.list(result.id);
    expect(messages.data).toMatchObject([
      { role: "user", content: [{ type: "text", text: "Keep original" }] },
      { id: "msg_final", role: "assistant", content: "Saved" },
    ]);
    await expect(client.responses.retrieve("resp_1").asResponse()).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await client.chat.completions.update(result.id, { metadata: { project: "changed" } }),
    ).toMatchObject({ metadata: { project: "changed" } });
    expect(
      (await client.chat.completions.list({ metadata: { project: "changed" } })).data,
    ).toHaveLength(1);
    expect(await client.chat.completions.delete(result.id)).toEqual({
      id: result.id,
      object: "chat.completion.deleted",
      deleted: true,
    });
    await expect(client.chat.completions.retrieve(result.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    const chunks = await client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "streamed" }],
      store: true,
      stream: true,
    });
    let finished = false;
    for await (const chunk of chunks)
      if (chunk.choices[0]?.finish_reason) {
        finished = true;
        expect(await client.chat.completions.retrieve(chunk.id)).toMatchObject({
          choices: [{ message: { content: "Saved" } }],
        });
      }
    expect(finished).toBe(true);
  } finally {
    await local.close();
  }
});

test("Stored Chat paginates completions and original structured tool messages with validated public filters", async () => {
  const local = await fixture();
  const { client } = local;
  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "Lookup" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_input",
            type: "function",
            function: { name: "lookup", arguments: '{"id":1}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_input", content: "one" },
    ];
    local.state.output = [
      {
        id: "fc_output",
        type: "function_call",
        call_id: "call_output",
        name: "next",
        arguments: '{"id":2}',
      },
    ];
    const first = await client.chat.completions.create({
      model: "fixture",
      messages,
      store: true,
      metadata: { project: "x" },
    });
    const second = await client.chat.completions.create({
      model: "fixture",
      messages,
      store: true,
      metadata: { project: "y" },
    });
    const page = await client.chat.completions.list({ limit: 1, order: "desc" });
    expect(page.data.map((row) => row.id)).toEqual([second.id]);
    expect(page.has_more).toBe(true);
    expect((await page.getNextPage()).data.map((row) => row.id)).toEqual([first.id]);
    expect((await client.chat.completions.list({ model: "other" })).data).toEqual([]);
    expect(
      (await client.chat.completions.list({ metadata: { project: "x" } })).data.map(
        (row) => row.id,
      ),
    ).toEqual([first.id]);
    const history = await client.chat.completions.messages.list(first.id, { limit: 2 });
    expect(history.data).toMatchObject(messages.slice(0, 2));
    const tail = await history.getNextPage();
    expect(tail.data).toMatchObject([
      { role: "tool", tool_call_id: "call_input", content: "one" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_output", function: { name: "next", arguments: '{"id":2}' } }],
      },
    ]);
    expect(
      (await client.chat.completions.messages.list(first.id, { order: "desc", limit: 1 })).data[0]
        ?.id,
    ).toBe(tail.data[1]?.id);
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "order=sideways",
      "before=x",
      "after=unknown",
      "limit=1&limit=2",
      "metadata=invalid",
    ]) {
      expect((await fetch(`${local.url}/v1/chat/completions?${query}`)).status).toBe(400);
    }
    expect(await client.chat.completions.update(first.id, { metadata: null })).toMatchObject({
      metadata: null,
    });
  } finally {
    await local.close();
  }
});

test("Chat opt-in preserves metadata without retaining omitted/false creations and rejects null store", async () => {
  const local = await fixture();
  try {
    for (const store of [undefined, false]) {
      const result = await local.client.chat.completions.create({
        model: "fixture",
        messages: [{ role: "user", content: "ephemeral" }],
        ...(store === undefined ? {} : { store }),
        metadata: { tag: "ephemeral" },
      });
      expect(result).toMatchObject({ metadata: { tag: "ephemeral" } });
      await expect(
        local.client.chat.completions.retrieve(result.id).asResponse(),
      ).rejects.toMatchObject({ status: 404 });
    }
    const invalid = await fetch(`${local.url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "invalid" }], store: null }),
    });
    expect(invalid.status).toBe(400);
    expect(local.state.turn).toBe(2);
    expect((await local.client.chat.completions.list()).data).toEqual([]);
  } finally {
    await local.close();
  }
});

test("Stored Chat metadata filters preserve literal punctuation and prototype-like keys", async () => {
  const local = await fixture();
  try {
    const metadata = Object.fromEntries([
      ["a.b", "dot"],
      ['a"b', "quote"],
      ["__proto__", "literal"],
      ["", "empty"],
      ["a]b", "bracket"],
    ]);
    const chat = await local.client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "keys" }],
      store: true,
      metadata,
    });
    expect(chat.metadata).toEqual(metadata);
    for (const [key, value] of Object.entries(metadata)) {
      expect(
        (await local.client.chat.completions.list({ metadata: { [key]: value } })).data.map(
          (row) => row.id,
        ),
      ).toEqual([chat.id]);
      expect(
        (await local.client.chat.completions.list({ metadata: { [key]: "wrong" } })).data,
      ).toEqual([]);
    }
  } finally {
    await local.close();
  }
});

test("Chat shares the global Responses quota across accounts, expires at thirty days and never evicts live objects", async () => {
  let now = 1000;
  const local = await fixture({ maxBytes: 4096, maxRecordBytes: 4096, now: () => now });
  const { client } = local;
  try {
    const response = await client.responses.create({
      model: "fixture",
      input: "reserved by Responses",
      store: true,
    });
    local.state.account = "b";
    await expect(
      client.chat.completions
        .create({ model: "fixture", messages: [{ role: "user", content: "no room" }], store: true })
        .asResponse(),
    ).rejects.toMatchObject({ status: 507, code: "storage_capacity_exceeded" });
    expect(local.state.turn).toBe(1);
    local.state.account = "a";
    expect((await client.responses.retrieve(response.id)).id).toBe(response.id);
    await client.responses.delete(response.id);
    const chat = await client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "private a" }],
      store: true,
    });
    local.state.account = "b";
    expect((await client.chat.completions.list()).data).toEqual([]);
    await expect(client.chat.completions.retrieve(chat.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      client.chat.completions.update(chat.id, { metadata: {} }).asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    await expect(client.chat.completions.delete(chat.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    local.state.account = "a";
    local.restart();
    now += 30 * 24 * 60 * 60 * 1000 - 1;
    await client.chat.completions.update(chat.id, { metadata: { near: "expiry" } });
    now++;
    await expect(client.chat.completions.retrieve(chat.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    expect((await client.chat.completions.list()).data).toEqual([]);
    await client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "space reclaimed from expired data" }],
      store: true,
    });
  } finally {
    await local.close();
  }
});

test("Stored Chat SSE partial failure and oversize commit never emit a successful finish or retain partial history", async () => {
  const local = await fixture({ maxBytes: 3000, maxRecordBytes: 2000 });
  const { client } = local;
  try {
    for (const partial of [true, false]) {
      local.state.partial = partial;
      if (!partial)
        local.state.output = [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "x".repeat(3000) }],
          },
        ];
      const stream = await client.chat.completions.create({
        model: "fixture",
        messages: [{ role: "user", content: "stream" }],
        store: true,
        stream: true,
      });
      let successful = false;
      let failed = false;
      try {
        for await (const chunk of stream) if (chunk.choices[0]?.finish_reason) successful = true;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(successful).toBe(false);
      expect((await client.chat.completions.list()).data).toEqual([]);
    }
    local.state.output = [
      { type: "function_call", call_id: "call_saved", name: "finish", arguments: "{}" },
    ];
    const result = await client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "released capacity" }],
      store: true,
    });
    expect(await client.chat.completions.retrieve(result.id)).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
    });
    expect(local.state.turn).toBe(3);
  } finally {
    await local.close();
  }
});

test("Cancelling a stored Chat stream releases its reservation without saving or reissuing", async () => {
  const local = await fixture({ maxBytes: 4096, maxRecordBytes: 4096 });
  try {
    local.state.hold = true;
    const stream = await local.client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "cancel" }],
      store: true,
      stream: true,
    });
    for await (const chunk of stream)
      if (chunk.choices[0]?.delta.content) {
        await expect(
          local.client.chat.completions
            .create({
              model: "fixture",
              messages: [{ role: "user", content: "concurrent reservation" }],
              store: true,
            })
            .asResponse(),
        ).rejects.toMatchObject({ status: 507 });
        expect(local.state.turn).toBe(1);
        break;
      }
    await local.closed;
    expect((await local.client.chat.completions.list()).data).toEqual([]);
    local.state.hold = false;
    await local.client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "capacity released" }],
      store: true,
    });
    expect(local.state.turn).toBe(2);
  } finally {
    await local.close();
  }
});

test("Changing accounts during a stored Chat generation exposes no completion or success to the new account", async () => {
  const local = await fixture();
  try {
    local.state.hold = true;
    const stream = await local.client.chat.completions.create({
      model: "fixture",
      messages: [{ role: "user", content: "account a" }],
      store: true,
      stream: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    local.state.account = "b";
    expect((await local.client.chat.completions.list()).data).toEqual([]);
    let success = false;
    let failed = false;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.choices[0]?.finish_reason) success = true;
      }
    } catch {
      failed = true;
    }
    expect(success).toBe(false);
    expect(failed).toBe(true);
    expect((await local.client.chat.completions.list()).data).toEqual([]);
    local.state.account = "a";
    expect((await local.client.chat.completions.list()).data).toEqual([]);
    expect(local.state.turn).toBe(1);
  } finally {
    await local.close();
  }
});
