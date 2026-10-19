import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { createDurableStore } from "../src/server/durable-store";
import { createResponsesGateway } from "../src/server/responses-gateway";

type Json = Record<string, unknown>;

test("SDK Conversation tool-result presentation defaults never enter the next upstream request", async () => {
  const f = await fixture();
  const result = {
    type: "function_call_output" as const,
    call_id: "call_presentation",
    output: "provided result",
  };
  try {
    const c = await f.client.conversations.create();
    await f.client.responses.create({ model: "fixture", conversation: c.id, input: [result] });
    expect((await f.client.conversations.items.list(c.id, { order: "asc" })).data[0]).toMatchObject(
      { ...result, status: "completed" },
    );
    f.restart();
    await f.client.responses.create({ model: "fixture", conversation: c.id, input: "next" });
    const input = f.received[1]?.["input"] as Json[];
    expect(input[0]).toEqual(result);
    expect(input[0]).not.toHaveProperty("status");
    expect((await f.client.conversations.items.list(c.id, { order: "asc" })).data[0]).toMatchObject(
      { ...result, status: "completed" },
    );
  } finally {
    await f.close();
  }
});

test("SDK Responses do not silently complete a program_output missing its required status", async () => {
  const f = await fixture();
  try {
    const c = await f.client.conversations.create();
    await expect(
      f.client
        .post("/responses", {
          body: {
            model: "fixture",
            conversation: c.id,
            input: [
              {
                type: "program_output",
                id: "program_without_status",
                call_id: "call_program",
                result: "provided",
              },
            ],
          },
        })
        .asResponse(),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.received).toHaveLength(0);
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(0);
  } finally {
    await f.close();
  }
});

async function fixture(
  reply?: (socket: { send(value: string): void; close(): void }, input: Json, n: number) => void,
  limits: { maxRecords?: number; maxBytes?: number } = {},
  sharedStore = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "conversation-responses-"));
  const received: Json[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      message(socket, raw) {
        const input = JSON.parse(String(raw)) as Json;
        received.push(input);
        if (reply) reply(socket, input, received.length);
        else
          socket.send(
            JSON.stringify({
              type: "response.completed",
              response: {
                id: `resp_${received.length}`,
                object: "response",
                status: "completed",
                output: [
                  {
                    type: "message",
                    id: `msg_${received.length}`,
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "reply", annotations: [] }],
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
    timeoutMs: 1000,
    maxBodyBytes: 65536,
  };
  const path = join(directory, "store.sqlite");
  const injected = sharedStore ? createDurableStore({ path, ...limits }) : undefined;
  const storage = { path, ...limits, ...(injected ? { store: injected } : {}) };
  let accountId = "a";
  const credentials = async () => ({ accessToken: "fixture", accountId });
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
    received,
    url: server.url.origin,
    account(id: string) {
      accountId = id;
    },
    restart() {
      gateway.close();
      gateway = createResponsesGateway(options, credentials, storage);
    },
    async close() {
      gateway.close();
      await server.stop(true);
      await upstream.stop(true);
      injected?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("SDK Conversation prefixes all items once and retains successive turns without storing Responses, including after restart", async () => {
  const f = await fixture();
  try {
    const c = await f.client.conversations.create({ items: [{ role: "user", content: "seed" }] });
    const first = await f.client.responses.create({
      model: "fixture",
      conversation: c.id,
      input: "first",
      store: false,
    });
    expect(first.conversation).toEqual({ id: c.id });
    expect(f.received[0]).not.toHaveProperty("conversation");
    expect(f.received[0]?.["input"]).toMatchObject([
      { role: "user", content: "seed" },
      { role: "user", content: [{ type: "input_text", text: "first" }] },
    ]);
    await expect(f.client.responses.retrieve(first.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    f.restart();
    const second = await f.client.responses.create({
      model: "fixture",
      conversation: { id: c.id },
      input: "second",
    });
    expect(second.conversation).toEqual({ id: c.id });
    expect(f.received[1]?.["input"]).toMatchObject([
      { role: "user", content: "seed" },
      { role: "user", content: [{ text: "first" }] },
      { role: "assistant", content: [{ text: "reply" }] },
      { role: "user", content: [{ text: "second" }] },
    ]);
    const items = await f.client.conversations.items.list(c.id, { order: "asc" });
    expect(items.data).toHaveLength(5);
    expect(items.data.map((item) => item.type)).toEqual([
      "message",
      "message",
      "message",
      "message",
      "message",
    ]);
  } finally {
    await f.close();
  }
});

test("SDK stopped foreground SSE releases its Conversation even when an injected store is reused before the old subscriber drains", async () => {
  const f = await fixture(
    (socket, _input, n) =>
      socket.send(
        JSON.stringify({
          type: "response.created",
          response: { id: `resp_open_${n}`, object: "response", status: "in_progress", output: [] },
        }),
      ),
    {},
    true,
  );
  try {
    const c = await f.client.conversations.create();
    const stream = await f.client.responses.create({
      model: "fixture",
      conversation: c.id,
      input: "never terminal",
      stream: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("response.created");
    f.restart();
    expect((await f.client.conversations.update(c.id, { metadata: {} })).id).toBe(c.id);
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(0);
    stream.controller.abort();
  } finally {
    await f.close();
  }
});

test("HTTP JSON and SDK SSE append actual native terminals atomically with true item statuses before publication", async () => {
  const f = await fixture((socket, input, n) => {
    const status = (input["metadata"] as Json)["status"];
    const item = {
      type: "message",
      id: `msg_terminal_${n}`,
      role: "assistant",
      status: status === "completed" ? "completed" : "incomplete",
      content: [{ type: "output_text", text: "partial", annotations: [] }],
    };
    socket.send(
      JSON.stringify({
        type: "response.created",
        response: { id: `resp_${n}`, object: "response", status: "in_progress", output: [] },
      }),
    );
    socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
    socket.send(
      JSON.stringify({
        type: `response.${status}`,
        response: { id: `resp_${n}`, object: "response", status, output: [] },
      }),
    );
  });
  try {
    for (const stream of [false, true])
      for (const status of ["completed", "failed", "incomplete", "cancelled"] as const) {
        const c = await f.client.conversations.create();
        const body = {
          model: "fixture",
          conversation: c.id,
          input: "new",
          store: true,
          stream,
          metadata: { status },
        };
        if (stream) {
          const events = await f.client.responses.create({ ...body, stream: true });
          let terminal = false;
          for await (const event of events) {
            const value = event as unknown as Json;
            if (value["response"])
              expect((value["response"] as Json)["conversation"]).toEqual({ id: c.id });
            if (value["type"] === `response.${status}`) {
              terminal = true;
              expect((value["response"] as Json)["status"]).toBe(status);
              expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(2);
            }
          }
          expect(terminal).toBe(true);
        } else {
          const response = await fetch(`${f.url}/v1/responses`, {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          });
          expect(response.status).toBe(status === "completed" ? 200 : 502);
          expect(await response.json()).toMatchObject({
            status,
            conversation: { id: c.id },
            output: [{ content: [{ text: "partial" }] }],
          });
        }
        const items = (await f.client.conversations.items.list(c.id, { order: "asc" })).data;
        expect(items).toMatchObject([
          { type: "message", role: "user" },
          {
            type: "message",
            status: status === "completed" ? "completed" : "incomplete",
            content: [{ text: "partial" }],
          },
        ]);
        expect(items).toHaveLength(2);
      }
  } finally {
    await f.close();
  }
});

test("HTTP rejects conflicting associations, invalid envelopes and non-projectable inert history before generation", async () => {
  const f = await fixture();
  try {
    const c = await f.client.conversations.create();
    for (const conversation of [c.id, { id: c.id }]) {
      await expect(
        f.client
          .post("/responses", {
            body: {
              model: "fixture",
              conversation,
              previous_response_id: "resp_missing",
              input: "no",
              background: true,
            },
          })
          .asResponse(),
      ).rejects.toMatchObject({ status: 400 });
    }
    for (const conversation of [false, "", {}, { id: null }, { id: c.id, extra: true }])
      await expect(
        f.client
          .post("/responses", { body: { model: "fixture", conversation, input: "no" } })
          .asResponse(),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.client
        .post("/responses", {
          body: { model: "fixture", conversation: c.id, input: "no", store: null },
        })
        .asResponse(),
    ).rejects.toMatchObject({ status: 400 });
    await f.client.conversations.items.create(c.id, {
      items: [
        { type: "message", id: "msg_inert", role: "assistant", status: "incomplete", content: [] },
      ],
    });
    await expect(
      f.client.responses.create({ model: "fixture", conversation: c.id, input: "no" }).asResponse(),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.received).toHaveLength(0);
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("SDK generations lock only their Conversation, reject all concurrent mutations and release after foreground abort", async () => {
  const started = Promise.withResolvers<void>();
  const f = await fixture((_socket, input) => {
    if (input["metadata"]) started.resolve();
  });
  const abort = new AbortController();
  try {
    const c = await f.client.conversations.create({ items: [{ role: "user", content: "seed" }] });
    const seed = (await f.client.conversations.items.list(c.id)).data[0];
    const pending = f.client.responses
      .create(
        { model: "fixture", conversation: c.id, input: "hold", metadata: { hold: "true" } },
        { signal: abort.signal },
      )
      .then(
        () => "unexpected",
        () => "aborted",
      );
    await started.promise;
    await expect(
      f.client.responses
        .create({ model: "fixture", conversation: c.id, input: "conflict" })
        .asResponse(),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.client.conversations.update(c.id, { metadata: {} }).asResponse(),
    ).rejects.toMatchObject({ status: 409 });
    await expect(f.client.conversations.delete(c.id).asResponse()).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      f.client.conversations.items
        .create(c.id, { items: [{ role: "user", content: "conflict" }] })
        .asResponse(),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.client.conversations.items.delete(seed?.id ?? "", { conversation_id: c.id }).asResponse(),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(1);
    const other = await f.client.conversations.create();
    expect(
      (await f.client.conversations.update(other.id, { metadata: { independent: "yes" } }))
        .metadata,
    ).toEqual({ independent: "yes" });
    abort.abort();
    expect(await pending).toBe("aborted");
    await Bun.sleep(30);
    expect(
      (
        await f.client.conversations.items.create(c.id, {
          items: [{ role: "user", content: "after abort" }],
        })
      ).data,
    ).toHaveLength(1);
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(2);
    expect(f.received).toHaveLength(1);
  } finally {
    abort.abort();
    await f.close();
  }
});

test("SDK tool turns include more than twenty ordered items and previous_response_id replays its snapshot without mutating the Conversation", async () => {
  const tool = {
    type: "function_call" as const,
    id: "fc_original",
    call_id: "call_original",
    status: "completed" as const,
    name: "lookup",
    arguments: '{"key":7}',
  };
  const f = await fixture((socket, _input, n) =>
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: {
          id: `resp_${n}`,
          object: "response",
          status: "completed",
          output: n === 1 ? [tool] : [],
        },
      }),
    ),
  );
  try {
    const c = await f.client.conversations.create();
    for (let i = 0; i < 23; i++)
      await f.client.conversations.items.create(c.id, {
        items: [{ role: "user", content: `seed ${i}` }],
      });
    const first = await f.client.responses.create({
      model: "fixture",
      conversation: c.id,
      input: "lookup",
      instructions: "THIS TURN ONLY",
      store: true,
    });
    expect((await f.client.responses.inputItems.list(first.id)).data).toMatchObject([
      { role: "user", content: [{ text: "lookup" }] },
    ]);
    expect((await f.client.responses.inputItems.list(first.id)).data).toHaveLength(1);
    expect(f.received[0]?.["input"] as unknown[]).toHaveLength(24);
    const result = {
      type: "function_call_output" as const,
      call_id: "call_original",
      output: '{"value":42}',
    };
    f.restart();
    const second = await f.client.responses.create({
      model: "fixture",
      conversation: c.id,
      input: [result],
      store: true,
    });
    expect(f.received[1]?.["input"]).toMatchObject([
      ...Array.from({ length: 23 }, (_, i) => ({ role: "user", content: `seed ${i}` })),
      { role: "user", content: [{ text: "lookup" }] },
      tool,
      result,
    ]);
    expect(await f.client.conversations.items.retrieve(tool.id, { conversation_id: c.id })).toEqual(
      tool,
    );
    const before = (await f.client.conversations.items.list(c.id, { limit: 100, order: "asc" }))
      .data;
    expect(before).toHaveLength(26);
    expect(before.at(-1)).toMatchObject({ ...result, status: "completed" });
    f.restart();
    const branch = await f.client.responses.create({
      model: "fixture",
      previous_response_id: first.id,
      input: "branch",
    });
    expect(branch.conversation).toBeUndefined();
    expect(f.received[2]?.["instructions"]).toBe("");
    expect(f.received[2]?.["input"]).toMatchObject([
      ...Array.from({ length: 23 }, (_, i) => ({ role: "user", content: `seed ${i}` })),
      { role: "user", content: [{ text: "lookup" }] },
      tool,
      { role: "user", content: [{ text: "branch" }] },
    ]);
    expect(
      (await f.client.conversations.items.list(c.id, { limit: 100, order: "asc" })).data,
    ).toEqual(before);
    await f.client.responses.create({
      model: "fixture",
      previous_response_id: second.id,
      input: "original tool result",
    });
    const replayed = f.received[3]?.["input"] as Json[];
    expect(replayed.at(-2)).toEqual(result);
  } finally {
    await f.close();
  }
});

test("SDK explicit null is unassociated, null previous is not a conflict, and Conversation state stays account-isolated", async () => {
  const f = await fixture();
  try {
    const c = await f.client.conversations.create();
    const detached = await f.client.responses.create({
      model: "fixture",
      conversation: null,
      input: "unassociated",
    });
    expect(detached.conversation ?? null).toBeNull();
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(0);
    await f.client.responses.create({
      model: "fixture",
      conversation: c.id,
      previous_response_id: null,
      input: "account a",
    });
    f.account("b");
    await expect(
      f.client.responses
        .create({ model: "fixture", conversation: c.id, input: "foreign" })
        .asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.client.conversations.items.list(c.id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    f.account("a");
    f.restart();
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(2);
    expect(f.received).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("SDK quota failures roll back the entire terminal turn and Response/job publication without hidden partial items", async () => {
  for (const background of [false, true])
    for (const stream of [false, true]) {
      const f = await fixture(
        (socket, _input, n) =>
          socket.send(
            JSON.stringify({
              type: "response.completed",
              response: {
                id: `resp_quota_${n}`,
                object: "response",
                status: "completed",
                output: [0, 1].map((i) => ({
                  type: "message",
                  id: `msg_quota_${i}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "quota", annotations: [] }],
                })),
              },
            }),
          ),
        { maxRecords: 8 },
      );
      try {
        const c = await f.client.conversations.create({
          items: [{ role: "user", content: "seed" }],
        });
        const body = {
          model: "fixture",
          conversation: c.id,
          input: "new",
          store: true,
          background,
        };
        if (stream) {
          let completed = false;
          const events = await f.client.responses.create({ ...body, stream: true });
          try {
            for await (const event of events)
              if (event.type === "response.completed") completed = true;
          } catch {
            /* Expected explicit storage error. */
          }
          expect(completed).toBe(false);
        } else if (background) {
          const job = await f.client.responses.create(body);
          expect((await finalJob(f.client, job.id)).status).toBe("failed");
        } else
          await expect(f.client.responses.create(body).asResponse()).rejects.toMatchObject({
            status: 507,
          });
        expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(1);
        await expect(
          f.client.responses.retrieve("resp_quota_1").asResponse(),
        ).rejects.toMatchObject({ status: 404 });
        expect((await f.client.conversations.update(c.id, { metadata: {} })).id).toBe(c.id);
        expect(f.received).toHaveLength(1);
      } finally {
        await f.close();
      }
    }
});

test("SDK rejects an oversized ordered prefix and unavailable shared capacity before generation, leaving history usable", async () => {
  for (const limited of [false, true]) {
    const f = await fixture(undefined, limited ? { maxBytes: 4096 } : {});
    try {
      const c = await f.client.conversations.create();
      if (!limited)
        for (let i = 0; i < 2; i++)
          await f.client.conversations.items.create(c.id, {
            items: [{ role: "user", content: "x".repeat(40000) }],
          });
      await expect(
        f.client.responses
          .create({ model: "fixture", conversation: c.id, input: "new" })
          .asResponse(),
      ).rejects.toMatchObject({ status: limited ? 507 : 413 });
      expect(f.received).toHaveLength(0);
      expect((await f.client.conversations.update(c.id, { metadata: {} })).id).toBe(c.id);
    } finally {
      await f.close();
    }
  }
});

test("HTTP malformed native terminal items produce a qualified error, no partial turn and no stored successful Response", async () => {
  const f = await fixture((socket, _input, n) =>
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: {
          id: `resp_invalid_${n}`,
          object: "response",
          status: "completed",
          output: [null],
        },
      }),
    ),
  );
  try {
    const c = await f.client.conversations.create();
    const result = await fetch(`${f.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", conversation: c.id, input: "new", store: true }),
    });
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: "invalid_conversation_output" } });
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(0);
    await expect(f.client.responses.retrieve("resp_invalid_1").asResponse()).rejects.toMatchObject({
      status: 404,
    });
    expect((await f.client.conversations.update(c.id, { metadata: {} })).id).toBe(c.id);
  } finally {
    await f.close();
  }
});

async function finalJob(client: OpenAI, id: string) {
  for (let i = 0; i < 400; i++) {
    const value = await client.responses.retrieve(id);
    if (!["queued", "in_progress"].includes(value.status ?? "")) return value;
    await Bun.sleep(5);
  }
  throw new Error("Background job did not finish");
}

test("SDK background JSON/SSE prefix and commit every native terminal before polling or streaming, without duplicate append on replay/cancel/restart", async () => {
  const f = await fixture((socket, input, n) => {
    const status = (input["metadata"] as Json)["status"];
    socket.send(
      JSON.stringify({
        type: `response.${status}`,
        response: {
          id: `resp_native_${n}`,
          object: "response",
          status,
          output: [
            {
              type: "message",
              id: `msg_bg_${n}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "background", annotations: [] }],
            },
          ],
        },
      }),
    );
  });
  try {
    for (const stream of [false, true])
      for (const status of ["completed", "failed", "incomplete", "cancelled"] as const) {
        const c = await f.client.conversations.create({
          items: [{ role: "user", content: "prefix" }],
        });
        const body = {
          model: "fixture",
          conversation: c.id,
          input: "new",
          background: true,
          store: false,
          metadata: { status },
        };
        let id: string;
        if (stream) {
          let terminal = false;
          id = "";
          const events = await f.client.responses.create({ ...body, stream: true });
          for await (const event of events) {
            const value = event as unknown as Json;
            if (value["response"]) {
              const response = value["response"] as Json;
              id = String(response["id"]);
              expect(response["conversation"]).toEqual({ id: c.id });
              if (value["type"] === `response.${status}`) {
                terminal = true;
                expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(3);
              }
            }
          }
          expect(terminal).toBe(true);
          const replay = await f.client.responses.retrieve(id, { stream: true, starting_after: 0 });
          for await (const _event of replay) {
            /* Public replay must not generate or append. */
          }
        } else {
          const queued = await f.client.responses.create(body);
          id = queued.id;
          expect(queued.conversation).toEqual({ id: c.id });
        }
        expect(await finalJob(f.client, id)).toMatchObject({
          status,
          conversation: { id: c.id },
          store: false,
        });
        expect((await f.client.responses.cancel(id)).status).toBe(status);
        f.restart();
        expect((await f.client.responses.retrieve(id)).status).toBe(status);
        expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(3);
        expect(f.received.at(-1)).not.toHaveProperty("conversation");
        expect(f.received.at(-1)?.["input"]).toMatchObject([
          { role: "user", content: "prefix" },
          { role: "user", content: [{ text: "new" }] },
        ]);
      }
    expect(f.received).toHaveLength(8);
  } finally {
    await f.close();
  }
});

test("SDK foreground/background errors, EOF and timeout do not append partial output and release the Conversation", async () => {
  const f = await fixture((socket, input, n) => {
    const mode = (input["metadata"] as Json)["mode"];
    socket.send(
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: `msg_partial_${n}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "not a terminal", annotations: [] }],
        },
      }),
    );
    if (mode === "error")
      socket.send(
        JSON.stringify({
          type: "error",
          error: { code: "fixture_error", message: "No terminal Response" },
        }),
      );
    if (mode === "eof") socket.close();
  });
  try {
    for (const background of [false, true])
      for (const stream of [false, true])
        for (const mode of ["error", "eof", "timeout"]) {
          const c = await f.client.conversations.create();
          const body = {
            model: "fixture",
            conversation: c.id,
            input: "not retained",
            background,
            store: false,
            metadata: { mode },
          };
          let id: string | undefined;
          if (stream) {
            const events = await f.client.responses.create({ ...body, stream: true });
            try {
              for await (const event of events)
                if (event.type === "response.created") id = event.response.id;
            } catch {
              /* SDK exposes the stream error; neither deltas nor local failure are a native terminal. */
            }
          } else if (background) id = (await f.client.responses.create(body)).id;
          else {
            const response = await fetch(`${f.url}/v1/responses`, {
              method: "POST",
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            });
            expect(response.ok).toBe(false);
            await response.text();
          }
          if (background && id) expect((await finalJob(f.client, id)).status).toBe("failed");
          await Bun.sleep(5);
          expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(0);
          expect(
            (await f.client.conversations.update(c.id, { metadata: { released: "yes" } })).metadata,
          ).toEqual({ released: "yes" });
        }
    expect(f.received).toHaveLength(12);
  } finally {
    await f.close();
  }
}, 15000);

test("SDK background subscriber disconnect is not cancellation; local cancel and interrupted restart never append", async () => {
  const started = Promise.withResolvers<{ send(value: string): void; close(): void }>();
  const f = await fixture((socket) => {
    started.resolve(socket);
  });
  try {
    const c = await f.client.conversations.create();
    const events = await f.client.responses.create({
      model: "fixture",
      conversation: c.id,
      input: "detached",
      background: true,
      stream: true,
    });
    let id = "";
    for await (const event of events)
      if (event.type === "response.created") {
        id = event.response.id;
        break;
      }
    const socket = await started.promise;
    await expect(
      f.client.conversations.update(c.id, { metadata: {} }).asResponse(),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(0);
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_detached", object: "response", status: "completed", output: [] },
      }),
    );
    expect((await finalJob(f.client, id)).status).toBe("completed");
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(1);
    for (const action of ["cancel", "restart"]) {
      const next = await f.client.responses.create({
        model: "fixture",
        conversation: c.id,
        input: "never appended",
        background: true,
      });
      if (action === "cancel") {
        expect((await f.client.responses.cancel(next.id)).status).toBe("cancelled");
        expect((await f.client.responses.cancel(next.id)).status).toBe("cancelled");
      } else {
        f.restart();
        expect(await f.client.responses.retrieve(next.id)).toMatchObject({
          status: "failed",
          error: { code: "background_interrupted" },
        });
      }
      expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(1);
      expect((await f.client.conversations.update(c.id, { metadata: {} })).id).toBe(c.id);
    }
  } finally {
    await f.close();
  }
});

test("HTTP refuses unmaterializable new inputs, collisions and non-generative message roles before any native emission", async () => {
  const f = await fixture();
  try {
    const c = await f.client.post<{ id: string }>("/conversations", {
      body: { items: [{ type: "message", id: "msg_retained", role: "user", content: "seed" }] },
    });
    for (const input of [
      [{ type: "function_call_output", call_id: "x", output: 42 }],
      [{ type: "item_reference", id: "msg_retained" }],
      [{ type: "message", id: "msg_retained", role: "user", content: "collision" }],
    ]) {
      const result = await fetch(`${f.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", conversation: c.id, input }),
        headers: { "content-type": "application/json" },
      });
      expect([400, 501]).toContain(result.status);
    }
    const inert = await f.client.post<{ id: string }>("/conversations", {
      body: {
        items: [
          {
            type: "message",
            id: "msg_critic",
            role: "critic",
            status: "completed",
            content: [{ type: "input_text", text: "inert" }],
          },
        ],
      },
    });
    await expect(
      f.client.responses
        .create({ model: "fixture", conversation: inert.id, input: "no" })
        .asResponse(),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.received).toHaveLength(0);
    expect((await f.client.conversations.items.list(c.id)).data).toHaveLength(1);
  } finally {
    await f.close();
  }
});
