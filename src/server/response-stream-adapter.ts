import { z } from "zod";
import { GatewayError } from "../shared/contracts";

const eventSchema = z.looseObject({
  type: z.string(),
  output_index: z.number().int().nonnegative().optional(),
  item: z.record(z.string(), z.unknown()).optional(),
  response: z.record(z.string(), z.unknown()).optional(),
});

export function restoreStreamOutput(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const items = new Map<number, Readonly<Record<string, unknown>>>();
  const sizes = new Map<number, number>();
  let retainedBytes = 0;
  let pending = "";
  const limit = () => {
    if (retainedBytes + encoder.encode(pending).byteLength > maxBytes) {
      throw new GatewayError(
        502,
        "body_too_large",
        "Buffered response output exceeds the configured byte limit",
      );
    }
  };
  const adaptFrame = (frame: string): string => {
    const lines = frame.split(/\r\n|\r|\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return frame;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (error) {
      if (error instanceof SyntaxError) return frame;
      throw error;
    }
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return frame;
    const event = parsed.data;
    if (
      event.type === "response.output_item.done" &&
      event.output_index !== undefined &&
      event.item
    ) {
      const size = encoder.encode(JSON.stringify(event.item)).byteLength;
      retainedBytes += size - (sizes.get(event.output_index) ?? 0);
      sizes.set(event.output_index, size);
      items.set(event.output_index, event.item);
      limit();
    }
    if (
      ["response.completed", "response.failed", "response.incomplete"].includes(event.type) &&
      event.response
    ) {
      const output = event.response["output"];
      if (
        items.size > 0 &&
        (output === undefined || (Array.isArray(output) && output.length === 0))
      ) {
        const replacement = JSON.stringify({
          ...event,
          response: {
            ...event.response,
            output: [...items].sort(([a], [b]) => a - b).map(([, item]) => item),
          },
        });
        let inserted = false;
        const updated = lines.flatMap((line) => {
          if (!line.startsWith("data:")) return [line];
          if (inserted) return [];
          inserted = true;
          return [`data: ${replacement}`];
        });
        return updated.join(frame.includes("\r\n") ? "\r\n" : frame.includes("\r") ? "\r" : "\n");
      }
    }
    return frame;
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(pending);
      while (boundary) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (encoder.encode(frame).byteLength > maxBytes) {
          throw new GatewayError(
            502,
            "body_too_large",
            "SSE event exceeds the configured byte limit",
          );
        }
        controller.enqueue(encoder.encode(adaptFrame(frame) + boundary[0]));
        boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(pending);
      }
      limit();
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(pending));
    },
  });
}
