import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Operation } from "../shared/contracts";

const parameterSchema = z.object({ name: z.string(), in: z.string() }).catchall(z.json());
const mediaSchema = z.object({ schema: z.json().optional() }).catchall(z.json());
const definitionSchema = z
  .object({
    operationId: z.string(),
    summary: z.string(),
    description: z.string().optional(),
    parameters: z.array(parameterSchema).optional(),
    requestBody: z
      .object({ content: z.record(z.string(), mediaSchema) })
      .catchall(z.json())
      .optional(),
    responses: z.record(z.string(), z.json()),
  })
  .catchall(z.json());
const documentSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), definitionSchema)),
  components: z.record(z.string(), z.json()),
});

export const publicApi = documentSchema.parse(
  JSON.parse(
    await readFile(
      new URL("../../codex-contract-atlas/snapshot/openapi.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const publicOperations = Object.entries(publicApi.paths)
  .filter(
    ([path]) =>
      /^\/(responses|models|images|audio|realtime|live)(\/|$)/.test(path) && !path.includes("?"),
  )
  .flatMap(([path, item]) =>
    Object.entries(item).map(([method, definition]) => ({ path, method, definition })),
  );

export const transportDescription =
  "This server relays /v1/* to the fixed ChatGPT Codex backend. Raw mode forwards request and response bytes, including multipart, binary and SSE, without schema filtering. Unknown fields are preserved. supported=true means the local proxy can relay the route; it does not guarantee that the account or Codex backend supports the public API operation.";
const publicDescription =
  "The schema is the public OpenAI contract, not proof of Codex backend availability. Upstream status codes and errors are returned to the caller.";
const responsesDescription =
  "In minimal mode, POST /v1/responses converts string input to a user message, supplies a missing model and instructions, sets store=false and requests stream=true upstream. stream=false callers receive the terminal response aggregated from SSE. For stream=true, the proxy restores terminal response.output only when the upstream terminal event omits or empties it; other event frames remain unchanged. Other fields, including tools, reasoning, metadata and future extensions, are retained. Raw mode bypasses these adaptations. Only basic text creation (JSON and SSE) and client-supplied history were observed against the real backend; lifecycle, server persistence and optional features remain backend-dependent.";
const sourceBacked = new Set([
  "listModels",
  "createImage",
  "createImageEdit",
  "create-realtime-call",
]);
const codexSource =
  "https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/";
const research = "docs/research/2026-10-16-codex-compatibility-frontier.md";
const desktopResearch = "docs/research/2026-10-16-codex-desktop-static.md";
type Qualification = Pick<
  Operation,
  "implementation" | "evidence" | "prerequisites" | "limitations"
>;
const relayQualification: Qualification = {
  implementation: "relay",
  evidence: {
    kind: "unknown",
    date: null,
    scope: "Public contract and local routing only; backend acceptance is not established.",
    sources: [research],
  },
  prerequisites: ["An eligible Codex account and backend access under the fixed Codex prefix."],
  limitations: ["No public-contract compatibility or account availability is guaranteed."],
};

function qualification(id: string): Qualification {
  if (id === "createSpeech") {
    return {
      ...relayQualification,
      evidence: {
        ...relayQualification.evidence,
        scope:
          "Public Audio REST HTTP speech contract identified in OpenAI Node 7.20.0; no faithful Codex speech client or real synthesis result established by the bounded source research. Realtime voice is a separate contract.",
        sources: [research, desktopResearch, "docs/research/2026-10-17-audio-speech.md"],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "An established speech model, built-in voice and binary/streaming contract under the authorized Codex prefix; none has been live-verified.",
        "Custom voices require an existing authorized voice/consent resource; creating voices or consent is not implicitly authorized by a speech request or probe.",
      ],
      limitations: [
        "Minimal mode returns HTTP 501 speech_contract_unverified before credentials or synthesis; raw remains an unadapted relay for separately authorized investigation, not verified compatibility.",
        "mp3, opus, aac, flac, wav, pcm, speed, instructions and SSE audio events are public options, not established Codex capabilities; unknown options are never silently removed.",
        "No text-only simulation, Realtime substitution, media URL fetch, local engine or paid API fallback is provided.",
        "Desktop voice paths outside the authorized Codex prefix are research leads, not credential destinations or HTTP speech implementations.",
        "Raw binary interruption may yield a truncated body without an explicit terminal error; validate the complete audio file. No duration or decoded-output limit is claimed for raw relay.",
      ],
    };
  }
  if (["createTranscription", "createTranslation"].includes(id)) {
    return {
      ...relayQualification,
      evidence: {
        ...relayQualification.evidence,
        scope:
          "Audio REST speech, transcription and translation are separate public contracts; no equivalent native client established by the bounded CLI/Desktop research.",
        sources: [research, desktopResearch],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "A supported audio model, input format and voice where required; no account access has been tested.",
      ],
      limitations: [
        "Desktop dictation/voice paths outside the authorized Codex prefix are research leads, not credential destinations or Audio REST implementations.",
        "No text-only simulation, local engine or paid API fallback is provided.",
      ],
    };
  }
  if (id.toLowerCase().includes("voice")) {
    return {
      ...relayQualification,
      prerequisites: [
        ...relayQualification.prerequisites,
        "An existing authorized voice/consent resource where required and explicit authorization for creation, modification or deletion; none is provisioned automatically.",
      ],
      limitations: [
        "Voice/consent resource operations are not established by the presence of realtime voice; consent creation is not part of the authorized probes.",
      ],
    };
  }
  if (id === "create-realtime-call" || id === "connectRealtimeWebSocket") {
    return {
      ...relayQualification,
      evidence: {
        kind: "source",
        date: "2026-10-16",
        scope:
          id === "create-realtime-call"
            ? "Codex has a native WebRTC call client; no public SDP negotiation or account result verified."
            : "Codex has standalone and sideband Realtime WebSocket clients with distinct protocol versions; no live public-contract result verified.",
        sources: [
          `${codexSource}endpoint/${id === "create-realtime-call" ? "realtime_call.rs" : "realtime_websocket/methods.rs"}`,
          research,
        ],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "Eligible plan, rollout and workspace settings; matching realtime protocol, audio formats and authorized session/call.",
      ],
      limitations: [
        "Codex WebRTC uses JSON {sdp, session} under /backend-api; the public contract uses multipart. This proxy does not translate these formats.",
        "WebSocket standalone/sideband and WebRTC are not interchangeable; default public API sideband destinations are not used as credential fallbacks.",
      ],
    };
  }
  if (id.includes("realtime") || id.includes("live")) {
    return {
      ...relayQualification,
      prerequisites: [
        ...relayQualification.prerequisites,
        "An existing authorized session/call or required resource; explicit authorization for control, credential creation or external effects, including telephone transfer.",
      ],
      limitations: [
        "Creation-client source proof does not establish this session/control operation. No calls, client secrets or resources are created by capability discovery.",
      ],
    };
  }
  if (["getResponse", "deleteResponse", "listInputItems"].includes(id)) {
    return {
      ...relayQualification,
      implementation: "local",
      evidence: {
        kind: "source",
        date: "2026-10-16",
        scope:
          "Existing minimal-mode local Responses storage, not native Codex persistence or a new live validation.",
        sources: ["src/server/responses-store.ts", "docs/evidence/responses-sprint/RESULTAT.md"],
      },
      prerequisites: [
        "A response created with store:true in minimal mode, under the same account and running process.",
      ],
      limitations: [
        "One-hour in-memory retention; 256 responses, 32 MiB total, 4 MiB per response. Restart/account change loses this state. Raw mode only relays.",
      ],
    };
  }
  if (["listModels", "connectResponsesWebSocket", "Compactconversation"].includes(id)) {
    return {
      ...relayQualification,
      implementation: id === "connectResponsesWebSocket" ? "relay" : "adaptation",
      evidence: {
        kind: "source",
        date: "2026-10-16",
        scope:
          id === "listModels"
            ? "Codex models client; minimal mode adapts the list shape."
            : id === "Compactconversation"
              ? "Existing local adaptation to native Codex compaction, not a new live replay validation."
              : "Codex Responses WebSocket transport; raw frames are relayed without translation.",
        sources: [research, "docs/evidence/responses-sprint/RESULTAT.md"],
      },
      limitations: [
        "Minimal-mode adaptations do not apply in raw mode; native client presence does not establish all public options or account access.",
      ],
    };
  }
  if (id === "createResponse") {
    return {
      implementation: "adaptation",
      evidence: {
        kind: "runtime",
        date: "2026-09-20",
        scope:
          "Historical proxy basic text JSON/SSE and explicit history observations (gpt-6-astra, OpenAI Python 3.16.2 / Node 7.20.0, minimal mode). Not a current live test or proof of every model, parameter or tool.",
        sources: [
          "docs/evidence/responses-implementation/RESULTAT.md",
          "docs/evidence/responses-sprint/RESULTAT.md",
          "docs/evidence/responses-gap-research/local-failures.md",
        ],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "File Search requires an existing authorized vector store; none was configured in the historical probe.",
        "MCP requires an explicitly configured authorized server/tool; none was configured in the historical probe.",
      ],
      limitations: [
        "Historical 2026-09-20 backend refusals: temperature, top_p, max_output_tokens. Fields are not silently removed; this is not a universal model limitation.",
        "Code Interpreter was rejected as an unsupported tool on 2026-09-20; no local substitute or new resource is provided.",
        "store:true uses bounded one-hour in-memory storage in minimal mode, lost on restart/account change; background jobs and Conversations are not implemented.",
        "Only basic creation is marked verified; advanced options and tools require their own result evidence. Raw mode bypasses local adaptations.",
      ],
    };
  }
  if (id === "Getinputtokencounts") {
    return {
      ...relayQualification,
      evidence: {
        kind: "historical-refusal",
        date: "2026-09-20",
        scope:
          "HTTP 403 text/html on the relayed input_tokens route; remote gate unidentified, not a native unsupported-parameter verdict. No corresponding client found in the bounded 0.163.0 source inspection.",
        sources: [
          "docs/evidence/responses-gap-research/local-failures.md",
          research,
          `${codexSource}endpoint/mod.rs`,
        ],
      },
      limitations: [
        "Post-generation usage.input_tokens is not an exact preflight count; no estimate or local tokenizer substitutes for this contract.",
      ],
    };
  }
  if (id === "createImageVariation") {
    return {
      ...relayQualification,
      evidence: {
        ...relayQualification.evidence,
        scope:
          "Public images/variations contract only; generation/edit clients do not establish a native variations client.",
      },
      limitations: [
        "No faithful variations adaptation or backend result is established; generation is not a substitute.",
      ],
    };
  }
  if (id === "createImage" || id === "createImageEdit") {
    return {
      ...relayQualification,
      evidence: {
        kind: "source",
        date: "2026-10-16",
        scope:
          id === "createImage"
            ? "Codex ImagesClient sends JSON to images/generations; no live account validation."
            : "Codex ImagesClient sends JSON image references to images/edits; public multipart equivalence is not established.",
        sources: [
          `${codexSource}endpoint/images.rs`,
          `${codexSource}images.rs`,
          research,
          desktopResearch,
        ],
      },
      limitations: [
        "Public model, mask, size, quality, format, n and streaming options require separate proof; no translation is implemented.",
        "Desktop /wham/images paths are research leads, not authorized credential destinations; no paid API fallback.",
      ],
    };
  }
  return relayQualification;
}
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  createResponse: { input: "Say hello in one sentence.", store: false, stream: true },
  createImage: { model: "gpt-image-1", prompt: "A small blue robot on a white background", n: 1 },
  createSpeech: {
    model: "gpt-4o-mini-tts",
    input: "This is a synthetic speech test.",
    voice: "alloy",
    response_format: "wav",
  },
  updateVoiceConsent: { name: "Updated consent name" },
  "reject-realtime-call": { status_code: 486 },
  "reject-live-session": { status_code: 486 },
} as const;
const categories: Readonly<Record<string, string>> = {
  responses: "Responses",
  models: "Models",
  images: "Images",
  audio: "Audio",
  realtime: "Realtime",
  live: "Live",
} as const;

const categoryOrder = ["responses", "models", "images", "audio", "realtime", "live"] as const;
const methodRank: Readonly<Record<string, number>> = {
  GET: 0,
  POST: 1,
  PUT: 2,
  PATCH: 3,
  DELETE: 4,
};

export const operations: readonly Operation[] = [
  ...publicOperations.map(({ path, method, definition }): Operation => {
    const availability =
      definition.operationId === "createResponse"
        ? "verified"
        : sourceBacked.has(definition.operationId)
          ? "source-backed"
          : "unverified";
    const metadata = qualification(definition.operationId);
    const explanation =
      definition.operationId === "createResponse" ? responsesDescription : metadata.evidence.scope;
    const example = examples[definition.operationId];
    return {
      id: definition.operationId,
      method: method.toUpperCase(),
      path: `/v1${path}`,
      summary: definition.summary,
      description: `${transportDescription}\n\n${explanation}\n\n${publicDescription}`,
      category: categories[path.split("/")[1] ?? ""] ?? "API",
      availability,
      supported: true,
      ...metadata,
      ...(example ? { requestBodyExample: example } : {}),
      queryParameters:
        definition.parameters
          ?.filter((parameter) => parameter.in === "query")
          .map((parameter) => parameter.name) ?? [],
      pathParameters:
        definition.parameters
          ?.filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name) ?? [],
    };
  }),
  {
    id: "connectResponsesWebSocket",
    method: "GET",
    path: "/v1/responses",
    summary: "Connect Responses WebSocket",
    description: `${transportDescription}\n\nA WebSocket client can upgrade this route and exchange Responses protocol frames. The transport is present in Codex source; no current backend validation is claimed here. Historical continuity observations do not verify every protocol option. Scalar's HTTP request panel does not implement a WebSocket conversation.`,
    category: "Responses",
    availability: "source-backed",
    supported: true,
    ...qualification("connectResponsesWebSocket"),
  } satisfies Operation,
  {
    id: "connectRealtimeWebSocket",
    method: "GET",
    path: "/v1/realtime",
    summary: "Connect Realtime WebSocket",
    description: `${transportDescription}\n\nNative standalone and sideband clients are source-backed, not live-verified public Realtime compatibility.`,
    category: "Realtime",
    availability: "source-backed",
    supported: true,
    ...qualification("connectRealtimeWebSocket"),
  } satisfies Operation,
].sort((a, b) => {
  const catA = categoryOrder.indexOf(a.category.toLowerCase() as (typeof categoryOrder)[number]);
  const catB = categoryOrder.indexOf(b.category.toLowerCase() as (typeof categoryOrder)[number]);
  const ca = catA === -1 ? categoryOrder.length : catA;
  const cb = catB === -1 ? categoryOrder.length : catB;
  if (ca !== cb) return ca - cb;
  const ma = methodRank[a.method] ?? 5;
  const mb = methodRank[b.method] ?? 5;
  if (ma !== mb) return ma - mb;
  return a.path.localeCompare(b.path);
});
