import { z } from "zod";
import type { StreamEvent } from "./api";
import type { TestScenario } from "./test-scenarios";

export type TestVerdict = {
  readonly technical: "passed" | "failed";
  readonly behavior: "passed" | "failed" | "manual";
  readonly text: string;
  readonly detail: string;
};
type ResultInput = {
  readonly data: string;
  readonly streamed: boolean;
  readonly events: readonly StreamEvent[];
};
const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output_text"), text: z.string() }),
  z.object({ type: z.literal("refusal"), refusal: z.string() }),
]);
const output = z.union([
  z.object({ type: z.literal("message"), content: z.array(content) }),
  z.object({
    type: z.literal("function_call"),
    name: z.string(),
    call_id: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("reasoning"),
    summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })),
  }),
]);
const responseSchema = z.object({
  id: z.string().min(1),
  object: z.literal("response"),
  status: z.literal("completed"),
  output: z.array(output),
  error: z.null().optional(),
});
const tokensSchema = z.object({
  object: z.literal("response.input_tokens"),
  input_tokens: z.number().int().nonnegative(),
});
const compactSchema = z.object({
  id: z.string().min(1),
  object: z.literal("response.compaction"),
  output: z
    .array(z.object({ type: z.string(), encrypted_content: z.string().optional() }))
    .refine((items) =>
      items.some((item) => item.type === "compaction" && Boolean(item.encrypted_content)),
    ),
});
const structuredSchema = z.object({ ok: z.literal(true) }).strict();
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
function failed(detail: string): TestVerdict {
  return { technical: "failed", behavior: "failed", text: "", detail };
}
function assertNever(value: never): never {
  throw new TypeError(`Vérification inconnue : ${value}`);
}

export function evaluateResult(scenario: TestScenario, result: ResultInput): TestVerdict {
  const requestedStream = scenario.body["stream"] === true;
  if (requestedStream !== result.streamed)
    return failed(
      requestedStream
        ? "Streaming demandé : le serveur a renvoyé une réponse sans flux SSE."
        : "Réponse sans streaming demandée : le serveur a renvoyé un flux SSE.",
    );
  let payload: unknown = parseJson(result.data);
  if (result.streamed) {
    if (
      result.events.some(
        (event) =>
          event.type === "error" ||
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event["error"] != null,
      )
    )
      return failed("Le flux contient un événement d’erreur ou une réponse incomplète.");
    const terminal = result.events.findLast((event) => event.type === "response.completed");
    if (!terminal) return failed("Flux interrompu : événement response.completed absent.");
    payload = terminal.response;
  }
  switch (scenario.check) {
    case "tokens": {
      const parsed = tokensSchema.safeParse(payload);
      return parsed.success
        ? {
            technical: "passed",
            behavior: "passed",
            text: String(parsed.data.input_tokens),
            detail: "Comptage de tokens valide.",
          }
        : failed("Le serveur n’a pas renvoyé un comptage de tokens valide.");
    }
    case "compact": {
      const parsed = compactSchema.safeParse(payload);
      return parsed.success
        ? {
            technical: "passed",
            behavior: "passed",
            text: "",
            detail: "Réponse de compactage valide ; la fidélité du contexte reste à vérifier.",
          }
        : failed("Le serveur n’a pas renvoyé une réponse de compactage valide.");
    }
    case "exact":
    case "json":
    case "text":
    case "manual":
      break;
    default:
      return assertNever(scenario.check);
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success)
    return failed(
      "Réponse invalide, incomplète ou absente : un objet response terminé est requis.",
    );
  const text = parsed.data.output
    .flatMap((item) =>
      item.type === "message"
        ? item.content.flatMap((part) => (part.type === "output_text" ? [part.text] : []))
        : [],
    )
    .join("");
  if (
    result.streamed &&
    (text.length > 0 || (scenario.check === "exact" && Boolean(scenario.expectedText)))
  ) {
    const terminalIndex = result.events.findLastIndex(
      (event) => event.type === "response.completed",
    );
    const hasTextDelta = result.events
      .slice(0, terminalIndex)
      .some(
        (event) =>
          event.type === "response.output_text.delta" &&
          typeof event.delta === "string" &&
          event.delta.length > 0,
      );
    if (!hasTextDelta)
      return failed(
        "Le flux contient un texte final mais aucun fragment de texte diffusé avant sa fin.",
      );
  }
  switch (scenario.check) {
    case "exact":
      return {
        technical: "passed",
        behavior:
          scenario.expectedText !== undefined && text === scenario.expectedText
            ? "passed"
            : "failed",
        text,
        detail:
          text === scenario.expectedText
            ? "Texte exactement conforme."
            : "Le texte diffère du résultat attendu.",
      };
    case "json":
      return {
        technical: "passed",
        behavior: structuredSchema.safeParse(parseJson(text)).success ? "passed" : "failed",
        text,
        detail: 'Vérification de l’objet JSON attendu : {"ok":true}.',
      };
    case "text":
      return {
        technical: "passed",
        behavior: text.trim() ? "passed" : "failed",
        text,
        detail: text.trim() ? "Réponse textuelle reçue." : "Aucun texte de réponse reçu.",
      };
    case "manual":
      return {
        technical: "passed",
        behavior: "manual",
        text,
        detail:
          "Réponse terminée ; vérifiez manuellement le résultat et les éventuels appels d’outils.",
      };
    default:
      return assertNever(scenario.check);
  }
}
