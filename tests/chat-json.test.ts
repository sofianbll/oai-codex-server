import { expect, test } from "bun:test";
import OpenAI from "openai";
import { createResponsesGateway } from "../src/server/responses-gateway";

function fixture(output: Record<string, unknown> = {}, terminal = "response.completed") {
  const received: Record<string, unknown>[] = [];
  const upstream = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      message(socket, frame) {
        received.push(JSON.parse(String(frame)));
        socket.send(
          JSON.stringify({
            type: terminal,
            ...(terminal === "error" ? { error: output } : {}),
            response: {
              id: "resp_chat",
              object: "response",
              created_at: 123,
              model: "fixture-model",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Hello Ada" }],
                },
              ],
              usage: {
                input_tokens: 12,
                output_tokens: 5,
                total_tokens: 17,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens_details: { reasoning_tokens: 2 },
              },
              ...output,
            },
          }),
        );
      },
    },
  });
  const gateway = createResponsesGateway(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      defaultModel: "fixture-model",
      clientVersion: "fixture",
      translationMode: "minimal",
      timeoutMs: 1000,
      maxBodyBytes: 16384,
    },
    async () => ({ accessToken: "fixture", accountId: "fixture" }),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => gateway.forward(request),
  });
  return {
    received,
    gateway,
    client: new OpenAI({ apiKey: "local", baseURL: `${server.url.origin}/v1`, maxRetries: 0 }),
    close() {
      gateway.close();
      server.stop(true);
      upstream.stop(true);
    },
  };
}

test("SDK Chat JSON preserves ordered roles, text parts, identity and actual usage through Responses", async () => {
  const local = fixture();
  try {
    const completion = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "developer", content: "Use names" },
        { role: "user", content: [{ type: "text", text: "I am Ada" }] },
        { role: "assistant", content: "Welcome" },
        { role: "user", content: "Say hello" },
      ],
    });
    expect(completion).toMatchObject({
      id: "chatcmpl_chat",
      object: "chat.completion",
      created: 123,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello Ada", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });
    expect(local.received[0]).toMatchObject({
      type: "response.create",
      store: false,
      input: [
        { role: "system", content: [{ type: "input_text", text: "Be concise" }] },
        { role: "developer", content: [{ type: "input_text", text: "Use names" }] },
        { role: "user", content: [{ type: "input_text", text: "I am Ada" }] },
        { role: "assistant", content: [{ type: "output_text", text: "Welcome" }] },
        { role: "user", content: [{ type: "input_text", text: "Say hello" }] },
      ],
    });
    const stored = await local.gateway.forward(new Request("http://local/v1/responses/resp_chat"));
    expect(stored.status).toBe(404);
  } finally {
    local.close();
  }
});

test("Chat rejects unimplemented options and malformed messages before any upstream effect", async () => {
  const local = fixture();
  try {
    for (const extra of [
      { store: true },
      { store: null },
      { n: 2 },
      { temperature: 0 },
      { response_format: { type: "json_object" } },
      { future_option: "keep-me" },
      { stream_options: { include_usage: true } },
      { stream: true, stream_options: { include_usage: true, future_option: 1 } },
      { tools: [{ type: "function", function: { name: "lookup", future_option: 1 } }] },
      { messages: [{ role: "tool", content: "result", tool_call_id: "call_1" }] },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
          },
        ],
      },
      { messages: [{ role: "assistant", content: null, tool_calls: [] }] },
      {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
            ],
          },
        ],
      },
      {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "done" },
          { role: "tool", tool_call_id: "call_1", content: "duplicate" },
        ],
      },
      { messages: [{ role: "user", name: "Ada", content: "hello" }] },
    ]) {
      await expect(
        local.client.chat.completions
          .create({
            model: "fixture-model",
            messages: [{ role: "user", content: "hello" }],
            ...extra,
          } as OpenAI.ChatCompletionCreateParamsNonStreaming)
          .then((value) => value),
      ).rejects.toMatchObject({ status: 400, code: "unsupported_chat_contract" });
    }
    expect(local.received).toEqual([]);
  } finally {
    local.close();
  }
});

test("Chat retains refusal content and does not invent usage when upstream omits it", async () => {
  const local = fixture({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "Cannot comply" }],
      },
    ],
    usage: null,
  });
  try {
    const result = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      store: false,
      n: 1,
    });
    expect(result.choices[0]).toMatchObject({
      message: { content: null, refusal: "Cannot comply" },
      finish_reason: "stop",
    });
    expect(result.usage).toBeUndefined();
  } finally {
    local.close();
  }
});

test("Chat refuses unsupported native structured output instead of silently discarding it", async () => {
  const local = fixture({
    output: [{ type: "web_search_call", id: "search_1" }],
  });
  try {
    await expect(
      local.client.chat.completions
        .create({ model: "fixture-model", messages: [{ role: "user", content: "hello" }] })
        .then((value) => value),
    ).rejects.toMatchObject({ status: 502, code: "unsupported_chat_output" });
  } finally {
    local.close();
  }
});

test("Chat JSON returns structured functions with call ids, actual usage and tool_calls finish", async () => {
  const local = fixture({
    output: [
      { type: "reasoning", summary: [{ text: "private" }] },
      {
        type: "function_call",
        id: "fc_native",
        call_id: "call_public",
        name: "lookup",
        arguments: '{"city":"Paris"}',
      },
    ],
  });
  try {
    const result = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "lookup" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
    });
    expect(result.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: "call_public",
            type: "function",
            function: { name: "lookup", arguments: '{"city":"Paris"}' },
          },
        ],
      },
    });
    expect(result.usage?.total_tokens).toBe(17);
  } finally {
    local.close();
  }
});

test("Chat preserves an explicitly empty text instead of changing it to null", async () => {
  const local = fixture({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] }],
  });
  try {
    const result = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.choices[0]?.message.content).toBe("");
  } finally {
    local.close();
  }
});

test("Chat preserves native errors and failed/incomplete terminal statuses rather than claiming success", async () => {
  for (const terminal of ["error", "response.failed", "response.incomplete"]) {
    const local = fixture(
      {
        code: "fixture_denied",
        message: "Controlled refusal",
        status: terminal === "response.incomplete" ? "incomplete" : "failed",
        error: { code: "fixture_denied", message: "Controlled refusal" },
      },
      terminal,
    );
    try {
      await expect(
        local.client.chat.completions
          .create({ model: "fixture-model", messages: [{ role: "user", content: "hello" }] })
          .then((value) => value),
      ).rejects.toMatchObject({ status: 502, code: "fixture_denied" });
    } finally {
      local.close();
    }
  }
});

test("Chat stored routes, query options and oversized bodies are explicit failures without upstream effects", async () => {
  const local = fixture();
  try {
    for (const path of [
      "/v1/chat/completions",
      "/v1/chat/completions/chatcmpl_chat",
      "/v1/chat/completions/chatcmpl_chat/messages",
    ]) {
      const result = await local.gateway.forward(new Request(`http://local${path}`));
      expect(result.status).toBe(501);
    }
    const query = await local.gateway.forward(
      new Request("http://local/v1/chat/completions?future=1", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      }),
    );
    expect(query.status).toBe(400);
    const large = await local.gateway.forward(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(17000) }] }),
      }),
    );
    expect(large.status).toBe(413);
    expect(local.received).toEqual([]);
  } finally {
    local.close();
  }
});

test("raw Chat remains an unadapted HTTP relay, including unknown options and upstream failures", async () => {
  let received = "";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received = `${new URL(request.url).pathname}${new URL(request.url).search} ${await request.text()}`;
      return new Response("native refusal", { status: 422 });
    },
  });
  const gateway = createResponsesGateway(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      defaultModel: "fixture",
      clientVersion: "fixture",
      translationMode: "raw",
      timeoutMs: 1000,
      maxBodyBytes: 4096,
    },
    async () => ({ accessToken: "fixture", accountId: "fixture" }),
  );
  try {
    const body = '{ "messages": [], "store": true, "future": 42 }';
    const result = await gateway.forward(
      new Request("http://local/v1/chat/completions?test=1", { method: "POST", body }),
    );
    expect(result.status).toBe(422);
    expect(await result.text()).toBe("native refusal");
    expect(received).toBe(`/backend-api/codex/chat/completions?test=1 ${body}`);
  } finally {
    gateway.close();
    upstream.stop(true);
  }
});
