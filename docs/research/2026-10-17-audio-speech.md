# Audio HTTP speech — bounded qualification

Date: 2026-10-17. Issue: [#24](https://github.com/sofianbll/oai-codex-server/issues/24).
No backend request, credentials, quota reservation, microphone, playback or resource creation was used.

## Established public contract, unestablished Codex mapping

The [official Node SDK 7.20.0 speech client](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/audio/speech.ts)
sends JSON `POST /audio/speech`, sets `Accept: application/octet-stream`, and returns a binary `Response` (or audio events when requested).
Required fields are `input` (public maximum 4096 characters), `model` and `voice`.
Public options include `response_format` (`mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`),
`speed` (0.25–4), `instructions` (not for tts-1/tts-1-hd), and `stream_format` (`audio` or `sse`, SSE not for tts-1/tts-1-hd).
A custom voice object references an existing `id`; it does not authorize creation or consent operations.
These are public contract facts, not proof of Codex models, voices or formats.

Reused the [bounded CLI research](2026-10-16-codex-compatibility-frontier.md) and
[Desktop static traces and their integrity/coverage limits](2026-10-16-codex-desktop-static.md#5-voix-webrtc-et-realtime-de-threads).
The precise follow-up re-read the official
[`codex-api` endpoint exports at 83086188 / stable 0.163.0](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/mod.rs):
Responses, images and realtime clients are exported; no HTTP speech client is established there.
The [current product voice guide](https://developers.openai.com/codex/features/voice.md), read on this date,
describes live conversation/dictation and plan/rollout/workspace prerequisites, not a binary HTTP TTS contract.
No new full artifact audit was performed. Missing literals/exports do not prove universal backend impossibility.

## Implemented boundary

- Minimal `POST /v1/audio/speech`: bounded upload using existing `maxBodyBytes` and deadline, then HTTP **501 `speech_contract_unverified`**, before credentials or upstream effects. No accepted speech schema or synthesis is claimed, so format/voice values are not silently coerced or discarded. Authentication/origin/concurrency checks remain unchanged.
- Raw: unchanged fixed-prefix relay, including unknown options, binary bytes, useful content-type/content-disposition/request-id headers and upstream errors. No URL fetching, voice/consent provisioning, text simulation, realtime conversion, engine or paid API fallback.
- Existing streaming relay uses deadline/cancellation and bounded per-chunk delivery, not a cumulative audio-output/decoded-duration limit. A raw non-SSE interruption can close a partial body with its initial HTTP 200 unchanged: clients must validate complete media; it is **not** a verified speech result.
- Local SDK/HTTP tests exercise the runtime's integrated gateway and app with controlled loopback upstreams. A tiny valid two-sample WAV verifies transport only; it is not synthetic speech evidence. Capability and OpenAPI qualifications are consumed by the existing Explorer/Scalar without a new UI.

## Exactly one proposed synthesis probe — coordinator only, NOT executed

Reserve the sole synthesis attempt first, including failures. Use the coordinator's temporary loopback QA instance in **raw** mode (minimal refuses locally). No retry, redirects, other destination, resource creation or paid key. Candidate model/voice are from the public SDK, **not established Codex values**; a refusal is useful evidence, not a reason to try another model.

Exact HTTP request (local proxy bearer only; do not publish its value):

```http
POST /v1/audio/speech HTTP/1.1
Authorization: Bearer <LOCAL_QA_PROXY_TOKEN>
Content-Type: application/json
Accept: application/octet-stream

{"model":"gpt-4o-mini-tts-2025-12-15","input":"This is a synthetic speech test.","voice":"alloy","instructions":"Speak clearly at normal speed. Finish within five seconds.","response_format":"wav","speed":1,"stream_format":"audio"}
```

The fixed relay target remains `https://chatgpt.com/backend-api/codex/audio/speech`.
Coordinator execution must impose a 30-second timeout and 2 MiB response cap, stop after this one attempt and record sanitized status/content-type/request-id/error, mode, model and date. Do not launch this from an ordinary example or auto-run it from the dashboard.

Expected business outcome **to verify, not observed**: a complete decodable WAV containing the requested short synthetic utterance, no microphone or existing recording, with nonzero decoded samples and duration between 1 and 5 seconds. Verify RIFF/WAVE, bounded chunk sizes, format/sample rate/channel count, declared data length against received bytes, and decoded sample count/duration without playback. Reject JSON/HTML/text, empty audio, invalid/truncated media, or HTTP 200 without valid audio. An error/refusal remains verbatim and qualified.

Binary structure/duration alone cannot prove the words or chosen voice were rendered faithfully. Without an independently authorized semantic check, preserve that uncertainty; do not spend the separate transcription budget or start playback to fill it. A successful raw probe would still require a subsequent faithful minimal adaptation and its own tests before marking speech compatible. This issue's essential live synthesis criteria remain unmet until the coordinator supplies evidence.
