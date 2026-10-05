import { z } from "zod";
import { optionsFromArgs, redact, writeReport, wsEndpoint } from "./acceptance";

const wireEvent = z
  .object({
    type: z.string(),
    delta: z.string().optional(),
    sequence_number: z.number().optional(),
    response: z
      .object({ id: z.string().optional(), output_text: z.string().optional() })
      .passthrough()
      .optional(),
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  })
  .passthrough();
type WireEvent = Readonly<z.infer<typeof wireEvent>>;

function parseEvent(data: string | ArrayBuffer): WireEvent {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  return wireEvent.parse(JSON.parse(text));
}

function completed(events: readonly WireEvent[]): WireEvent | undefined {
  return events.findLast((event) => event.type === "response.completed");
}

function outputText(events: readonly WireEvent[]): string {
  return events.map((event) => event.delta ?? "").join("");
}

function ordered(events: readonly WireEvent[]): boolean {
  let previous = -1;
  for (const event of events) {
    const sequence = event.sequence_number;
    if (sequence === undefined) continue;
    if (sequence <= previous) return false;
    previous = sequence;
  }
  return (
    events.some((event) => event.type === "response.created") &&
    events.some((event) => event.type === "response.completed")
  );
}

async function exchange(
  socket: WebSocket,
  payload: Record<string, unknown>,
): Promise<readonly WireEvent[]> {
  const events: WireEvent[] = [];
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", failed);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new TypeError("WebSocket response timed out"));
    }, 30_000);
    const receive = (event: MessageEvent<string | ArrayBuffer>) => {
      try {
        const wire = parseEvent(event.data);
        events.push(wire);
        if (
          wire.type === "response.completed" ||
          wire.type === "response.failed" ||
          wire.type === "error"
        ) {
          cleanup();
          resolve(events);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const closed = () => {
      cleanup();
      reject(new TypeError("WebSocket closed before a terminal event"));
    };
    const failed = () => {
      cleanup();
      reject(new TypeError("WebSocket failed"));
    };
    socket.addEventListener("message", receive);
    socket.addEventListener("close", closed);
    socket.addEventListener("error", failed);
    socket.send(JSON.stringify(payload));
  });
}

async function main(): Promise<void> {
  const options = await optionsFromArgs(process.argv.slice(2));
  const secret = `WS_SECRET_${crypto.randomUUID()}`;
  const socket = new WebSocket(wsEndpoint(options.baseUrl), [
    "oai-codex",
    `oai-codex-token.${options.key}`,
  ]);
  const events: WireEvent[] = [];
  let result = "unavailable";
  let detail = "connection failed";
  let firstAcknowledged = false;
  let secondRecalledSecret = false;
  let firstEvents: readonly WireEvent[] = [];
  let secondEvents: readonly WireEvent[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new TypeError("WebSocket upgrade failed")), {
        once: true,
      });
    });
    const first = await exchange(socket, {
      type: "response.create",
      model: options.model,
      instructions: "Follow the user's answer-format instruction exactly.",
      input: [{ role: "user", content: `Memorize ${secret} and reply exactly ACK.` }],
    });
    firstEvents = first;
    events.push(...first);
    const firstCompleted = completed(first);
    const firstID = firstCompleted?.response?.id;
    if (!firstID) {
      const failure = first.find(
        (event) => event.type === "error" || event.type === "response.failed",
      );
      result = failure ? "rejected" : "failed";
      detail = failure?.error?.message ?? "First response lacked an id";
      throw new TypeError(detail);
    }
    firstAcknowledged = outputText(first).trim() === "ACK";
    if (!firstAcknowledged) throw new TypeError("First response did not acknowledge the secret");
    const secondPayload = {
      type: "response.create",
      model: options.model,
      instructions: "Follow the user's answer-format instruction exactly.",
      input: [{ role: "user", content: "Reply only with the memorized secret." }],
      previous_response_id: firstID,
    };
    if (JSON.stringify(secondPayload).includes(secret))
      throw new TypeError("Second payload contains secret");
    const second = await exchange(socket, secondPayload);
    secondEvents = second;
    events.push(...second);
    const secondCompleted = completed(second);
    secondRecalledSecret = outputText(second).trim() === secret;
    result =
      secondCompleted && secondRecalledSecret && ordered(first) && ordered(second)
        ? "observed"
        : "failed";
    detail = `first_id=${firstID}, second_events=${second.map((event) => event.type).join(",")}`;
  } catch (error) {
    if (result === "unavailable") detail = error instanceof Error ? error.message : "Unknown error";
  } finally {
    socket.close(1000, "acceptance complete");
  }
  const report = {
    timestamp: new Date().toISOString(),
    scenario: "responses/websocket-two-turn",
    model: options.model,
    endpoint: wsEndpoint(options.baseUrl),
    result,
    detail,
    requests: [
      { type: "response.create", input: "[REDACTED]", previous_response_id: null },
      {
        type: "response.create",
        input: "Reply only with the memorized secret.",
        previous_response_id: "[REDACTED_RESPONSE_ID]",
      },
    ],
    first_acknowledged: firstAcknowledged,
    second_recalled_secret: secondRecalledSecret,
    ordered_valid_events: ordered(firstEvents) && ordered(secondEvents),
    event_types: events.map((event) => event.type),
    secret_in_second_payload: false,
    exit_code: result === "observed" ? 0 : result === "unavailable" ? 2 : 1,
  };
  const path = await writeReport(
    options,
    "websocket",
    JSON.parse(redact(JSON.stringify(report), [options.key, secret])) as Record<string, unknown>,
  );
  console.log(`Report: ${path}`);
  process.exitCode = report.exit_code;
}

await main();
