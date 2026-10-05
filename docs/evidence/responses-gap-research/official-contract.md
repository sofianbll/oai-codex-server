# Official contract cross-check — 2026-09-20

## Evidence level

Public API documentation and official Codex client source describe different surfaces. A public API feature is not evidence of availability using a ChatGPT Codex session. Source below is a candidate protocol translation until our own live probe verifies it. No public SDK or Codex feature limits are inferred from competitor marketing.

## Fresh official Codex source

GitHub API returned main `b05b3e180b858054f10d242e564fc4707b409e8c`, commit date `2026-09-20T16:26:34Z`. Four public files were downloaded as text into the root-owned `/private/tmp/responses-gap-official/`; none executed. They confirm the compaction mechanism already present in the project's September 19 pinned checkout.

- [Compaction request assembly](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/src/compact_remote_v2_attempt.rs#L68-L108): the history is followed by `ResponseItem::CompactionTrigger {}` and a regular Prompt with tools/instructions.
- [Transport and collector](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/src/compact_remote_v2.rs#L387-L475): `client_session.stream` sends that prompt through normal Responses transport; collector expects an actual Compaction output item. A prose summary is not equivalent.
- [Trigger wire representation](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/protocol/src/models.rs#L3773-L3792): test serializes `{ "type": "compaction_trigger" }`.
- [Reasoning request and cache key](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/src/client.rs#L934-L959): official client asks for `reasoning.encrypted_content` and computes a cache key. Our simple successful response without such an item does not disprove reasoning replay.
- [Native WebSearch wire name](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/tools/src/tool_spec.rs#L39): pinned local Codex code names the tool `web_search`; [hosted options](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/core/src/tools/hosted_spec.rs#L14-L38) distinguish external/cached access.

## Public API semantics

- [WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode): continuing with `store:false` relies on a connection-local cache. If the socket/anchor is lost, continuation may require a full transcript. This supports the bridge architecture as a candidate; it does not promise durable retrieval or Codex-specific cache lifetime.
- [Compaction](https://developers.openai.com/api/docs/guides/compaction): public standalone compaction returns a new input window including an opaque encrypted item, which must be reused intact. A translation must reconstruct this public envelope faithfully and prove subsequent continuity, not merely return any nonempty object.
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): GPT-5.6 and later require at least 1,024 visible input tokens in an eligible stable prefix. The actual Codex-specific threshold still requires measurement. Our roughly 50-character repeated prompt cannot establish a missing caching capability. Key acceptance alone is not a cache hit.

## Implication

Probe native `compaction_trigger` and corrected `web_search` on the existing model/session. Separate transport adaptation (HTTP ↔ WebSocket), API state emulation (store/retrieve/delete/background), and a genuine model control (temperature/top_p/token limits). Silently stripping a requested parameter only increases request acceptance; it does not implement the parameter's behavior.
