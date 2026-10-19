import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { parseConfig } from "../src/server/config";
import { createResponsesGateway } from "../src/server/responses-gateway";
import { startServer } from "../src/server/runtime";

test("SDK restores the original branch after restart without repeating instructions or native IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "responses-replay-"));
  const received: Record<string, unknown>[] = [];
  const output = [
    {
      id: "rs_1",
      type: "reasoning",
      status: "completed",
      summary: [],
      encrypted_content: "fixture-opaque",
    },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      phase: "commentary",
      status: "completed",
      created_by: null,
      content: [{ type: "output_text", text: "Remembered", annotations: [] }],
    },
    {
      id: "fc_1",
      type: "function_call",
      status: "completed",
      call_id: "call_1",
      name: "lookup",
      arguments: '{"key":1}',
    },
  ];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        received.push(JSON.parse(String(message)));
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_${received.length}`,
              object: "response",
              status: "completed",
              output: received.length === 1 ? output : [],
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
  const storage = { path: join(directory, "store.sqlite") };
  const credentials = async () => ({ accessToken: "fixture", accountId: "a" });
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
    await client.responses.create({
      model: "fixture",
      input: "original",
      instructions: "ONE TURN ONLY",
      store: true,
    });
    gateway.close();
    gateway = createResponsesGateway(options, credentials, storage);
    const toolResult = {
      type: "function_call_output" as const,
      call_id: "call_1",
      output: '{"value":7}',
    };
    const stream = await client.responses.create({
      model: "fixture",
      previous_response_id: "resp_1",
      input: [toolResult],
      store: true,
      stream: true,
    });
    for await (const event of stream)
      if (event.type === "response.completed") expect(event.response.id).toBe("resp_2");
    expect(received[1]).not.toHaveProperty("previous_response_id");
    expect(received[1]?.["instructions"]).toBe("");
    expect(received[1]?.["input"]).toEqual(
      [
        { type: "message", role: "user", content: [{ type: "input_text", text: "original" }] },
        output[0],
        { ...output[1], created_by: undefined },
        output[2],
        toolResult,
      ].map((item) => JSON.parse(JSON.stringify(item))),
    );
    expect(JSON.parse(JSON.stringify((await client.responses.retrieve("resp_1")).output))).toEqual(
      output,
    );
    gateway.close();
    gateway = createResponsesGateway(options, credentials, storage);
    await client.responses.create({
      model: "fixture",
      previous_response_id: "resp_2",
      input: "child",
    });
    const replayedInput = received[1]?.["input"] as unknown[];
    expect(received[2]?.["input"]).toEqual([
      ...replayedInput,
      { role: "user", content: [{ type: "input_text", text: "child" }] },
    ]);
    await client.responses.create({
      model: "fixture",
      previous_response_id: "resp_1",
      input: "sibling",
    });
    expect(received[3]?.["input"]).toEqual([
      ...replayedInput.slice(0, 4),
      { role: "user", content: [{ type: "input_text", text: "sibling" }] },
    ]);
  } finally {
    gateway.close();
    await server.stop(true);
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime restores a lost socket and rejects missing, foreign, unfinished and unprojectable context before another generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "replay-runtime-"));
  await mkdir(join(directory, "synthetic-auth"));
  const account = (id: string) =>
    writeFile(
      join(directory, "synthetic-auth/auth.json"),
      JSON.stringify({ tokens: { access_token: `fixture-${id}`, account_id: id } }),
    );
  await account("a");
  await writeFile(join(directory, "token"), "fixture-proxy-token-0123456789abcdef");
  const received: Record<string, unknown>[] = [];
  const closed = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, raw) {
        const payload = JSON.parse(String(raw)) as Record<string, unknown>;
        received.push(payload);
        const mode = payload["metadata"] as { mode?: string } | undefined;
        const status = mode?.mode === "incomplete" ? "incomplete" : "completed";
        const outputs: Record<string, unknown> = {
          opaque: [{ type: "reasoning", id: "rs_missing", summary: [] }],
          unknown: [{ type: "future_required_context", id: "future" }],
          omitted: [
            {
              type: "custom_tool_call_output",
              id: "tool_failed",
              status: "failed",
              call_id: "call_1",
              output: "failed",
            },
          ],
          unfinished: [{ type: "message", role: "assistant", status: "in_progress", content: [] }],
        };
        socket.send(
          JSON.stringify({
            type: `response.${status}`,
            response: {
              id: `resp_rt_${received.length}`,
              object: "response",
              status,
              output: outputs[mode?.mode ?? ""] ?? [],
            },
          }),
        );
        if (mode?.mode === "disconnect") socket.close(1000, "fixture idle expiry");
      },
      close() {
        closed.resolve();
      },
    },
  });
  const config = parseConfig({
    server: { port: 0 },
    auth: { codexHome: "synthetic-auth", tokenFile: "token" },
    storage: { path: "private/store.sqlite" },
  });
  Object.assign(config.proxy, { baseUrl: `${upstream.url.origin}/backend-api/codex` });
  let runtime = await startServer(config, join(directory, "config.json"));
  const client = () =>
    new OpenAI({
      baseURL: `${runtime.url}/v1`,
      apiKey: "fixture-proxy-token-0123456789abcdef",
      maxRetries: 0,
    });
  try {
    const first = await client().responses.create({
      model: "fixture",
      input: "root",
      store: true,
      metadata: { mode: "disconnect" },
    });
    await closed.promise;
    await Bun.sleep(10);
    const child = await client().responses.create({
      model: "fixture",
      input: "native child",
      previous_response_id: first.id,
      store: true,
    });
    expect(received[1]).not.toHaveProperty("previous_response_id");
    const nativeChild = await client().responses.create({
      model: "fixture",
      input: "child on live socket",
      previous_response_id: child.id,
      store: true,
    });
    expect(received[2]?.["previous_response_id"]).toBe(child.id);
    await runtime.stop();
    runtime = await startServer(config, join(directory, "config.json"));
    expect((await client().responses.retrieve(first.id)).id).toBe(first.id);
    await client().responses.create({
      model: "fixture",
      input: "after restart",
      previous_response_id: nativeChild.id,
    });
    expect(received[3]?.["input"]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "root" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "native child" }] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "child on live socket" }],
      },
      { role: "user", content: [{ type: "input_text", text: "after restart" }] },
    ]);
    await account("b");
    const beforeForeign = received.length;
    await expect(
      client()
        .responses.create({ model: "fixture", input: "foreign", previous_response_id: first.id })
        .asResponse(),
    ).rejects.toMatchObject({ status: 404, code: "previous_response_not_found" });
    expect(received).toHaveLength(beforeForeign);
    await account("a");
    const invalid: { id: string; code: string }[] = [];
    for (const mode of ["opaque", "unknown", "omitted", "unfinished", "incomplete"]) {
      try {
        const response = await client().responses.create({
          model: "fixture",
          input: "original",
          store: true,
          metadata: { mode },
        });
        invalid.push({ id: response.id, code: "response_context_not_replayable" });
      } catch (error) {
        expect(error).toMatchObject({ status: 502 });
        invalid.push({ id: `resp_rt_${received.length}`, code: "response_context_incomplete" });
      }
    }
    const ephemeral = await client().responses.create({ model: "fixture", input: "not stored" });
    const partial = await client().responses.create({
      model: "fixture",
      input: "stored child of missing parent",
      previous_response_id: ephemeral.id,
      store: true,
    });
    invalid.push(
      { id: ephemeral.id, code: "previous_response_not_found" },
      { id: partial.id, code: "response_context_incomplete" },
    );
    await runtime.stop();
    runtime = await startServer(config, join(directory, "config.json"));
    const beforeInvalid = received.length;
    for (const { id, code } of invalid) {
      await expect(
        client()
          .responses.create({
            model: "fixture",
            input: "must not execute",
            previous_response_id: id,
            store: true,
          })
          .asResponse(),
      ).rejects.toMatchObject({ status: code === "previous_response_not_found" ? 404 : 409, code });
    }
    expect(received).toHaveLength(beforeInvalid);
  } finally {
    await runtime.stop();
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
