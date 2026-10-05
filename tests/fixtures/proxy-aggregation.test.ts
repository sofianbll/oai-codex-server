import { expect, test } from "bun:test";
import OpenAI from "openai";
import { completed, fixture, sse } from "./proxy-harness";

test.each(["absent", "empty"])(
  "reconstructs SDK output when the final Codex output is %s",
  async (shape) => {
    // Given: completed items are present only in output_item.done events.
    const expected = completed();
    const { output, ...metadata } = expected;
    const finalResponse = { ...metadata, ...(shape === "empty" ? { output: [] } : {}) };
    const events = output.map((item, output_index) => ({
      type: "response.output_item.done",
      output_index,
      item,
    }));
    const wire = [...events, { type: "response.completed", response: finalResponse }]
      .map(sse)
      .join("");
    const server = fixture(
      () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
    );
    try {
      // When: the official SDK asks for a nonstreaming Response.
      const client = new OpenAI({ apiKey: "fixture", baseURL: server.url, maxRetries: 0 });
      const result = await client.responses.create({
        model: "fixture",
        input: "Hi",
        stream: false,
      });
      // Then: completed items and the SDK output_text helper contain the actual answer.
      expect(result).toMatchObject(expected);
      expect(result.output_text).toBe("Bonjour 🌍");
    } finally {
      server.close();
    }
  },
);

test("orders completed items by output_index and preserves tools and unknown fields", async () => {
  // Given: completed output items arrive in a different order from their indices.
  const items = [
    {
      type: "function_call",
      id: "fc_fixture",
      call_id: "call_fixture",
      name: "lookup",
      arguments: '{"city":"Paris"}',
      status: "completed",
      future_tool: { opaque: true },
    },
    {
      type: "message",
      id: "msg_fixture",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Paris 🌍", annotations: [], future_content: [1] }],
      future_message: "retained",
    },
    { type: "future_output", id: "future_fixture", payload: { bytes: "opaque" } },
  ];
  const events = [2, 0, 1].map((output_index) => ({
    type: "response.output_item.done",
    output_index,
    item: items[output_index],
  }));
  const finalResponse = {
    ...completed(),
    output: [],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    future_final: true,
  };
  const wire = [...events, { type: "response.completed", response: finalResponse }]
    .map(sse)
    .join("");
  const server = fixture(
    () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
  );
  try {
    // When: minimal mode reconstructs a nonstreaming response.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":[],"stream":false}',
    });
    const body: unknown = await result.json();
    // Then: full original items are sorted while final response metadata remains authoritative.
    expect(body).toEqual({ ...finalResponse, output: items });
  } finally {
    server.close();
  }
});

test("preserves authoritative nonempty final output instead of replacing it with done events", async () => {
  // Given: the final response carries an authoritative output snapshot.
  const expected = completed("Final authoritative answer");
  const events = completed("Earlier done answer").output.map((item, output_index) => ({
    type: "response.output_item.done",
    output_index,
    item,
  }));
  const wire = [...events, { type: "response.completed", response: expected }].map(sse).join("");
  const server = fixture(
    () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
  );
  try {
    // When: the nonstreaming adapter receives both sources of output.
    const result = await fetch(`${server.url}/responses`, {
      method: "POST",
      body: '{"input":[],"stream":false}',
    });
    const body: unknown = await result.json();
    // Then: the nonempty final output remains unchanged.
    expect(body).toEqual(expected);
  } finally {
    server.close();
  }
});

test.each(["absent", "empty"])(
  "reconstructs streamed final output when Codex output is %s",
  async (shape) => {
    const expected = completed();
    const { output, ...metadata } = expected;
    const events = output.map((item, output_index) => ({
      type: "response.output_item.done",
      output_index,
      item,
    }));
    const wire = [
      ...events,
      {
        type: "response.completed",
        response: { ...metadata, ...(shape === "empty" ? { output: [] } : {}) },
      },
    ]
      .map(sse)
      .join("");
    const server = fixture(
      () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
    );
    try {
      const client = new OpenAI({ apiKey: "fixture", baseURL: server.url, maxRetries: 0 });
      const stream = await client.responses.create({ model: "fixture", input: "Hi", stream: true });
      const finals: unknown[] = [];
      for await (const event of stream) {
        if (event.type === "response.completed") finals.push(event.response);
      }
      expect(finals).toEqual([expected]);
    } finally {
      server.close();
    }
  },
);
