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
      (/^\/(responses|models|images|audio|realtime|live)(\/|$)/.test(path) ||
        path === "/chat/completions") &&
      !path.includes("?"),
  )
  .flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => path !== "/chat/completions" || method === "post")
      .map(([method, definition]) => ({ path, method, definition })),
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
  if (id === "createTranscription" || id === "createTranslation") {
    return {
      ...relayQualification,
      evidence: {
        ...relayQualification.evidence,
        kind: id === "createTranscription" ? "historical-refusal" : "unknown",
        date: id === "createTranscription" ? "2026-10-16" : null,
        scope:
          id === "createTranscription"
            ? "Audio REST transcription preserves the original language. One coordinator probe at 2026-10-16T22:31:26.788Z, temporary loopback minimal mode, POST /v1/audio/transcriptions, gpt-4o-transcribe, synthetic 2.289s 16kHz mono PCM WAV, no prompt or phrase hints: HTTP 403 text/html; charset=UTF-8, 97632 bytes, no transcript. One upstream attempt under /backend-api/codex; refusal layer/cause unknown. No faithful REST mechanism established; not a universal absence verdict, TTS evidence or verified compatibility."
            : "Audio REST translation returns English, not an arbitrary target language. No faithful REST mechanism under /backend-api/codex or account result is established independently of transcription.",
        sources: [research, desktopResearch, "docs/research/2026-10-17-audio-rest.md"],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "Establish a faithful REST mechanism under /backend-api/codex, an eligible audio model and accepted file/options before claiming compatibility.",
        id === "createTranscription"
          ? "The coordinator's authorized synthetic transcription budget is exhausted (1/1); no retry, alternate model or additional target is authorized."
          : "No live translation attempt is authorized; transcription results cannot establish translation access.",
      ],
      limitations: [
        "Desktop dictation paths outside the authorized Codex prefix are not credential destinations. Realtime source presence does not establish either Audio REST operation.",
        "Both modes preserve the existing multipart/response relay and upstream errors; no adapter, text-only simulation, local engine or paid API fallback is provided.",
        "The proxy never fabricates timestamps, detected languages or speaker labels. Model-specific formats, streaming, diarization and backend limits remain unverified.",
        "The configured maxBodyBytes limits the whole multipart request, including overhead (default 16 MiB); no decoding, duration detection, splitting or remote media fetching is performed.",
        "Explorer: select Multipart with file, keep the example as form fields and attach the audio as file. Example models describe the public contract, not established Codex access.",
      ],
    };
  }
  if (id === "createSpeech") {
    return {
      ...relayQualification,
      evidence: {
        kind: "historical-refusal",
        date: "2026-10-16",
        scope:
          "Audio REST speech: one coordinator probe at 2026-10-16T22:25:55.432Z, temporary loopback raw mode, POST /v1/audio/speech, gpt-4o-mini-tts-2025-12-15, alloy, wav: HTTP 403 text/html; charset=UTF-8, 10611 bytes, no WAV. One upstream request under the Codex prefix; refusal layer/cause unknown, not a universal TTS limitation or successful synthesis.",
        sources: [research, desktopResearch, "docs/research/2026-10-17-audio-speech.md"],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "An established speech model, built-in voice and binary/streaming contract under the authorized Codex prefix; none has been live-verified.",
        "Custom voices require an existing authorized voice/consent resource; creating voices or consent is not implicitly authorized by a speech request or probe.",
      ],
      limitations: [
        "Minimal mode returns HTTP 501 speech_contract_unverified before credentials or synthesis; raw remains an unadapted relay for separately authorized investigation, not verified compatibility.",
        "The authorized synthesis probe budget is exhausted (1/1); no retry or additional probe is authorized. Backend availability and faithful speech synthesis remain unvalidated.",
        "mp3, opus, aac, flac, wav, pcm, speed, instructions and SSE audio events are public options, not established Codex capabilities; unknown options are never silently removed.",
        "No text-only simulation, Realtime substitution, media URL fetch, local engine or paid API fallback is provided.",
        "Desktop voice paths outside the authorized Codex prefix are research leads, not credential destinations or HTTP speech implementations.",
        "Raw binary interruption may yield a truncated body without an explicit terminal error; validate the complete audio file. No duration or decoded-output limit is claimed for raw relay.",
      ],
    };
  }
  if (id === "createChatCompletion") {
    return {
      ...relayQualification,
      implementation: "adaptation",
      evidence: {
        kind: "source",
        date: "2026-10-17",
        scope:
          "Local SDK contract tests against the integrated Responses gateway and a controlled WebSocket upstream. No live Chat/backend validation.",
        sources: [
          "src/server/chat-adapter.ts",
          "src/server/chat-stream.ts",
          "tests/chat-json.test.ts",
          "tests/chat-stream.test.ts",
        ],
      },
      limitations: [
        "Minimal mode implements JSON and progressive SSE (stream:true), text/refusal, function tools and structured tool results, model, store:false and n:1. Omitted store is false.",
        "Function tools support name/description/parameters/strict, tool_choice and parallel_tool_calls. Tool results are strings linked by tool_call_id; the proxy never executes tools. Multimodal content, named messages, store:true, stored Chat CRUD, query parameters and unknown options are explicitly refused.",
        "Completed text/refusal maps to finish_reason:stop; function calls map to tool_calls. Failed/incomplete Responses remain errors, including after partial SSE output, never success finishes. Unknown stream events and unsupported structured or annotated output are refused. Reasoning is not final text.",
        "Usage is mapped only when received; no counts are estimated. SSE usage is opt-in via stream_options.include_usage, with a final empty choices chunk. Buffers and deadlines remain bounded; cancellation closes upstream. Raw mode remains an unadapted relay.",
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
  if (id === "create-realtime-call") {
    return {
      ...relayQualification,
      implementation: "adaptation",
      evidence: {
        kind: "source",
        date: "2026-10-17",
        scope:
          "Minimal-mode WebRTC envelope adaptation tested locally through the SDK and integrated HTTP gateway: multipart SDP/session to Codex JSON, SDP-only without session, bounded bodies and local Location identity. No real peer negotiation, audio or account result verified.",
        sources: [
          `${codexSource}endpoint/realtime_call.rs`,
          "https://github.com/openai/openai-node/blob/v7.20.0/src/resources/realtime/calls.ts",
          "tests/realtime-calls.test.ts",
          research,
        ],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "An authorized WebRTC peer, eligible rollout and a session/protocol accepted by Codex. Public session type realtime is not proven equivalent to Codex quicksilver or frameless sessions.",
      ],
      limitations: [
        "Only the request envelope is adapted; session options and explicit queries are preserved, never silently mapped to another protocol. No intent/architecture, model, native id or token is invented. session.id and unknown/duplicate envelope parts are rejected.",
        "Raw mode remains byte relay. Successful minimal Location is reduced to /v1/realtime/calls/{call_id}; query and upstream destination are removed. No SDP is logged or stored by this adapter.",
        "The source rejects RealtimeV2 in its AVAS call client; V1/frameless session formats differ. WebSocket is not a prerequisite or proof of WebRTC compatibility. Control/telephony operations are separate, unverified relays requiring explicit authorization.",
      ],
    };
  }
  if (id === "connectRealtimeWebSocket") {
    return {
      ...relayQualification,
      evidence: {
        kind: "source",
        date: "2026-10-16",
        scope:
          "Codex has standalone and sideband Realtime WebSocket clients with distinct protocol versions; no live public-contract result verified.",
        sources: [`${codexSource}endpoint/realtime_websocket/methods.rs`, research],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "Eligible plan, rollout and workspace settings; matching realtime protocol, audio formats and authorized session/call.",
      ],
      limitations: [
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
        kind: "runtime",
        date: "2026-10-17",
        scope:
          "Minimal-mode SQLite Responses persistence, verified with local SDK/runtime fixtures across restart; not native Codex persistence or a live backend validation.",
        sources: ["src/server/responses-store.ts", "tests/responses-durable.test.ts"],
      },
      prerequisites: [
        "A response created with store:true in minimal mode, under the same account and server storage configuration.",
      ],
      limitations: [
        "Thirty-day local retention across restart; 1 GiB global application budget across accounts/kinds, 4 MiB per retained object including inputs. Capacity errors are explicit, without arbitrary eviction. Raw mode only relays. Durable data does not restore a native continuation.",
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
        "store:true opts into thirty-day private SQLite persistence in minimal mode; omitted store remains false. Quota reservations may reject a write before generation (507). Background jobs, Conversations and durable-context replay are not implemented.",
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
        kind: id === "createImage" ? "runtime" : "source",
        date: "2026-10-16",
        scope:
          id === "createImage"
            ? "Native JSON images/generations uses prompt, model, background, n, quality, size. Coordinator observation 2026-10-16T22:27:36.855Z, minimal, gpt-image-2, n=1, quality=low, background=opaque: HTTP 200 JSON with one decodable opaque PNG, blue circle on white without text. Requested 1024x1024 but decoded 1374x1145: dimension fidelity failed, not verified compatible."
            : "Codex ImagesClient sends JSON image references to images/edits; public multipart equivalence is not established.",
        sources: [
          `${codexSource}endpoint/images.rs`,
          `${codexSource}images.rs`,
          research,
          desktopResearch,
          ...(id === "createImage"
            ? [
                "docs/evidence/images-generation.md",
                "https://developers.openai.com/codex/image-generation.md",
              ]
            : []),
        ],
      },
      limitations: [
        ...(id === "createImage"
          ? [
              "Native source: prompt/model are strings; background=transparent|opaque|auto, quality=low|medium|high|auto, n is an unsigned integer and size is a string. One gpt-image-2 generation was observed for the coordinator account; other models/counts/dimensions/options and general account entitlement remain unverified. No defaults are injected.",
              "Observed size mismatch: requested size=1024x1024, actual PNG=1374x1145 (1027860 bytes, opaque RGB). Declared/requested size is not proof of decoded dimensions; no resize/crop or metadata correction is applied. Availability remains source-backed, not verified compatible. Image probe budget 1/1 exhausted; no retry authorized.",
              "Public output_format (png/jpeg/webp), output_compression, response_format, moderation, style, user, stream, partial_images and quality=standard|hd|xhigh|max are not established by this native client. Unknown fields and explicit nulls are relayed unchanged, never silently dropped; backend errors are preserved. No URL fetch, format conversion or fabricated image is provided.",
              "Local SDK fixtures verify JSON/base64 and binary transport, errors, request size limits and interruption. The separate live observation establishes only the documented gpt-image-2 request, not other options/models, edits or variations. Raw remains unchanged. See docs/evidence/images-generation.md.",
            ]
          : [
              "Public model, mask, size, quality, format, n and streaming options require separate proof; no translation is implemented.",
            ]),
        "Desktop /wham/images paths are research leads, not authorized credential destinations; no paid API fallback.",
      ],
    };
  }
  return relayQualification;
}
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  createChatCompletion: {
    messages: [{ role: "user", content: "Say hello in one sentence." }],
    store: false,
    stream: true,
    stream_options: { include_usage: true },
  },
  createResponse: { input: "Say hello in one sentence.", store: false, stream: true },
  createImage: {
    model: "gpt-image-2",
    prompt: "A single solid blue circle centered on a plain white background. No text.",
    n: 1,
    quality: "low",
    size: "1024x1024",
    background: "opaque",
  },
  createSpeech: {
    model: "gpt-4o-mini-tts",
    input: "This is a synthetic speech test.",
    voice: "alloy",
    response_format: "wav",
  },
  createTranscription: { model: "gpt-4o-transcribe", response_format: "json" },
  createTranslation: { model: "whisper-1", response_format: "json" },
  updateVoiceConsent: { name: "Updated consent name" },
  "reject-realtime-call": { status_code: 486 },
  "reject-live-session": { status_code: 486 },
  "create-realtime-call": {
    sdp: "v=0\r\ns=REPLACE_WITH_LOCAL_PEER_OFFER\r\n",
    session: { type: "realtime", model: "gpt-realtime", instructions: "Say hello briefly." },
  },
} as const;
const categories: Readonly<Record<string, string>> = {
  chat: "Chat",
  responses: "Responses",
  models: "Models",
  images: "Images",
  audio: "Audio",
  realtime: "Realtime",
  live: "Live",
} as const;

const categoryOrder = [
  "responses",
  "chat",
  "models",
  "images",
  "audio",
  "realtime",
  "live",
] as const;
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
