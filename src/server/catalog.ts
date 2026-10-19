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
      (/^\/(responses|conversations|models|images|audio|realtime|live)(\/|$)/.test(path) ||
        /^\/chat\/completions(\/|$)/.test(path)) &&
      !path.includes("?"),
  )
  .flatMap(([path, item]) =>
    Object.entries(item).map(([method, definition]) => ({ path, method, definition })),
  );

export const transportDescription =
  "This server relays /v1/* to the fixed ChatGPT Codex backend. Raw mode forwards request and response bytes, including multipart, binary and SSE, without schema filtering. Unknown fields are preserved. supported=true means the local proxy can relay the route; it does not guarantee that the account or Codex backend supports the public API operation.";
const publicDescription =
  "The schema is the public OpenAI contract, not proof of Codex backend availability. Upstream status codes and errors are returned to the caller.";
const responsesDescription =
  "In minimal mode, POST /v1/responses converts string input to a user message, supplies a missing model and instructions, sets store=false upstream and requests native streaming. Synchronous callers receive terminal JSON or SSE as requested. background:true returns a local queued Response immediately (JSON or a response.created SSE event); GET polls it and POST /responses/{id}/cancel cancels idempotently. Client disconnect does not cancel background work. Only a background stream:true creation enables GET /responses/{id}?stream=true&starting_after=N: exact retained events after N, without regeneration. Background events use the local Response ID and canonical increasing sequence_number starting at zero; upstream sequence numbers are replaced only for background. The private bounded journal expires ten minutes after terminal, independently of thirty-day store:true JSON. For synchronous stream:true, the proxy restores terminal response.output only when the upstream terminal event omits or empties it. Other fields, including tools, reasoning, metadata and future extensions, are retained. Raw mode bypasses these adaptations. Only basic synchronous text creation and client-supplied history have historical live evidence; background is verified with local SDK/runtime fixtures only.";
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
  if (
    [
      "createConversation",
      "getConversation",
      "updateConversation",
      "deleteConversation",
      "createConversationItems",
      "listConversationItems",
      "getConversationItem",
      "deleteConversationItem",
    ].includes(id)
  ) {
    return {
      implementation: "local",
      evidence: {
        kind: "runtime",
        date: "2026-10-17",
        scope:
          "Local SDK/runtime fixtures verify durable Conversations, metadata, pagination, account isolation, atomic writes and restart. Not native Codex persistence or live backend validation.",
        sources: ["src/server/conversations.ts", "tests/conversations.test.ts"],
      },
      prerequisites: [
        "Minimal mode, the same account and the same private proxy store; raw only relays.",
      ],
      limitations: [
        "Twenty items maximum per create/add; desc pagination by default, order:asc for chronological retrieval. Metadata: 16 string pairs, keys 64 characters and values 512. Updates replace metadata; null clears it.",
        "Validated local input subset: messages (text, image/file references, unannotated output text/refusal), function calls/results, reasoning, compaction and inert program/program_output history (including opaque fingerprints/results). Other public union variants, annotations, logprobs and unknown fields are explicitly refused, never stored unchecked. Media URLs are not fetched; storing history executes no program or tool and does not establish replay support.",
        "DELETE Conversation removes only the parent. Its orphan items and associations remain retained and counted in the shared quota, but their parent-scoped routes return 404. Delete items first to remove that content; item DELETE returns the Conversation. No Response, file or other copy is purged.",
        "No thirty-day TTL. Shared 1 GiB account/kind budget, 4 MiB per object and bounded row/physical storage. Concurrent mutations use synchronous SQLite transactions on the sole owner's shared handle: complete batch or rollback. ID collisions within the account are rejected (400). A second storage owner is refused with 409 before recovery. Generations using a Conversation are not implemented in this slice.",
      ],
    };
  }
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
  if (
    [
      "listChatCompletions",
      "getChatCompletion",
      "updateChatCompletion",
      "deleteChatCompletion",
      "getChatCompletionMessages",
    ].includes(id)
  ) {
    return {
      ...relayQualification,
      implementation: "local",
      evidence: {
        kind: "source",
        date: "2026-10-17",
        scope:
          "Local OpenAI SDK 7.20 CRUD, pagination and restart tests through the integrated gateway; no live backend validation.",
        sources: ["src/server/chat-storage.ts", "tests/chat-storage.test.ts"],
      },
      limitations: [
        "Minimal only: explicit store:true creations (JSON or SSE), isolated by pinned Codex account, retained for 30 days. Missing/expired/other-account IDs return 404. Raw remains an unadapted relay.",
        "The same DurableStore and global 1 GiB application budget serve Chat and Responses; no second Response history is retained. Object limits and reservation failures are explicit; no live object eviction or automatic regeneration.",
        "List and messages: after, limit 1..100 (default 20), order asc/desc (default asc); completions sort by created timestamp with ID tie-break. List also accepts model and metadata[key]=value equality filters (combined with AND). Unknown, duplicate or invalid query fields/cursors are refused.",
        "Only metadata can be updated: up to 16 string pairs (keys <=64, values <=512), or explicit null. Updates preserve original expiry. Deletion removes this stored Chat and its messages, not any separately stored Response. Original messages and structured function-call associations are retained; reasoning/phase-bearing native output remains internal, not fabricated Chat text.",
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
          "Local SDK contract tests against the integrated Responses gateway and a controlled WebSocket upstream. A coordinator Chat SSE probe failed; a separate native Responses event pattern reproduced response.metadata rejection locally, now fixed. Original live Chat was not retried; backend compatibility remains unverified.",
        sources: [
          "src/server/chat-adapter.ts",
          "src/server/chat-stream.ts",
          "tests/chat-json.test.ts",
          "tests/chat-stream.test.ts",
          "docs/evidence/chat-stream-metadata.md",
          "tests/chat-storage.test.ts",
        ],
      },
      limitations: [
        "Minimal mode implements JSON and progressive SSE (stream:true), text/refusal, function tools and structured tool results, model, boolean store and n:1. Omitted store is false; null store is refused. Explicit store:true retains Chat for 30 days in the shared durable budget; SSE success is emitted only after commit.",
        "Function tools support name/description/parameters/strict, tool_choice and parallel_tool_calls. Tool results are strings linked by tool_call_id; the proxy never executes tools. Metadata accepts up to 16 string pairs or null. Multimodal content, named messages, creation query parameters and unknown options are explicitly refused.",
        "Completed text/refusal maps to finish_reason:stop; function calls map to tool_calls. Failed/incomplete Responses remain errors, including after partial SSE output, never success finishes. Unknown stream events and unsupported structured or annotated output are refused. Reasoning is not final text.",
        "Usage is mapped only when received; no counts are estimated. SSE usage is opt-in via stream_options.include_usage, with a final empty choices chunk. Buffers and deadlines remain bounded; cancellation closes upstream. Raw mode remains an unadapted relay.",
        "Identified native response.metadata (model/verifications/moderation, not generated content) has no Chat chunk projection and is omitted only by the Chat adapter. Responses and raw retain it; unknown event types, unsupported output and native failures are not suppressed.",
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
          "Realtime WebSocket source distinguishes V1, RealtimeV2 and Frameless Bidi. Local SDK/wire tests establish transport only, not ChatGPT authentication or a backend audio result.",
        sources: [
          `${codexSource}endpoint/realtime_websocket/methods_v2.rs`,
          `${codexSource}endpoint/realtime_websocket/protocol_v2.rs`,
          "https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/realtime_conversation.rs",
          "docs/research/2026-10-17-realtime-ws-contract.md",
        ],
      },
      prerequisites: [
        ...relayQualification.prerequisites,
        "Pinned Codex standalone WS startup requires API key auth, including a temporary API-key fallback for ChatGPT sessions. This proxy never uses that fallback.",
        "A ChatGPT bearer authentication mechanism under /backend-api/codex/realtime is not established; backend access and a matching model/protocol remain prerequisites, not a universal impossibility claim.",
      ],
      limitations: [
        "RealtimeV2 shares public session.update, input_audio_buffer.append (base64 PCM16 mono 24 kHz), conversation.item.create and response output audio events; unchanged frames are a relay, not an adapter or proof of every public option.",
        "V1 uses intent=quicksilver, session.type=quicksilver, native handoffs and conversation.output_audio.delta. Minimal mode refuses this known incompatible intent with realtime_protocol_not_adapted (501); raw retains the native relay.",
        "Frameless Bidi uses /live, input_audio.append, session.context.append and session.close. No public Realtime translation is established; its native relay is separate.",
        "thread/realtime RPC is an app-server lifecycle, not public WebSocket frames. Sideband requires an existing authorized call; no WebRTC call, SDP or default api.openai.com destination is created here.",
        "OpenAI Node SDK openai/realtime/ws uses bearer auth and WSS (TLS termination required). Browser SDK subprotocol authentication is not accepted; the same-origin Explorer uses oai-codex-token instead. HTTP/ws loopback alone is not a runnable SDK WSS endpoint.",
        "Errors, unknown events/options and cancellation frames remain unchanged; cancellation acknowledgement, truncation semantics, audio quality and backend availability are unverified. One shared WS/WebRTC live session, ten seconds maximum, is reserved only by the coordinator.",
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
  if (id === "cancelResponse") {
    return {
      ...relayQualification,
      implementation: "local",
      evidence: {
        kind: "runtime",
        date: "2026-10-17",
        scope:
          "Local background cancellation and completion races verified through SDK/runtime fixtures; not a native scheduler or live backend validation.",
        sources: ["src/server/responses-background.ts", "tests/responses-background.test.ts"],
      },
      prerequisites: ["A minimal-mode background Response owned by the current Codex account."],
      limitations: [
        "Cancellation is idempotent and never rewrites an acquired terminal. It closes the native turn locally, without retry or a guarantee of undoing external tool effects. Client disconnect is not cancel. Raw only relays.",
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
        sources: [
          "src/server/responses-store.ts",
          "tests/responses-durable.test.ts",
          "tests/responses-background.test.ts",
          "tests/responses-background-stream.test.ts",
        ],
      },
      prerequisites: [
        "A response created with store:true or background:true in minimal mode, under the same account and server storage configuration.",
      ],
      limitations: [
        "Thirty-day local retention across restart; 1 GiB global application budget across accounts/kinds, 4 MiB per retained object including inputs. Capacity errors are explicit, without arbitrary eviction. Raw mode only relays. Durable data does not restore a native continuation.",
        "Background store:false/omitted retains data during bounded execution and ten minutes after terminal; store:true retains the Response thirty days. Only background stream:true creation enables replay; the journal expires ten minutes after terminal (410 background_journal_unavailable) independently of JSON. All queued/running jobs fail on restart without re-emission; replay retains only committed events then reports background_interrupted. Delete an active job only after cancel.",
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
        "store:true opts into thirty-day account-isolated SQLite persistence in minimal mode; omitted store remains false. Quota reservations may reject a write before generation (507). Background jobs and Conversations are separate adaptations.",
        "After socket loss/restart, complete stored context can be projected into a new explicit request without a native previous_response_id, duplicate history or inherited instructions. Local SDK/runtime replay tests only; real encrypted replay and cross-model/version portability remain unverified.",
        "Without a live socket, missing/expired/deleted/foreign IDs fail with 404 previous_response_not_found; incomplete or unprojectable context fails with 409 response_context_incomplete/response_context_not_replayable before generation. No automatic retry or local tool execution.",
        "Responses integration with Conversations is not implemented. Stored-context restoration applies to synchronous Responses; background local IDs retain their separate qualified lifecycle contract.",
        "background:true is a local JSON/SSE/poll/cancel job, tested only against local upstreams: at most 16 pending jobs and 64 subscribers, each request bounded by timeoutMs. Credentials are pinned and the account is revalidated before native emission. All unfinished jobs fail after restart; no retry. Temporary JSON and the SSE journal expire ten minutes after terminal; store:true JSON lasts thirty days. The journal reserves a separate 4 MiB object under the same 1 GiB budget before generation. A full journal fails the job explicitly; a slow subscriber is disconnected with slow_consumer without cancelling the job. Only stream:true creation enables exact replay after starting_after with local ID and canonical sequences from zero. Local IDs do not provide native continuation or durable-context replay.",
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
        "Minimal mode returns 501 image_variation_contract_unverified before credentials or upstream effects. Raw is unchanged; no variation probe is authorized.",
      ],
    };
  }
  if (id === "createImage" || id === "createImageEdit") {
    return {
      ...relayQualification,
      implementation: id === "createImageEdit" ? "adaptation" : "relay",
      evidence: {
        kind: id === "createImage" ? "runtime" : "source",
        date: "2026-10-16",
        scope:
          id === "createImage"
            ? "Native JSON images/generations uses prompt, model, background, n, quality, size. Coordinator observation 2026-10-16T22:27:36.855Z, minimal, gpt-image-2, n=1, quality=low, background=opaque: HTTP 200 JSON with one decodable opaque PNG, blue circle on white without text. Requested 1024x1024 but decoded 1374x1145: dimension fidelity failed, not verified compatible."
            : "Codex ImagesClient sends JSON images[] with image_url (inline base64 data URL) or file_id references. Minimal mode adapts public multipart image/image[] PNG/JPEG/WebP uploads into ordered inline references, preserving bytes. Native JSON references are validated; edits are not live-verified and do not inherit generation evidence.",
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
            : [
                "https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/protocol/src/models.rs",
                "https://github.com/openai/openai-node/blob/v7.20.0/src/resources/images.ts",
                "docs/evidence/images-edits.md",
              ]),
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
              "Minimal accepts explicit prompt/model, ordered image/image[] multipart uploads or native JSON images[] with inline data URLs or existing authorized file_id. No default model, file upload/resolution, URL fetch, filesystem read or credential destination is introduced. file_id ownership/access is an upstream prerequisite, not locally verified.",
              "mask, input_fidelity, response_format, output_format/output_compression, stream/partial_images, user, unknown options, nulls, duplicate scalar fields and query parameters are explicitly refused with 400 unsupported_image_edit_contract, never dropped. Public JSON image is not native images[].",
              "n (unsigned safe integer), size (string), background and quality have source-backed serialization only, not verified count/dimension/output fidelity. PNG/JPEG/WebP signatures and canonical base64 are checked within request/encoded-body limits; no pixel decoding, resizing, transcoding or output validation is performed. Malformed image pixels can still be refused upstream.",
              "Upload, multipart parsing, credentials and upstream response share the relay deadline/cancellation. Local HTTP/SDK fixtures are not backend availability or editing-result evidence. Raw retains unknown fields and original bytes; no edit or variation live probe is authorized.",
            ]),
        "Desktop /wham/images paths are research leads, not authorized credential destinations; no paid API fallback.",
      ],
    };
  }
  return relayQualification;
}
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  createConversation: {
    metadata: { purpose: "example" },
    items: [{ role: "user", content: "Hello" }],
  },
  updateConversation: { metadata: { purpose: "updated" } },
  createConversationItems: { items: [{ role: "user", content: "Next message" }] },
  createImageEdit: {
    images: [{ file_id: "file-existing-authorized-image" }],
    model: "unverified-image-model",
    prompt: "Keep the image unchanged.",
  },
  createChatCompletion: {
    messages: [{ role: "user", content: "Say hello in one sentence." }],
    store: false,
    stream: true,
    stream_options: { include_usage: true },
  },
  updateChatCompletion: { metadata: { project: "example" } },
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
  conversations: "Conversations",
  models: "Models",
  images: "Images",
  audio: "Audio",
  realtime: "Realtime",
  live: "Live",
} as const;

const categoryOrder = [
  "responses",
  "conversations",
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
    description: `${transportDescription}\n\nPublic Realtime and Codex V1/RealtimeV2/Frameless Bidi/thread RPC are distinct contracts. No ChatGPT-authenticated backend audio exchange is verified. Minimal rejects the known V1 quicksilver intent; raw remains an unadapted native relay. See prerequisites before connecting.`,
    category: "Realtime",
    availability: "source-backed",
    supported: true,
    ...qualification("connectRealtimeWebSocket"),
    queryParameters: ["model", "intent", "call_id"],
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
