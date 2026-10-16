import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { createResponsesGateway } from "../src/server/responses-gateway";

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
