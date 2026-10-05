import { expect, test } from "bun:test";
import { createResponsesLifecycle } from "../../src/server/responses-store";

const url = "http://localhost/v1/responses";

function jsonRequest(body: Readonly<Record<string, unknown>>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("stores a completed JSON response locally and supports retrieve, input-items pagination, and delete", async () => {
  let upstreamBody: unknown;
  const lifecycle = createResponsesLifecycle(async (request) => {
    upstreamBody = await request.json();
    return Response.json({
      id: "resp_local_1",
      object: "response",
      status: "completed",
      output: [],
    });
  });

  const created = await lifecycle(
    jsonRequest({
      model: "fixture",
      store: true,
      input: [
        { id: "item_one", type: "message", role: "user", content: "first" },
        { id: "item_two", type: "message", role: "user", content: "second" },
      ],
    }),
  );
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ id: "resp_local_1", store: true });
  expect(upstreamBody).toMatchObject({ store: false, model: "fixture" });

  const retrieved = await lifecycle(new Request(`${url}/resp_local_1`));
  expect(await retrieved.json()).toMatchObject({ id: "resp_local_1", store: true });

  const firstPage = await lifecycle(
    new Request(`${url}/resp_local_1/input_items?order=asc&limit=1`),
  );
  const firstPageBody = await firstPage.json();
  expect(firstPageBody).toMatchObject({
    object: "list",
    has_more: true,
    first_id: "item_one",
    last_id: "item_one",
    data: [{ id: "item_one" }],
  });
  const secondPage = await lifecycle(
    new Request(`${url}/resp_local_1/input_items?order=asc&after=item_one&limit=1`),
  );
  expect(await secondPage.json()).toMatchObject({
    has_more: false,
    data: [{ id: "item_two" }],
  });

  const deleted = await lifecycle(new Request(`${url}/resp_local_1`, { method: "DELETE" }));
  expect(await deleted.json()).toEqual({
    id: "resp_local_1",
    object: "response.deleted",
    deleted: true,
  });
  expect((await lifecycle(new Request(`${url}/resp_local_1`))).status).toBe(404);
  expect((await lifecycle(new Request(`${url}/missing`, { method: "DELETE" }))).status).toBe(404);
});

test("keeps stored streaming responses live while capturing the terminal response", async () => {
  const release = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  const lifecycle = createResponsesLifecycle(async (request) => {
    expect(await request.json()).toMatchObject({ store: false, stream: true });
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode('event: response.created\ndata: {"type":"response.created"}\n\n'),
          );
          await release.promise;
          controller.enqueue(
            encoder.encode(
              `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: { id: "resp_stream_1", object: "response", status: "completed" },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });

  const response = await lifecycle(jsonRequest({ store: true, stream: true, input: "hello" }));
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const first = await reader?.read();
  expect(new TextDecoder().decode(first?.value)).toContain("response.created");
  release.resolve();
  const rest = await new Response(
    reader
      ? new ReadableStream({
          async start(controller) {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if (next.value) controller.enqueue(next.value);
            }
            controller.close();
          },
        })
      : null,
  ).text();
  expect(rest).toContain('"store":true');
  const stored = await lifecycle(new Request(`${url}/resp_stream_1`));
  expect(await stored.json()).toMatchObject({ id: "resp_stream_1", store: true });
  const items = await lifecycle(new Request(`${url}/resp_stream_1/input_items`));
  const itemBody = await items.json();
  expect(itemBody).toMatchObject({ data: [{ role: "user", id: expect.any(String) }] });
});

test("does not store when store is false and rejects unsupported background jobs", async () => {
  let calls = 0;
  const lifecycle = createResponsesLifecycle(async () => {
    calls += 1;
    return Response.json({ id: "resp_unstored", object: "response" });
  });
  expect((await lifecycle(jsonRequest({ store: false, input: "hello" }))).status).toBe(200);
  expect((await lifecycle(new Request(`${url}/resp_unstored`))).status).toBe(404);
  const background = await lifecycle(
    jsonRequest({ store: true, background: true, input: "hello" }),
  );
  expect(background.status).toBe(501);
  expect(calls).toBe(1);
});

test("bounds records and expires them after the configured TTL", async () => {
  let time = 100;
  let id = 0;
  const lifecycle = createResponsesLifecycle(
    async () => Response.json({ id: `resp_${++id}`, object: "response" }),
    { maxRecords: 1, ttlMs: 10, now: () => time },
  );
  await lifecycle(jsonRequest({ store: true, input: "one" }));
  await lifecycle(jsonRequest({ store: true, input: "two" }));
  expect((await lifecycle(new Request(`${url}/resp_1`))).status).toBe(404);
  expect(lifecycle.size()).toBe(1);
  time += 11;
  expect(lifecycle.size()).toBe(0);
});
