import { expect, test } from "bun:test";
import OpenAI from "openai";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ProxyOptions } from "../src/shared/contracts";

const identity = { id: "resp_stream", created_at: 123, model: "fixture-model" };
const textItem = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

test("SDK Chat completes the retained native text SSE event pattern", async () => {
  // Synthetic projection of the 15-event coordinator Responses trace, not the failed Chat call.
  const message = {
    ...textItem("RESPONSES_SSE_OK"),
    id: "msg_fixture",
    status: "completed",
    phase: "final_answer",
  };
  const part = { type: "output_text", text: "RESPONSES_SSE_OK", annotations: [], logprobs: [] };
  const location = { item_id: "msg_fixture", output_index: 0, content_index: 0 };
  const events = [
    { type: "response.created", response: { ...identity, status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { ...identity, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.content_part.added", ...location, part: { ...part, text: "" } },
    ...["RESP", "ON", "SES", "_S", "SE", "_OK"].map((delta) => ({
      type: "response.output_text.delta",
      ...location,
      delta,
      logprobs: [],
    })),
    {
      type: "response.metadata",
      response_id: identity.id,
      metadata: {
        openai_chatgpt_moderation_metadata: {
          prompt: { omnimod: { outputs: [{ is_blocked: false }] } },
        },
      },
    },
    { type: "response.output_text.done", ...location, text: "RESPONSES_SSE_OK", logprobs: [] },
    { type: "response.content_part.done", ...location, part },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        ...identity,
        status: "completed",
        output: [message],
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      },
    },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  const local = fixture((send) => {
    for (const event of events) send(event);
  });
  try {
    const stream = await local.client.chat.completions.create({
      model: "gpt-6-astra",
      messages: [{ role: "user", content: "Reply exactly RESPONSES_SSE_OK" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let finish: string | null | undefined;
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      text += chunk.choices[0]?.delta.content ?? "";
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }
    expect(text).toBe("RESPONSES_SSE_OK");
    expect(finish).toBe("stop");
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
    expect(JSON.stringify(chunks)).not.toContain("openai_chatgpt_moderation_metadata");
  } finally {
    local.close();
  }
});

test("native metadata does not replace Chat identity, content or failure semantics", async () => {
  for (const failed of [false, true]) {
    const local = fixture((send) => {
      send({ type: "response.created", response: identity });
      send({
        type: "response.metadata",
        response_id: identity.id,
        headers: { "OpenAI-Model": "native-header-model" },
        metadata: { openai_verification_recommendation: ["synthetic"] },
      });
      send({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Partial",
      });
      send(
        failed
          ? {
              type: "response.failed",
              response: {
                ...identity,
                status: "failed",
                error: { code: "fixture_denied", message: "Controlled failure" },
              },
            }
          : {
              type: "response.completed",
              response: { ...identity, status: "completed", output: [textItem("Partial")] },
            },
      );
    });
    try {
      const stream = await local.client.chat.completions.create({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({
        id: "chatcmpl_stream",
        model: "fixture-model",
        choices: [{ delta: { role: "assistant" } }],
      });
      expect((await iterator.next()).value?.choices[0]?.delta).toEqual({ content: "Partial" });
      if (failed) await expect(iterator.next()).rejects.toMatchObject({ code: "fixture_denied" });
      else {
        expect((await iterator.next()).value?.choices[0]?.finish_reason).toBe("stop");
        expect((await iterator.next()).done).toBe(true);
      }
    } finally {
      local.close();
    }
  }
});

function fixture(
  run: (send: (event: Record<string, unknown>) => void, input: Record<string, unknown>) => void,
  options: Partial<ProxyOptions> = {},
) {
  const received: Record<string, unknown>[] = [];
  const closed = Promise.withResolvers<void>();
  const upstream = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("WS required", { status: 400 });
    },
    websocket: {
      message(socket, frame) {
        const input = JSON.parse(String(frame)) as Record<string, unknown>;
        received.push(input);
        run((event) => socket.send(JSON.stringify(event)), input);
      },
      close() {
        closed.resolve();
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
      ...options,
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
    closed: closed.promise,
    client: new OpenAI({ apiKey: "local", baseURL: `${server.url.origin}/v1`, maxRetries: 0 }),
    close() {
      gateway.close();
      server.stop(true);
      upstream.stop(true);
    },
  };
}

test("SDK Chat receives text before terminal with stable identity, final reason and opt-in usage", async () => {
  let finish = () => {};
  const local = fixture((send) => {
    send({ type: "response.created", response: identity });
    send({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "private" });
    send({
      type: "response.output_text.delta",
      output_index: 1,
      content_index: 0,
      delta: "Bonjour ",
    });
    finish = () =>
      send({
        type: "response.completed",
        response: {
          ...identity,
          status: "completed",
          output: [{ type: "reasoning", summary: [{ text: "private" }] }, textItem("Bonjour Ada")],
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      });
  });
  try {
    const stream = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const iterator = stream[Symbol.asyncIterator]();
    const role = (await iterator.next()).value;
    expect(role).toMatchObject({
      id: "chatcmpl_stream",
      object: "chat.completion.chunk",
      created: 123,
      model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      usage: null,
    });
    expect((await iterator.next()).value?.choices[0]?.delta.content).toBe("Bonjour ");
    finish();
    const remaining = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next())
      remaining.push(next.value);
    expect(
      remaining
        .map((chunk) => chunk.choices[0]?.delta.content)
        .filter((value) => value !== undefined),
    ).toEqual(["Ada"]);
    expect(remaining.at(-2)?.choices[0]?.finish_reason).toBe("stop");
    expect(remaining.at(-1)).toMatchObject({
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });
  } finally {
    local.close();
  }
});

test("SDK Chat tool argument deltas and two result turns keep call ids and structured history", async () => {
  let turn = 0;
  const local = fixture((send) => {
    turn++;
    send({ type: "response.created", response: identity });
    if (turn < 3) {
      const call = {
        type: "function_call",
        id: `fc_${turn}`,
        call_id: `call_${turn}`,
        name: "lookup",
        arguments: "",
      };
      send({ type: "response.output_item.added", output_index: 2, item: call });
      send({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: call.id,
        delta: '{"n":',
      });
      send({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: call.id,
        delta: `${turn}}`,
      });
      send({
        type: "response.output_item.done",
        output_index: 2,
        item: { ...call, arguments: `{"n":${turn}}` },
      });
      send({
        type: "response.completed",
        response: {
          ...identity,
          status: "completed",
          output: [
            { type: "reasoning" },
            { type: "reasoning" },
            { ...call, arguments: `{"n":${turn}}` },
          ],
        },
      });
    } else
      send({
        type: "response.completed",
        response: { ...identity, status: "completed", output: [textItem("Results received")] },
      });
  });
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "lookup twice" }];
  try {
    for (let n = 1; n <= 2; n++) {
      const stream = await local.client.chat.completions.create({
        model: "fixture-model",
        messages,
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup",
              parameters: { type: "object", properties: { n: { type: "integer" } } },
              strict: true,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "lookup" } },
        parallel_tool_calls: false,
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const calls = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
      expect(calls[0]).toEqual({
        index: 0,
        id: `call_${n}`,
        type: "function",
        function: { name: "lookup", arguments: "" },
      });
      expect(calls.slice(1).map((call) => call.function?.arguments)).toEqual(['{"n":', `${n}}`]);
      expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
      expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true);
      messages.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${n}`,
              type: "function",
              function: { name: "lookup", arguments: `{"n":${n}}` },
            },
          ],
        },
        { role: "tool", tool_call_id: `call_${n}`, content: `result_${n}` },
      );
    }
    const final = await local.client.chat.completions.create({ model: "fixture-model", messages });
    expect(final.choices[0]?.message.content).toBe("Results received");
    expect(local.received[2]?.["input"]).toEqual([
      { role: "user", content: [{ type: "input_text", text: "lookup twice" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"n":1}' },
      { type: "function_call_output", call_id: "call_1", output: "result_1" },
      { type: "function_call", call_id: "call_2", name: "lookup", arguments: '{"n":2}' },
      { type: "function_call_output", call_id: "call_2", output: "result_2" },
    ]);
    expect(local.received[0]).toMatchObject({
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup",
          strict: true,
          parameters: { type: "object", properties: { n: { type: "integer" } } },
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
    });
    expect(local.received).toHaveLength(3);
  } finally {
    local.close();
  }
});

test("Chat refuses an unknown upstream streaming extension rather than losing it silently", async () => {
  const local = fixture((send) => {
    send({ type: "response.created", response: identity });
    send({ type: "vendor.future", payload: "cannot translate" });
  });
  try {
    const stream = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          /* consume public SDK stream */
        }
      })(),
    ).rejects.toMatchObject({ code: "unsupported_chat_output" });
  } finally {
    local.close();
  }
});

test("Chat SDK preserves partial text then reports native errors and failed/incomplete terminals without a success finish", async () => {
  for (const type of ["error", "response.failed", "response.incomplete"]) {
    let fail = () => {};
    const local = fixture((send) => {
      send({ type: "response.created", response: identity });
      send({ type: "response.output_text.delta", output_index: 0, delta: "Partial" });
      fail = () =>
        send({
          type,
          error: { code: "fixture_denied", message: "Controlled failure" },
          response: {
            ...identity,
            status: "failed",
            output: [],
            error: { code: "fixture_denied", message: "Controlled failure" },
          },
        });
    });
    try {
      const stream = await local.client.chat.completions.create({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      expect((await iterator.next()).value?.choices[0]?.delta.content).toBe("Partial");
      fail();
      await expect(iterator.next()).rejects.toMatchObject({
        code: "fixture_denied",
        message: "Controlled failure",
      });
    } finally {
      local.close();
    }
  }
});

test("Chat SDK deadline reports a stream error and closes the native socket", async () => {
  const local = fixture(
    (send) => {
      send({ type: "response.created", response: identity });
    },
    { timeoutMs: 80 },
  );
  try {
    const stream = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.choices[0]?.delta.role).toBe("assistant");
    await expect(iterator.next()).rejects.toMatchObject({ code: "upstream_timeout" });
    await local.closed;
  } finally {
    local.close();
  }
});

test("Chat SDK cancellation closes the native socket without replay", async () => {
  const local = fixture((send) => {
    send({ type: "response.created", response: identity });
  });
  try {
    const stream = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    for await (const chunk of stream) {
      expect(chunk.choices[0]?.delta.role).toBe("assistant");
      stream.controller.abort();
      break;
    }
    await local.closed;
    expect(local.received).toHaveLength(1);
  } finally {
    local.close();
  }
});

test("a stalled Chat consumer keeps bounded backpressure and gets slow_consumer, never success", async () => {
  const local = fixture(
    (send) => {
      send({ type: "response.created", response: identity });
      for (let n = 0; n < 30; n++)
        send({
          type: "response.output_text.delta",
          output_index: 0,
          delta: "x",
          extension_padding: "x".repeat(1000),
        });
    },
    { maxBodyBytes: 4096 },
  );
  try {
    const response = await local.gateway.forward(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: true }),
      }),
    );
    await Bun.sleep(30);
    const body = await response.text();
    expect(body).toContain('"code":"slow_consumer"');
    expect(body).not.toContain('"finish_reason":"stop"');
    expect(body).not.toContain("[DONE]");
    await local.closed;
  } finally {
    local.close();
  }
});

test("an actively consumed Chat stream still bounds aggregated text", async () => {
  const local = fixture(
    (send) => {
      send({ type: "response.created", response: identity });
      for (let n = 1; n <= 5; n++)
        setTimeout(
          () =>
            send({ type: "response.output_text.delta", output_index: 0, delta: "x".repeat(1000) }),
          n * 10,
        );
    },
    { maxBodyBytes: 4096 },
  );
  try {
    const stream = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          /* consume public SDK stream */
        }
      })(),
    ).rejects.toMatchObject({ code: "body_too_large" });
    await local.closed;
  } finally {
    local.close();
  }
});

test("Chat rejects conflicting native item ids instead of assigning arguments to the wrong call", async () => {
  const local = fixture((send) => {
    const call = {
      type: "function_call",
      id: "fc_right",
      call_id: "call_1",
      name: "lookup",
      arguments: "",
    };
    send({ type: "response.created", response: identity });
    send({ type: "response.output_item.added", output_index: 0, item: call });
    send({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_wrong",
      delta: "{}",
    });
    send({
      type: "response.completed",
      response: { ...identity, status: "completed", output: [{ ...call, arguments: "{}" }] },
    });
  });
  try {
    const stream = await local.client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "lookup" }],
      stream: true,
    });
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          /* consume public SDK stream */
        }
      })(),
    ).rejects.toMatchObject({ code: "unsupported_chat_output" });
  } finally {
    local.close();
  }
});

test("SDK stream assembler keeps parallel tool indices and interleaved Unicode argument fragments", async () => {
  const local = fixture((send) => {
    send({ type: "response.created", response: identity });
    const first = { type: "function_call", call_id: "call_a", name: "lookup", arguments: "" };
    const second = { type: "function_call", call_id: "call_b", name: "lookup", arguments: "" };
    send({ type: "response.output_item.added", output_index: 1, item: first });
    send({ type: "response.output_item.added", output_index: 2, item: second });
    for (const [output_index, delta] of [
      [1, '{"city":"'],
      [2, '{"city":"'],
      [2, '東京"}'],
      [1, 'Évry"}'],
    ])
      send({ type: "response.function_call_arguments.delta", output_index, delta });
    send({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning" } });
    send({
      type: "response.output_item.done",
      output_index: 1,
      item: { ...first, arguments: '{"city":"Évry"}' },
    });
    send({
      type: "response.output_item.done",
      output_index: 2,
      item: { ...second, arguments: '{"city":"東京"}' },
    });
    send({
      type: "response.completed",
      response: { ...identity, status: "completed", output: [] },
    });
  });
  try {
    const stream = local.client.chat.completions.stream({
      model: "fixture-model",
      messages: [{ role: "user", content: "two cities" }],
    });
    const final = await stream.finalChatCompletion();
    expect(final.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "lookup", arguments: '{"city":"Évry"}' },
          },
          {
            id: "call_b",
            type: "function",
            function: { name: "lookup", arguments: '{"city":"東京"}' },
          },
        ],
      },
    });
  } finally {
    local.close();
  }
});

test("Chat SSE handles empty output, empty text and refusals without invented usage or reasoning text", async () => {
  for (const [output, delta] of [
    [[], undefined],
    [[textItem("")], { content: "" }],
    [
      [
        { type: "reasoning", summary: [{ text: "private" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "Cannot comply" }],
        },
      ],
      { refusal: "Cannot comply" },
    ],
  ] as const) {
    const local = fixture((send) =>
      send({ type: "response.completed", response: { ...identity, status: "completed", output } }),
    );
    try {
      const stream = await local.client.chat.completions.create({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true },
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
      if (delta) expect(chunks[1]?.choices[0]?.delta).toEqual(delta);
      expect(chunks.at(-2)?.choices[0]).toMatchObject({ delta: {}, finish_reason: "stop" });
      expect(chunks.at(-1)).toMatchObject({ choices: [], usage: null });
      expect(JSON.stringify(chunks)).not.toContain("private");
    } finally {
      local.close();
    }
  }
});
