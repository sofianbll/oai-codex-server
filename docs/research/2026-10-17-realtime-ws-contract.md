# Realtime WebSocket: contract and authentication boundary

Issue #25. Source identity: Codex `83086188ae0614bd882818ff1aa23f3194962012`
(stable 0.163.0). This is targeted source analysis plus **local** wire/SDK tests,
not a backend audio success. It reuses the [frontier](2026-10-16-codex-compatibility-frontier.md)
and [Desktop evidence](2026-10-16-codex-desktop-static.md); no new REA inventory.

## Consumer matrix

| Consumer | Established wire behavior | Proxy behavior / missing prerequisite |
| --- | --- | --- |
| Public Realtime / native RealtimeV2, standalone | `session.update` with `type:realtime` or `transcription`; `audio.input.format:{type:"audio/pcm",rate:24000}`; base64 `input_audio_buffer.append`; `conversation.item.create`; `response.create`; output `response.output_audio.delta`, transcripts and `response.done` | Unmodified relay on `/v1/realtime`. V2 source shares these public shapes; this does not establish all events/options, account access, interruption semantics or audio quality. No model, tools, VAD, transcription or voice is silently injected. |
| Native V1 | `intent=quicksilver`; `session.type=quicksilver`; alpha `quicksilver=v1`; `conversation.handoff.append`; `conversation.output_audio.delta` | Not the public protocol. Minimal refuses the explicit quicksilver intent with HTTP 501 `realtime_protocol_not_adapted` before credentials/upstream. Raw remains a native relay, not a turnkey native client: it does not generate the native alpha header/session or convert events. |
| Native Frameless Bidi (v3) | `/live`; alpha `quicksilver=v2`; `input_audio.append`, `session.context.append`, `delegation.context.append`, `session.started`, `session.close` before socket close | Separate native route relay, no conversion to/from public Realtime. No invented interruption mapping. |
| `thread/realtime/*` RPC | app-server start/appendAudio/appendText/stop, thread lifecycle and notifications | Not a frame protocol for `/v1/realtime`. No app-server launch, delegation or thread side effect added. |
| Sideband | Existing call; V1/V2 `call_id` query, Frameless call path; existing-call attachment avoids overwriting its session | No call creation or attachment performed by discovery. The official client's default `api.openai.com/v1` sideband destination is **not** an allowed credential fallback here. No WebRTC dependency for standalone WS. |
| Node SDK `openai/realtime/ws` 7.20.0 | WSS and local bearer credential | Local TLS gateway fixture verifies SDK event/error parsing and frame preservation. Deployed plaintext HTTP/ws alone cannot serve this SDK: WSS termination is a separate prerequisite, not added in this ticket. |
| Native browser SDK `openai/realtime/websocket` | WSS, `realtime` + `openai-insecure-api-key.*` subprotocols | That auth variant is not accepted. Same-origin Explorer/manual browser WS uses `oai-codex` + `oai-codex-token.<local-token>`; neither secret subprotocol is forwarded upstream. Cross-origin requests remain rejected. |

### The useful authentication gap

In [`core/src/realtime_conversation.rs`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/realtime_conversation.rs),
`prepare_realtime_start` selects an API-key provider for standalone WS and calls
`realtime_api_key`. That function checks provider API key, experimental bearer,
API-key auth, then the temporary `OPENAI_API_KEY` fallback for ChatGPT/SIWC;
otherwise it returns **`realtime conversation requires API key auth`**.
`realtime_request_headers` adds V1/v3 alpha headers, optional `x-session-id`,
bearer API key and originator. V2 adds no alpha header. Source defaults are
`gpt-realtime-1.5` for V1/V2 and `gpt-live-1-codex` for Frameless Bidi.

This source does **not** establish a ChatGPT-session standalone WS mechanism at
`/backend-api/codex/realtime`. The proxy keeps its existing destination and replaces
local auth with server-side ChatGPT bearer/account headers; it now preserves an
explicit `x-session-id` on Realtime only. It never reads an API key environment
fallback, changes provider, follows a new credential destination or fabricates
attestation. This gap is qualified in `/api/capabilities`, Explorer and OpenAPI;
it is not a universal refusal of V2, future deployments or raw consumers.

### Local evidence and limits

`tests/realtime-websocket.test.ts` exercises the integrated WebSocket gateway used
by the runtime, with real loopback peers, shared access/origin checks and SDK
7.20.0. Synthetic 100 ms PCM16 input and known output bytes are wire fixtures:
no microphone, playback, model or remote authentication. Tests cover local-token
replacement, account spoofing, secret subprotocol stripping, fixed prefix/query,
`x-session-id`, V1 minimal refusal/raw preservation, cancellation frames, SDK
error payloads, upstream close code, client interruption and audio buffer bounds.
Generic transport tests additionally cover binary preservation, pending-handshake
order/deadline and shutdown. The SDK fixture uses a public test-only self-signed
key and disables certificate checking **only for that loopback socket**; production
TLS verification and configuration are unchanged.

Buffers reuse `maxBodyBytes` (encoded JSON/base64 bytes, not decoded audio samples),
1024 queued frames and 64 connections. On overflow both peers close with 1009;
handshake failure/timeout uses 1011. No retry/reconnect. The runtime receives a
frame before applying the application bound; it is not a preallocation guarantee.
Upstream HTTP handshake status/body is not exposed by the existing WS relay:
1011 is a transport failure, never proof of a specific entitlement refusal.

## Coordinator-only probe: exact candidate, not executed

**Do not reserve WS merely because these local tests pass.** The standalone
ChatGPT authentication mechanism above remains missing; WebRTC #26 is independent.
The coordinator alone chooses whether to spend the **single shared session, at
most ten seconds**, on this bounded candidate or on WebRTC. A refusal consumes
the reservation; no second connection, transport fallback or retry follows.

If WS is selected despite the qualified auth gap:

1. Temporary loopback QA instance, **minimal** mode; native WS client with local
   `Authorization: Bearer <proxy-token>`. Request exactly
   `/v1/realtime?model=gpt-realtime-1.5` (V2 candidate, no quicksilver intent or
   alpha header). That model is a pinned-source default, **not** an account-verified
   model. Upstream remains `wss://chatgpt.com/backend-api/codex/realtime?model=gpt-realtime-1.5`
   with the existing server-side bearer/account replacement. No paid key.
2. Start a hard **10,000 ms deadline before opening**; on any error close once and
   record the sanitized refusal. No automatic reconnect. Do not attempt a native
   V1/v3 variant after rejection.
3. After open send exactly:

   ```json
   {"type":"session.update","session":{"type":"realtime","instructions":"Say only Bonjour, then stop.","output_modalities":["audio"],"audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"turn_detection":null},"output":{"format":{"type":"audio/pcm","rate":24000},"voice":"marin"}},"tools":[]}}
   ```

   Wait for `session.updated` confirming PCM/voice (or preserve the error); never
   silently delete refused options. Then send one `input_audio_buffer.append`
   whose `audio` is precisely `Buffer.alloc(9600).toString("base64")`: **200 ms
   synthetic silence, mono PCM16LE 24 kHz**, no file URL or microphone. Send
   `input_audio_buffer.commit`, then `response.create` with
   `response:{output_modalities:["audio"],instructions:"Say only Bonjour, then stop."}`.
4. Expected business observations: input buffer committed to a conversation item;
   ordered, valid base64 `response.output_audio.delta` bytes decode to nonempty,
   even-length, non-silent PCM16 at the negotiated rate; audio transcript normalizes
   to `bonjour`; terminal `response.done` has `status:completed`. HTTP upgrade, an
   echo, silence, text alone, tool handoff or a `session.updated` is **not success**.
   Transcript plus PCM is bounded evidence, not an independent audio-quality audit.
5. If still generating before the deadline, send `response.cancel` for its actual
   response id and record the actual terminal/error without fabricating a cancelled
   result. Close with 1000 on success or interruption; force termination at the
   deadline. If generation already completed, do not create another turn merely to
   test cancellation. Record interruption as unverified in that case.

No backend call, reservation, real credential read, SDP, call, consent or telephone
effect was performed for this ticket. Backend audio/auth acceptance criteria remain
unverified until the coordinator reports an authorized observation.

## Primary source anchors

- [Wire selection and initialization](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs)
- [V1 session/intent](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v1.rs)
- [V2 session/audio](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v2.rs)
- [V2 events](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_v2.rs)
- [Frameless initialization/context](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs)
- [RPC types, not WS events](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs)
- [Public SDK 7.20.0](https://github.com/openai/openai-node/tree/v7.20.0/src/realtime)
