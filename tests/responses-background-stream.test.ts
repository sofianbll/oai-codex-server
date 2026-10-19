import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { parseConfig } from "../src/server/config";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ResponsesStoreOptions } from "../src/server/responses-store";
import { startServer } from "../src/server/runtime";

type Event = Record<string, unknown> & {
  type: string;
  sequence_number: number;
  response?: { id: string };
};

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected fixture result to exist");
  return value;
}

function responseId(event: Event | undefined): string {
  return required(required(event).response).id;
}

test("native cancelled background terminals retain completed items in SSE, polling and replay", async () => {
  const item = {
    id: "msg_before_cancel",
    type: "message",
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text: "RETAINED BEFORE CANCEL", annotations: [] }],
    fixture_extension: { retained: true },
  };
  const terminalItem = {
    ...item,
    id: "msg_terminal",
    content: [{ type: "output_text", text: "ALREADY PRESENT", annotations: [] }],
  };
  for (const { output, expected } of [
    { output: undefined, expected: [item] },
    { output: [], expected: [item] },
    { output: [terminalItem], expected: [terminalItem] },
  ]) {
    const f = await fixture((socket) => {
      socket.send(
        JSON.stringify({
          type: "response.output_item.done",
          sequence_number: 17,
          output_index: 0,
          item,
        }),
      );
      socket.send(
        JSON.stringify({
          type: "response.cancelled",
          sequence_number: 21,
          fixture_extension: "terminal",
          response: {
            id: "native_cancelled",
            object: "response",
            status: "cancelled",
            ...(output === undefined ? {} : { output }),
          },
        }),
      );
    });
    try {
      const events = await collect(
        await f.client.responses.create({
          input: "cancel after item",
          background: true,
          stream: true,
          store: true,
        }),
      );
      const id = responseId(events[0]);
      expect(events.at(-1)).toMatchObject({
        type: "response.cancelled",
        sequence_number: 2,
        fixture_extension: "terminal",
        response: { id, status: "cancelled", output: expected },
      });
      expect(await f.client.responses.retrieve(id)).toMatchObject({
        id,
        status: "cancelled",
        output: expected,
      });
      expect(
        await collect(await f.client.responses.retrieve(id, { stream: true, starting_after: 1 })),
      ).toEqual(events.slice(2));
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(f.emissions()).toBe(1);
    } finally {
      await f.close();
    }
  }
});

async function fixture(
  handler: (socket: Bun.ServerWebSocket<undefined>) => void,
  storage: ResponsesStoreOptions = {},
  maxBodyBytes = 16384,
  deliveryGate?: Promise<void>,
) {
  let emissions = 0;
  let account = "a";
  const upstream = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      message(socket) {
        emissions++;
        handler(socket);
      },
    },
  });
  expect(upstream.url.hostname).toBe("127.0.0.1");
  const options = {
    baseUrl: `${upstream.url.origin}/backend-api/codex`,
    defaultModel: "fixture",
    clientVersion: "fixture",
    translationMode: "minimal" as const,
    timeoutMs: 2000,
    maxBodyBytes,
  };
  const credentials = async () => ({ accountId: account, accessToken: "fixture" });
  let gateway = createResponsesGateway(options, credentials, storage);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = await gateway.forward(request);
      if (
        !deliveryGate ||
        request.method !== "POST" ||
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      )
        return response;
      const reader = response.body.getReader();
      let first = true;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (!first) await deliveryGate;
              first = false;
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          },
          { highWaterMark: 0 },
        ),
        response,
      );
    },
  });
  const client = new OpenAI({
    baseURL: `${server.url.origin}/v1`,
    apiKey: "fixture",
    maxRetries: 0,
  });
  return {
    client,
    options,
    emissions: () => emissions,
    account(value: string) {
      account = value;
    },
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

async function collect(stream: AsyncIterable<unknown>) {
  return (await Array.fromAsync(stream)) as Event[];
}

async function terminal(client: OpenAI, id: string) {
  for (let i = 0; i < 300; i++) {
    const value = await client.responses.retrieve(id);
    if (!["queued", "in_progress"].includes(String(value.status))) return value;
    await Bun.sleep(5);
  }
  throw new Error("Background job did not terminate");
}

test("SDK background stream resumes the exact exposed events after N without regeneration", async () => {
  const release = Promise.withResolvers<void>();
  let emissions = 0;
  const upstream = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      async message(socket) {
        emissions++;
        socket.send(
          JSON.stringify({
            type: "response.created",
            sequence_number: 91,
            response: { id: "native_conflict", status: "in_progress", output: [] },
            extension: "kept",
          }),
        );
        await release.promise;
        socket.send(
          JSON.stringify({
            type: "response.output_text.delta",
            sequence_number: 2,
            response_id: "another_native",
            delta: "HELLO",
            extension: { kept: true },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "response.completed",
            sequence_number: 2,
            response: { id: "native_terminal", status: "completed", output: [] },
          }),
        );
      },
    },
  });
  expect(upstream.url.hostname).toBe("127.0.0.1");
  const gateway = createResponsesGateway(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      defaultModel: "fixture",
      clientVersion: "fixture",
      translationMode: "minimal",
      timeoutMs: 2000,
      maxBodyBytes: 16384,
    },
    async () => ({ accountId: "a", accessToken: "fixture" }),
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
    const stream = await client.responses.create({
      input: "hello",
      background: true,
      stream: true,
      store: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = required((await iterator.next()).value);
    expect(first).toMatchObject({
      type: "response.created",
      sequence_number: 0,
      response: { background: true, status: "queued", store: true },
    });
    const id = (first as { response: { id: string } }).response.id;
    expect(id.startsWith("resp_bg_")).toBe(true);
    release.resolve();
    const events = [first];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3]);
    expect(events[1]).toMatchObject({ extension: "kept", response: { id } });
    expect(events[2]).toMatchObject({ response_id: id, delta: "HELLO", extension: { kept: true } });
    expect(await client.responses.retrieve(id)).toMatchObject({ id, status: "completed" });
    const resumed = await client.responses.retrieve(id, { stream: true, starting_after: 1 });
    expect(await Array.fromAsync(resumed)).toEqual(events.slice(2));
    expect(emissions).toBe(1);
  } finally {
    release.resolve();
    gateway.close();
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("concurrent replay subscribers see snapshot plus live events once; disconnect never cancels the job", async () => {
  const started = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
  const f = await fixture((socket) => started.resolve(socket));
  try {
    const original = await f.client.responses.create({
      input: "detach",
      background: true,
      stream: true,
    });
    const iterator = original[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as unknown as Event;
    const id = responseId(first);
    original.controller.abort();
    const socket = await started.promise;
    expect(await f.client.responses.retrieve(id)).toMatchObject({ status: "in_progress" });
    const readers = await Promise.all(
      Array.from({ length: 8 }, () => f.client.responses.retrieve(id, { stream: true })),
    );
    const results = readers.map(collect);
    for (let i = 0; i < 20; i++) {
      socket.send(
        JSON.stringify({
          type: "response.output_text.delta",
          sequence_number: i + 100,
          delta: `${i}`,
        }),
      );
      await Bun.sleep(1);
    }
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "native", status: "completed", output: [] },
      }),
    );
    const events = await Promise.all(results);
    const expected = required(events[0]);
    expect(expected.map((event) => event.sequence_number)).toEqual(
      Array.from({ length: 22 }, (_, i) => i),
    );
    for (const result of events) expect(result).toEqual(expected);
    expect(
      await collect(await f.client.responses.retrieve(id, { stream: true, starting_after: 10 })),
    ).toEqual(expected.slice(11));
    expect(await terminal(f.client, id)).toMatchObject({ id, status: "completed" });
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
  }
});

test("durable replay survives restart, expires independently of thirty-day JSON and isolates accounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-stream-ttl-"));
  let time = 1_800_000_000_000;
  const f = await fixture(
    (socket) =>
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: { id: "native", status: "completed", output: [] },
        }),
      ),
    { path: join(directory, "store.sqlite"), now: () => time },
  );
  try {
    const events = await collect(
      await f.client.responses.create({
        input: "save",
        background: true,
        store: true,
        stream: true,
      }),
    );
    const id = responseId(events[0]);
    f.restart();
    expect(
      await collect(await f.client.responses.retrieve(id, { stream: true, starting_after: 0 })),
    ).toEqual(events.slice(1));
    f.account("b");
    await expect(
      f.client.responses.retrieve(id, { stream: true }).asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.client.responses.cancel(id).asResponse()).rejects.toMatchObject({ status: 404 });
    f.account("a");
    time += 10 * 60_000 - 1;
    expect(await collect(await f.client.responses.retrieve(id, { stream: true }))).toEqual(events);
    time++;
    await expect(
      f.client.responses.retrieve(id, { stream: true }).asResponse(),
    ).rejects.toMatchObject({ status: 410, code: "background_journal_unavailable" });
    expect(await f.client.responses.retrieve(id)).toMatchObject({
      id,
      status: "completed",
      store: true,
    });
    time += 30 * 24 * 60 * 60_000 - 10 * 60_000;
    await expect(f.client.responses.retrieve(id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart retains only already exposed events and reports interruption, never reconstructing a terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-stream-restart-"));
  const started = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
  const f = await fixture((socket) => started.resolve(socket), {
    path: join(directory, "store.sqlite"),
  });
  try {
    const stream = await f.client.responses.create({
      input: "interrupt",
      background: true,
      stream: true,
      store: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as unknown as Event;
    const socket = await started.promise;
    socket.send(
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "before crash",
        sequence_number: 45,
      }),
    );
    const second = (await iterator.next()).value;
    stream.controller.abort();
    f.restart();
    expect(await f.client.responses.retrieve(responseId(first))).toMatchObject({
      status: "failed",
      error: { code: "background_interrupted" },
    });
    const resumed = await f.client.responses.retrieve(responseId(first), { stream: true });
    const replay = resumed[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual(first);
    expect((await replay.next()).value).toEqual(second);
    await expect(replay.next()).rejects.toMatchObject({ code: "background_interrupted" });
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal quota stops with an explicit durable failure, never a false stored completion", async () => {
  const f = await fixture(
    (socket) => {
      for (let i = 0; i < 100; i++)
        socket.send(
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "x".repeat(100),
            sequence_number: i,
          }),
        );
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: { id: "native", status: "completed", output: [] },
        }),
      );
    },
    { maxRecordBytes: 4096 },
  );
  try {
    const events = await collect(
      await f.client.responses.create({
        input: "bounded",
        background: true,
        stream: true,
        store: true,
      }),
    );
    const id = responseId(events[0]);
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: { status: "failed", error: { code: "background_journal_full" } },
    });
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    expect(await terminal(f.client, id)).toMatchObject({
      status: "failed",
      error: { code: "background_journal_full" },
    });
    expect(await collect(await f.client.responses.retrieve(id, { stream: true }))).toEqual(events);
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
  }
});

test("global capacity is reserved for both job and journal before emission; invalid cursors never regenerate", async () => {
  const saturated = await fixture(() => {}, { maxBytes: 4096, maxRecordBytes: 4096 });
  try {
    await expect(
      saturated.client.responses
        .create({ input: "full", background: true, stream: true })
        .asResponse(),
    ).rejects.toMatchObject({ status: 507, code: "storage_capacity_exceeded" });
    expect(saturated.emissions()).toBe(0);
  } finally {
    await saturated.close();
  }
  const f = await fixture((socket) =>
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "native", status: "completed", output: [] },
      }),
    ),
  );
  try {
    const events = await collect(
      await f.client.responses.create({ input: "cursor", background: true, stream: true }),
    );
    const id = responseId(events[0]);
    for (const cursor of [-1, 0.5, 99999])
      await expect(
        f.client.responses.retrieve(id, { stream: true, starting_after: cursor }).asResponse(),
      ).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    expect(
      await collect(
        await f.client.responses.retrieve(id, { stream: true, starting_after: events.length - 1 }),
      ),
    ).toEqual([]);
    expect(await f.client.responses.cancel(id)).toMatchObject({ status: "completed" });
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
  }
});

test("integrated runtime publishes the delivered SSE contract and resumes a disconnected SDK client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-sse-runtime-"));
  await mkdir(join(directory, "synthetic-auth"));
  await writeFile(
    join(directory, "synthetic-auth/auth.json"),
    JSON.stringify({ tokens: { access_token: "fixture", account_id: "a" } }),
  );
  const token = "fixture-runtime-token-0123456789abcdef";
  await writeFile(join(directory, "token"), token);
  const started = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
  const f = await fixture((socket) => started.resolve(socket));
  const config = parseConfig({
    server: { port: 0 },
    auth: { codexHome: "synthetic-auth", tokenFile: "token" },
    storage: { path: "private/store.sqlite" },
  });
  Object.assign(config.proxy, { baseUrl: f.options.baseUrl });
  let runtime = await startServer(config, join(directory, "server.json"));
  const client = () => new OpenAI({ baseURL: `${runtime.url}/v1`, apiKey: token, maxRetries: 0 });
  try {
    const spec = (await fetch(`${runtime.url}/openapi.json`).then((response) =>
      response.json(),
    )) as { paths: Record<string, Record<string, { description: string }>> };
    expect(spec.paths["/v1/responses"]?.["post"]?.description).toContain(
      "Local background SSE example",
    );
    const stream = await client().responses.create({
      input: "runtime",
      background: true,
      stream: true,
      store: true,
    });
    const first = (await stream[Symbol.asyncIterator]().next()).value as unknown as Event;
    stream.controller.abort();
    const socket = await started.promise;
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "native", status: "completed", output: [] },
      }),
    );
    expect(await terminal(client(), responseId(first))).toMatchObject({
      id: responseId(first),
      status: "completed",
    });
    await runtime.stop();
    runtime = await startServer(config, join(directory, "server.json"));
    const events = await collect(
      await client().responses.retrieve(responseId(first), { stream: true, starting_after: 0 }),
    );
    expect(events).toMatchObject([
      {
        type: "response.completed",
        sequence_number: 1,
        response: { id: responseId(first), status: "completed" },
      },
    ]);
    expect(f.emissions()).toBe(1);
  } finally {
    await runtime.stop();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a terminal journal/result transaction failure never exposes completed and replay preserves the failure", async () => {
  const f = await fixture(
    (socket) =>
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "native",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "x".repeat(1700) }],
              },
            ],
          },
        }),
      ),
    { maxRecordBytes: 4096 },
  );
  try {
    const events = await collect(
      await f.client.responses.create({
        input: "i".repeat(2000),
        background: true,
        stream: true,
        store: true,
      }),
    );
    const id = responseId(events[0]);
    expect(events.map((event) => event.type)).toEqual(["response.created", "response.failed"]);
    expect(await terminal(f.client, id)).toMatchObject({
      status: "failed",
      error: { code: "stored_response_too_large" },
    });
    expect(await collect(await f.client.responses.retrieve(id, { stream: true }))).toEqual(events);
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
  }
});

test("a slow HTTP subscriber is disconnected explicitly while the background job completes and remains replayable", async () => {
  const started = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
  const delivery = Promise.withResolvers<void>();
  const f = await fixture((socket) => started.resolve(socket), {}, 4096, delivery.promise);
  try {
    const response = await f.client.responses
      .create({ input: "slow", background: true, stream: true, store: true })
      .asResponse();
    const reader = required(response.body).getReader();
    const first = required((await reader.read()).value);
    const id = responseId(
      JSON.parse(new TextDecoder().decode(first).split("data: ")[1] ?? "null") as Event,
    );
    const socket = await started.promise;
    // Gate the public HTTP response reader: Bun fetch/TCP may otherwise eagerly buffer the journal.
    for (let i = 0; i < 35; i++) {
      socket.send(
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "x".repeat(1000),
          sequence_number: i,
        }),
      );
      await Bun.sleep(2);
    }
    socket.send(
      JSON.stringify({
        type: "response.completed",
        response: { id: "native", status: "completed", output: [] },
      }),
    );
    expect(await terminal(f.client, id)).toMatchObject({ status: "completed" });
    delivery.resolve();
    let received = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += new TextDecoder().decode(next.value);
    }
    expect(received.includes('"code":"slow_consumer"')).toBe(true);
    const replay = await collect(
      await f.client.responses.retrieve(id, { stream: true, starting_after: 34 }),
    );
    expect(replay.map((event) => event.sequence_number)).toEqual([35, 36]);
    expect(replay.at(-1)).toMatchObject({ type: "response.completed" });
    expect(f.emissions()).toBe(1);
  } finally {
    delivery.resolve();
    await f.close();
  }
}, 15000);

test("subscriber saturation refuses new streaming creation before creating or emitting an orphan job", async () => {
  const started = Promise.withResolvers<void>();
  const f = await fixture(() => started.resolve());
  const streams: { controller: AbortController }[] = [];
  try {
    const original = await f.client.responses.create({
      input: "capacity",
      background: true,
      stream: true,
    });
    streams.push(original);
    const first = required(
      (await original[Symbol.asyncIterator]().next()).value,
    ) as unknown as Event;
    const id = responseId(first);
    await started.promise;
    for (let i = 0; i < 63; i++)
      streams.push(await f.client.responses.retrieve(id, { stream: true }));
    await expect(
      f.client.responses
        .create({ input: "must not run", background: true, stream: true })
        .asResponse(),
    ).rejects.toMatchObject({ status: 429, code: "background_subscriber_capacity" });
    await Bun.sleep(20);
    expect(f.emissions()).toBe(1);
    const cancelled = await Promise.all(
      Array.from({ length: 8 }, () => f.client.responses.cancel(id)),
    );
    expect(cancelled.every((value) => value.status === "cancelled")).toBe(true);
  } finally {
    for (const stream of streams) stream.controller.abort();
    await f.close();
  }
});

test("native error events retain unknown fields in the journal and in the failed JSON without retry", async () => {
  const native = {
    type: "error",
    sequence_number: 90,
    error: { code: "fixture_denied", message: "Local refusal", detail: { retained: true } },
    extension: "retained",
  };
  const f = await fixture((socket) => socket.send(JSON.stringify(native)));
  try {
    const response = await f.client.responses
      .create({ input: "error", background: true, stream: true, store: true })
      .asResponse();
    const frames = (await response.text()).split(/\n\n/).flatMap((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      return data ? [JSON.parse(data.slice(6)) as Event] : [];
    });
    expect(frames.map((event) => event.type)).toEqual([
      "response.created",
      "error",
      "response.failed",
    ]);
    expect(frames[1]).toEqual({ ...native, sequence_number: 1 });
    const id = responseId(frames[0]);
    expect(await f.client.responses.retrieve(id)).toMatchObject({
      status: "failed",
      error: native.error,
    });
    const replay = await f.client.responses
      .retrieve(id, { stream: true, starting_after: 0 })
      .asResponse();
    expect(await replay.text()).toContain(JSON.stringify({ ...native, sequence_number: 1 }));
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
  }
});

test("failed admission releases subscriber and shared quota reservations; invalid replays never consume slots", async () => {
  const full = await fixture(() => {}, { maxBytes: 4096, maxRecordBytes: 4096 });
  try {
    for (let i = 0; i < 70; i++) {
      await expect(
        full.client.responses
          .create({ input: "no journal capacity", background: true, stream: true })
          .asResponse(),
      ).rejects.toMatchObject({ status: 507, code: "storage_capacity_exceeded" });
      await expect(
        full.client.responses.retrieve("resp_bg_missing", { stream: true }).asResponse(),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(full.emissions()).toBe(0);
    const job = await full.client.responses.create({
      input: "quota is released",
      background: true,
    });
    expect(job.status).toBe("queued");
    await full.client.responses.cancel(job.id);
  } finally {
    await full.close();
  }
});

test("simultaneous creation and resume compete for one reserved subscriber slot without orphan emissions", async () => {
  const started = Promise.withResolvers<void>();
  const f = await fixture(() => started.resolve());
  const streams: { controller: AbortController }[] = [];
  try {
    const original = await f.client.responses.create({
      input: "concurrent slots",
      background: true,
      stream: true,
    });
    streams.push(original);
    const first = required(
      (await original[Symbol.asyncIterator]().next()).value,
    ) as unknown as Event;
    const id = responseId(first);
    await started.promise;
    for (let i = 0; i < 62; i++)
      streams.push(await f.client.responses.retrieve(id, { stream: true }));
    const results = await Promise.allSettled([
      f.client.responses.create({ input: "last slot", background: true, stream: true }),
      f.client.responses.retrieve(id, { stream: true }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "fulfilled") streams.push(result.value);
      else
        expect(result.reason).toMatchObject({
          status: 429,
          code: "background_subscriber_capacity",
        });
    }
    await Bun.sleep(20);
    expect(f.emissions()).toBe(results[0]?.status === "fulfilled" ? 2 : 1);
    original.controller.abort();
    for (const stream of streams) stream.controller.abort();
    await Bun.sleep(20);
    const resumed = await f.client.responses.retrieve(id, { stream: true });
    streams.push(resumed);
    expect((await resumed[Symbol.asyncIterator]().next()).value).toEqual(first);
  } finally {
    for (const stream of streams) stream.controller.abort();
    await f.close();
  }
});

test("store:false streaming jobs and journals both expire ten minutes after terminal without renewing on reads", async () => {
  let time = 1_800_000_000_000;
  const f = await fixture(
    (socket) =>
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: { id: "native", status: "completed", output: [] },
        }),
      ),
    { now: () => time },
  );
  try {
    const events = await collect(
      await f.client.responses.create({
        input: "temporary",
        background: true,
        stream: true,
        store: false,
      }),
    );
    const id = responseId(events[0]);
    time += 10 * 60_000 - 1;
    expect(await f.client.responses.retrieve(id)).toMatchObject({
      id,
      status: "completed",
      store: false,
    });
    expect(await collect(await f.client.responses.retrieve(id, { stream: true }))).toEqual(events);
    time++;
    await expect(f.client.responses.retrieve(id).asResponse()).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      f.client.responses.retrieve(id, { stream: true }).asResponse(),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
  }
});

test("process crash preserves the exposed prefix, fails the job and never re-emits upstream on recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-stream-crash-"));
  const path = join(directory, "store.sqlite");
  const upstream = await fixture((socket) =>
    socket.send(
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "before crash",
        sequence_number: 75,
      }),
    ),
  );
  let recovered: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const gatewayModule = new URL("../src/server/responses-gateway.ts", import.meta.url).pathname;
    const guard = new URL("./network-guard.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        guard,
        "-e",
        `
      import { writeSync } from "node:fs";
      import OpenAI from "openai";
      import { createResponsesGateway } from ${JSON.stringify(gatewayModule)};
      const options = ${JSON.stringify(upstream.options)};
      if (new URL(options.baseUrl).hostname !== "127.0.0.1") throw new Error("Non-local upstream");
      const gateway = createResponsesGateway(options, async () => ({ accountId: "a", accessToken: "fixture" }), { path: ${JSON.stringify(path)} });
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => gateway.forward(request) });
      const client = new OpenAI({ baseURL: server.url.origin + "/v1", apiKey: "fixture", maxRetries: 0 });
      const stream = await client.responses.create({ input: "crash", background: true, stream: true, store: true });
      const iterator = stream[Symbol.asyncIterator]();
      const first = (await iterator.next()).value;
      const second = (await iterator.next()).value;
      writeSync(1, JSON.stringify([first, second]));
      process.kill(process.pid, "SIGKILL");
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const prefix = JSON.parse(await new Response(child.stdout).text()) as Event[];
    await child.exited;
    expect(prefix.map((event) => event.sequence_number)).toEqual([0, 1]);
    const id = responseId(prefix[0]);
    recovered = await fixture(() => {}, { path });
    expect(await recovered.client.responses.retrieve(id)).toMatchObject({
      id,
      status: "failed",
      error: { code: "background_interrupted" },
    });
    const replay = await recovered.client.responses.retrieve(id, { stream: true });
    const iterator = replay[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(prefix[0]);
    expect((await iterator.next()).value).toEqual(prefix[1]);
    await expect(iterator.next()).rejects.toMatchObject({ code: "background_interrupted" });
    expect(upstream.emissions()).toBe(1);
    expect(recovered.emissions()).toBe(0);
  } finally {
    await recovered?.close();
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal exhaustion retains enough room for a failed terminal even with large preserved creation metadata", async () => {
  const f = await fixture(
    (socket) => {
      for (let i = 0; i < 50; i++)
        socket.send(
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "x".repeat(200),
            sequence_number: i,
          }),
        );
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: { id: "native", status: "completed", output: [] },
        }),
      );
    },
    { maxRecordBytes: 8192 },
  );
  try {
    const events = await collect(
      await f.client.responses.create({
        input: "bounded failure",
        model: "m".repeat(2500),
        background: true,
        stream: true,
        store: true,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: { status: "failed", error: { code: "background_journal_full" } },
    });
    expect(await terminal(f.client, responseId(events[0]))).toMatchObject({
      status: "failed",
      error: { code: "background_journal_full" },
    });
    expect(f.emissions()).toBe(1);
  } finally {
    await f.close();
  }
});
