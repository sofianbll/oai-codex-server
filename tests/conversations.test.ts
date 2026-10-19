import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { parseConfig } from "../src/server/config";
import { createDurableStore, type DurableStoreOptions } from "../src/server/durable-store";
import { createResponsesGateway } from "../src/server/responses-gateway";
import { startServer } from "../src/server/runtime";
import {
  history,
  historyFamilies,
  historyTools,
  noMissingHistoryFamily,
} from "./fixtures/conversation-history";

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
        {
          type: "function_call",
          call_id: "call_fixture",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        },
        ...programs,
      ],
    });
    expect(added).toMatchObject({ object: "list", has_more: false });
    for (let i = 0; i < history.length; i += 20)
      await client().post(`/conversations/${conversation.id}/items`, {
        body: { items: history.slice(i, i + 20) },
      });
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
    expect(all).toHaveLength(5 + history.length);
    expect(all[2]).toMatchObject({ type: "function_call", call_id: "call_fixture" });
    expect(all.slice(3, 5)).toEqual(programs);
    expect(all.slice(5)).toEqual(history);
    for (const program of programs)
      expect(
        await client().conversations.items.retrieve(program.id, {
          conversation_id: conversation.id,
        }),
      ).toEqual(program);
    const descending = await client().conversations.items.list(conversation.id, { limit: 1 });
    expect(descending.data[0]?.id).toBe(history.at(-1)?.id);
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

test("mixed assistant shorthand preserves each input and output part through public CRUD", async () => {
  const f = await fixture();
  const input = {
    role: "assistant",
    content: [
      { type: "input_text", text: "input" },
      { type: "output_text", text: "output", annotations: [] },
    ],
  };
  try {
    const created = await fetch(`${f.url}/v1/conversations`, {
      method: "POST",
      body: JSON.stringify({ items: [input] }),
    });
    expect(created.status).toBe(200);
    const conversation = (await created.json()) as { id: string };
    const first = await f.client.conversations.items.list(conversation.id, { order: "asc" });
    const firstId = first.data[0]?.id ?? "";
    expect(firstId).toMatch(/^msg_/);
    const expectedFirst = {
      id: firstId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "input_text", text: "input" },
        { type: "output_text", text: "output", annotations: [] },
      ],
    };
    expect(first.data as unknown).toEqual([expectedFirst]);
    expect(
      (await f.client.conversations.items.retrieve(firstId, {
        conversation_id: conversation.id,
      })) as unknown,
    ).toEqual(expectedFirst);
    const secondInput = {
      role: "assistant",
      phase: "commentary",
      status: "incomplete",
      content: [
        { type: "output_text", text: "second output", annotations: [] },
        { type: "input_text", text: "second input" },
      ],
    };
    const added = await fetch(`${f.url}/v1/conversations/${conversation.id}/items`, {
      method: "POST",
      body: JSON.stringify({ items: [secondInput] }),
    });
    expect(added.status).toBe(200);
    const page = await f.client.conversations.items.list(conversation.id, { order: "asc" });
    const secondId = page.data[1]?.id ?? "";
    expect(secondId).toMatch(/^msg_/);
    const expectedSecond = { ...secondInput, id: secondId, type: "message" };
    expect((await added.json()) as unknown).toMatchObject({ data: [expectedSecond] });
    expect(page.data as unknown).toEqual([expectedFirst, expectedSecond]);
    expect(
      (await f.client.conversations.items.retrieve(secondId, {
        conversation_id: conversation.id,
      })) as unknown,
    ).toEqual(expectedSecond);
    for (const bad of [
      { ...input, content: [{ type: "input_text", text: 1 }, input.content[1]] },
      { ...input, content: [input.content[0], { type: "output_text", text: 1, annotations: [] }] },
      {
        ...input,
        content: [
          input.content[0],
          { type: "output_text", text: "output", annotations: "invalid" },
        ],
      },
      { ...input, content: [input.content[0], { type: "unknown_part", text: "invalid" }] },
      { ...input, role: "user" },
      { ...input, role: "system" },
      { ...input, role: "developer" },
      { ...input, phase: "invalid" },
      { ...input, status: "invalid" },
    ]) {
      const rejected = await fetch(`${f.url}/v1/conversations/${conversation.id}/items`, {
        method: "POST",
        body: JSON.stringify({ items: [{ role: "user", content: "must roll back" }, bad] }),
      });
      expect(rejected.status).toBe(400);
    }
    expect(
      (await f.client.conversations.items.list(conversation.id, { order: "asc" })).data as unknown,
    ).toEqual([expectedFirst, expectedSecond]);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("inert public history covers every SDK family without executing or rewriting opaque data", async () => {
  const f = await fixture();
  try {
    expect(noMissingHistoryFamily).toBe(true);
    expect(history.map((item) => item.type).sort()).toEqual([...historyFamilies].sort());
    expect(new Set(historyTools.map((tool) => tool.type)).size).toBe(16);
    const conversation = await f.client.conversations.create();
    for (let i = 0; i < history.length; i += 20) {
      const items = history.slice(i, i + 20);
      const response = await fetch(`${f.url}/v1/conversations/${conversation.id}/items`, {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: items });
    }
    const all = [];
    for await (const item of f.client.conversations.items.list(conversation.id, {
      order: "asc",
      limit: 2,
    }))
      all.push(item);
    expect(all).toEqual(history);
    for (const item of history)
      expect(
        await f.client.conversations.items.retrieve(item.id, { conversation_id: conversation.id }),
      ).toEqual(item);
    expect(f.calls()).toBe(0);
    expect(Object.hasOwn(Object.prototype, "opaque")).toBe(false);
  } finally {
    await f.close();
  }
});

test("inert history rejects malformed fields and prerequisites atomically, including raw own keys", async () => {
  const f = await fixture();
  const required = [
    ["role", "content"],
    ["call_id", "name", "arguments", "status"],
    ["output", "status"],
    ["queries", "status"],
    ["status", "action"],
    ["result", "status"],
    ["call_id", "status", "pending_safety_checks"],
    ["call_id", "output", "status"],
    ["arguments", "call_id", "execution", "status"],
    ["tools", "call_id", "execution", "status"],
    ["role", "tools"],
    [],
    ["summary"],
    ["call_id", "code", "fingerprint"],
    ["call_id", "result", "status"],
    ["encrypted_content"],
    ["code", "container_id", "outputs", "status"],
    ["call_id", "action", "status"],
    ["output"],
    ["call_id", "action", "status", "environment"],
    ["call_id", "output", "status", "max_output_length"],
    ["call_id", "operation", "status"],
    ["call_id", "status"],
    ["server_label", "tools"],
    ["arguments", "name", "server_label"],
    ["approval_request_id", "approve"],
    ["arguments", "name", "server_label"],
    ["call_id", "name", "input"],
    ["call_id", "output"],
  ];
  try {
    expect(required).toHaveLength(historyFamilies.length);
    const conversation = await f.client.conversations.create();
    const append = (bad: unknown) =>
      fetch(`${f.url}/v1/conversations/${conversation.id}/items`, {
        method: "POST",
        body: JSON.stringify({ items: [{ role: "user", content: "rollback" }, bad] }),
      });
    for (const [index, example] of history.entries()) {
      for (const field of required[index] ?? []) {
        const missing: Record<string, unknown> = { ...example };
        delete missing[field];
        expect((await append(missing)).status, `${example.type} missing ${field}`).toBe(400);
        if (!(example.type === "tool_search_call" && field === "arguments"))
          expect(
            (await append({ ...example, [field]: { wrong: true } })).status,
            `${example.type} malformed ${field}`,
          ).toBe(400);
      }
      if ("status" in example)
        expect((await append({ ...example, status: "not_a_status" })).status, example.type).toBe(
          400,
        );
    }
    const malformed = [
      { role: "user", content: "inert", status: "invalid" },
      { role: "user", content: "inert", status: null },
      { ...history[13], call_id: "x".repeat(65) },
      { ...history[13], call_id: "" },
      { ...history[1], caller: { type: "program" } },
      { ...history[1], async: "true" },
      { ...history[1], namespace: null },
      { ...history[5], quality: "unknown" },
      { ...history[11], reasoning: { effort: "unknown" } },
      { ...history[6], action: { type: "click", x: "1", y: 2, button: "left" } },
      { ...history[6], actions: [{ type: "drag", path: [{ x: 1, y: "2" }] }] },
      { ...history[19], action: { commands: ["inert"], timeout_ms: null } },
      { ...history[20], output: [{ stdout: "inert", stderr: "", outcome: { type: "exit" } }] },
      { ...history[21], operation: { type: "update_file", path: "inert" } },
      { ...history[26], error: { type: "http_error", code: "wrong", message: "inert" } },
      { ...history[26], error: { type: "mcp_tool_execution_error" } },
      { ...history[23], tools: [{ name: "inert" }] },
      {
        ...history[17],
        action: { type: "exec", command: ["inert"], env: JSON.parse('{"__proto__":2}') },
      },
      { ...history[3], results: [{ attributes: JSON.parse('{"__proto__":{"not":"scalar"}}') }] },
      {
        ...history[3],
        results: [
          {
            attributes: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, true])),
          },
        ],
      },
      {
        ...history[9],
        tools: [{ type: "mcp", server_label: "inert", headers: JSON.parse('{"__proto__":2}') }],
      },
      {
        ...history[0],
        content: [
          {
            type: "output_text",
            text: "inert",
            annotations: [{ type: "url_citation", title: "inert", url: "http://127.0.0.1:1" }],
          },
        ],
      },
      {
        ...history[0],
        content: [
          {
            type: "output_text",
            text: "inert",
            annotations: [],
            logprobs: [{ token: "a", bytes: ["wrong"], logprob: -1, top_logprobs: [] }],
          },
        ],
      },
      {
        ...history[0],
        content: [{ type: "computer_screenshot", detail: "auto", image_url: null }],
      },
      {
        ...history[0],
        content: [
          { type: "input_text", text: "inert", prompt_cache_breakpoint: { mode: "wrong" } },
        ],
      },
    ];
    for (const bad of malformed) expect((await append(bad)).status, JSON.stringify(bad)).toBe(400);
    const invalidTools = [
      { type: "function", name: 2, parameters: null, strict: false },
      { type: "file_search", vector_store_ids: "wrong" },
      { type: "made_up" },
      {
        type: "computer_use_preview",
        display_width: "wrong",
        display_height: 2,
        environment: "browser",
      },
      { type: "web_search", external_web_access: "false" },
      { type: "mcp", server_label: 2 },
      { type: "code_interpreter", container: { type: "auto", memory_limit: "wrong" } },
      { type: "made_up" },
      { type: "image_generation", quality: "wrong" },
      { type: "made_up" },
      { type: "shell", environment: { type: "unknown" } },
      { type: "custom", name: "inert", format: { type: "wrong" } },
      {
        type: "namespace",
        name: "inert",
        description: "inert",
        tools: [{ type: "function", name: 2 }],
      },
      { type: "tool_search", execution: "wrong" },
      { type: "web_search_preview", search_context_size: "wrong" },
      { type: "made_up" },
    ];
    for (const tool of invalidTools)
      expect((await append({ ...history[9], tools: [tool] })).status, JSON.stringify(tool)).toBe(
        400,
      );
    for (const control of [
      { type: "compaction_trigger" },
      { type: "item_reference", id: "known" },
      { id: "known" },
      { id: "known", type: null },
    ]) {
      const response = await append(control);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({
        error: { code: "conversation_control_not_materializable" },
      });
    }
    const infinite = await fetch(`${f.url}/v1/conversations/${conversation.id}/items`, {
      method: "POST",
      body: '{"items":[{"type":"tool_search_call","id":"infinite","call_id":null,"execution":"client","status":"completed","arguments":{"__proto__":1e999}}]}',
    });
    expect(infinite.status).toBe(400);
    expect((await f.client.conversations.items.list(conversation.id)).data).toEqual([]);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("history preserves SDK alternatives, nullable payloads and non-default states without validator defaults", async () => {
  const f = await fixture();
  const roles = [
    "unknown",
    "user",
    "assistant",
    "system",
    "critic",
    "discriminator",
    "developer",
    "tool",
  ] as const;
  const actions = [
    { type: "click", button: "back", x: 1, y: 2 },
    { type: "double_click", x: 1, y: 2, keys: null },
    { type: "drag", path: [{ x: 1, y: 2 }], keys: ["SHIFT"] },
    { type: "keypress", keys: ["ENTER"] },
    { type: "move", x: 1, y: 2 },
    { type: "screenshot" },
    { type: "scroll", x: 1, y: 2, scroll_x: 3, scroll_y: 4 },
    { type: "type", text: "must-not-type" },
    { type: "wait" },
  ];
  const variants = [
    ...roles.map((role) => ({
      type: "message",
      role,
      content: [],
      status: "in_progress",
      phase: null,
    })),
    ...roles.map((role) => ({ type: "additional_tools", role, tools: [] })),
    ...actions.map((action) => ({ ...history[6], action, actions: undefined })),
    { ...history[4], action: { type: "open_page", url: null } },
    {
      ...history[4],
      action: { type: "find_in_page", url: "http://127.0.0.1:1", pattern: "inert" },
    },
    { ...history[21], operation: { type: "update_file", path: "inert", diff: "must-not-apply" } },
    { ...history[21], operation: { type: "delete_file", path: "must-not-delete" } },
    { ...history[20], output: [{ stdout: "", stderr: "", outcome: { type: "timeout" } }] },
    { ...history[19], environment: { type: "local" } },
    { ...history[19], environment: { type: "container_reference", container_id: "cntr_inert" } },
    { ...history[26], error: { type: "http_error", code: 403, message: "inert" } },
    { ...history[26], error: { type: "mcp_protocol_error", code: -1, message: "inert" } },
    { ...history[26], error: null, status: "calling" },
    { ...history[23], tools: [{ name: "inert", input_schema: null, annotations: "opaque" }] },
    { ...history[8], arguments: null },
    { ...history[8], arguments: [null, "opaque", false, 1] },
    { ...history[7], status: "in_progress" },
    { ...history[0], content: [{ type: "output_text", text: "inert", annotations: [] }] },
    { ...history[27], status: undefined, created_by: undefined },
    { ...history[28], status: undefined, created_by: undefined, output: "opaque" },
    {
      ...history[9],
      tools: [{ type: "web_search_2025_08_26" }, { type: "web_search_preview_2025_03_11" }],
    },
    { ...history[15], id: null },
    { ...history[13], id: "item/é %literal" },
    {
      ...history[8],
      ...JSON.parse(
        '{"__proto__":{"opaque":true},"constructor":"literal","extension":{"nested":[null,false]}}',
      ),
    },
  ].map(
    (item, i) =>
      JSON.parse(
        JSON.stringify({
          ...item,
          id: "id" in item && item.id === "item/é %literal" ? item.id : `variant_${i}`,
        }),
      ) as Record<string, unknown>,
  );
  try {
    const conversation = await f.client.conversations.create();
    for (const item of variants) {
      const response = await fetch(`${f.url}/v1/conversations/${conversation.id}/items`, {
        method: "POST",
        body: JSON.stringify({ items: [item] }),
      });
      expect(response.status, JSON.stringify(item)).toBe(200);
      expect(
        (await f.client.conversations.items.list(conversation.id, { limit: 1 })).data[0] as unknown,
      ).toEqual(item);
    }
    expect(
      (await f.client.conversations.items.retrieve("item/é %literal", {
        conversation_id: conversation.id,
      })) as unknown,
    ).toEqual(variants.at(-2));
    const shorthand = await f.client.conversations.items.create(conversation.id, {
      items: [{ role: "assistant", content: "inert", phase: "commentary" }],
    });
    expect(shorthand.data[0]).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [{ type: "output_text", text: "inert", annotations: [] }],
    });
    const contentDefaults = await f.client.post<{ data: unknown[] }>(
      `/conversations/${conversation.id}/items`,
      {
        body: {
          items: [
            { role: "assistant", content: [{ type: "output_text", text: "inert" }] },
            {
              role: "user",
              content: [{ type: "input_image", image_url: "http://127.0.0.1:1/inert" }],
            },
          ],
        },
      },
    );
    expect(contentDefaults.data).toMatchObject([
      { content: [{ type: "output_text", text: "inert", annotations: [] }] },
      { content: [{ type: "input_image", detail: "auto", image_url: "http://127.0.0.1:1/inert" }] },
    ]);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

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
      status: "completed",
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
