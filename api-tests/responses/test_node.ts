import OpenAI from "openai";
import { optionsFromArgs, redact, writeReport } from "./acceptance";

type Check = Readonly<{
  readonly name: string;
  readonly passed: boolean | null;
  readonly detail: string;
}>;

function errorDetail(error: unknown): string {
  if (error instanceof OpenAI.APIError)
    return `HTTP ${error.status ?? "unknown"}, code=${error.code ?? "unknown"}`;
  return error instanceof Error ? error.name : "Unknown error";
}

async function collectStream(
  client: OpenAI,
  model: string,
): Promise<Readonly<{ readonly text: string; readonly types: readonly string[] }>> {
  const stream = await client.responses.create({
    model,
    input: "Réponds exactement : NODE_SSE_OK",
    store: false,
    stream: true,
  });
  const types: string[] = [];
  let text = "";
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === "response.output_text.delta") text += event.delta;
  }
  return { text, types };
}

async function main(): Promise<void> {
  const options = await optionsFromArgs(process.argv.slice(2));
  const client = new OpenAI({
    apiKey: options.key,
    baseURL: `${options.baseUrl.replace(/\/$/, "")}/`,
    maxRetries: 0,
    timeout: 300_000,
  });
  const checks: Check[] = [];
  let unavailable = false;
  let continuityID: string | null = null;
  const failed = (name: string, error: unknown) => {
    unavailable ||= error instanceof OpenAI.APIConnectionError;
    checks.push({ name, passed: false, detail: errorDetail(error) });
  };
  try {
    const json = await client.responses.create({
      model: options.model,
      input: "Réponds exactement : NODE_JSON_OK",
      store: false,
    });
    checks.push({
      name: "JSON SDK",
      passed: json.output_text.trim() === "NODE_JSON_OK",
      detail: `id=${json.id}, status=${json.status}`,
    });
  } catch (error) {
    failed("JSON SDK", error);
  }
  try {
    const stream = await collectStream(client, options.model);
    checks.push({
      name: "SSE SDK",
      passed: stream.text.trim() === "NODE_SSE_OK" && stream.types.includes("response.completed"),
      detail: stream.types.join(","),
    });
  } catch (error) {
    failed("SSE SDK", error);
  }
  try {
    const structured = await client.responses.create({
      model: options.model,
      input: 'Réponds uniquement avec {"answer":42}.',
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          strict: true,
          schema: {
            type: "object",
            properties: { answer: { type: "integer" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    });
    let answer: unknown = null;
    try {
      answer = JSON.parse(structured.output_text).answer;
    } catch {
      answer = null;
    }
    checks.push({
      name: "Structured SDK",
      passed: answer === 42,
      detail: `id=${structured.id}, parsed_answer=${String(answer)}`,
    });
  } catch (error) {
    failed("Structured SDK", error);
  }
  const secret = `NODE_SECRET_${crypto.randomUUID()}`;
  try {
    const first = await client.responses.create({
      model: options.model,
      input: `Memorize ${secret} and reply exactly ACK.`,
      store: false,
    });
    continuityID = first.id;
    const second = await client.responses.create({
      model: options.model,
      input: "Reply only with the memorized secret.",
      previous_response_id: first.id,
    });
    checks.push({
      name: "previous_response_id store:false",
      passed: second.output_text.trim() === secret,
      detail: `first_id=${first.id}, second_id=${second.id}`,
    });
  } catch (error) {
    failed("previous_response_id store:false", error);
  }
  try {
    const stored = await client.responses.create({
      model: options.model,
      input: "Reply exactly STORE_OK.",
      store: true,
    });
    try {
      const retrieved = await client.responses.retrieve(stored.id);
      checks.push({
        name: "store:true create and retrieve",
        passed:
          "store" in stored &&
          stored.store === true &&
          retrieved.id === stored.id &&
          retrieved.output_text.trim() === "STORE_OK",
        detail: `id=${stored.id}, status=${retrieved.status}`,
      });
    } finally {
      await client.responses.delete(stored.id);
    }
    try {
      await client.responses.retrieve(stored.id);
      checks.push({
        name: "retrieve deleted response",
        passed: false,
        detail: "Response still exists",
      });
    } catch (error) {
      checks.push({
        name: "retrieve deleted response",
        passed: error instanceof OpenAI.APIError && error.status === 404,
        detail: errorDetail(error),
      });
    }
  } catch (error) {
    failed("store:true lifecycle", error);
  }
  const technical = checks.length > 0 && checks.every((check) => check.passed === true);
  const report = {
    timestamp: new Date().toISOString(),
    sdk_version: "openai@7.20.0",
    scenario: "responses/node-sdk",
    model: options.model,
    request: { base_url: options.baseUrl, auth: "[REDACTED]" },
    continuity_response_id: continuityID,
    checks,
    technical_passed: technical,
    behavior_passed: technical,
    exit_code: unavailable ? 2 : technical ? 0 : 1,
  };
  const path = await writeReport(
    options,
    "node",
    JSON.parse(redact(JSON.stringify(report), [options.key])) as Record<string, unknown>,
  );
  console.log(`Report: ${path}`);
  process.exitCode = report.exit_code;
}

await main();
