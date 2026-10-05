# Native Responses probes

## Scope and method

Source was pinned to official Codex `b05b3e180b858054f10d242e564fc4707b409e8c` in `/private/tmp/responses-gap-official`. It appends `ResponseItem::CompactionTrigger {}` to the ordinary prompt input before starting the standard streaming Responses request (`compact_remote_v2_attempt.rs:78-109`). Its collector requires one and only one `ResponseItem::Compaction` from `response.output_item.done` (`compact_remote_v2.rs:387-475`).

The current local upstream source serializes the hosted search tool as `"web_search"` (`upstream/codex-132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/tools/src/tool_spec.rs:39-64`), with mode options built in `codex-rs/core/src/tools/hosted_spec.rs:14-38`.

The live probes made seven calls total, without retries, to the pre-existing `http://127.0.0.1:8788/v1/responses` service using `gpt-6-astra`. All used array `input`, `instructions`, `store: false`, and `stream: true`. The service was never stopped or reconfigured. They were run with `uv run --offline /private/tmp/native_responses_probe.py` and `uv run --offline /private/tmp/native_extra_probes.py`; both temporary sources are removed in cleanup. The semantic, redacted result is in [native-probes.json](native-probes.json).

Safe request templates were: (1) history plus a final `compaction_trigger`, followed by its returned item plus a recall prompt; (2) `tools: [{ "type": "web_search" }]` with required tool choice and a citation request; (3) a synthetically generated 64x64 RGB red PNG `input_image`; (4) high-effort arithmetic with `include: ["reasoning.encrypted_content"]`; and (5) two byte-identical requests using one fresh cache key, an 1800-word `cache ` prefix, and an exact `42` response instruction. No template contains a credential, random secret value, encrypted content, response text, or base64 image data.

## Live proof

### Compaction

The streamed request ending with `{ "type": "compaction_trigger" }` returned HTTP 200 and exactly one `compaction` output item. That item contained no plaintext copy of the controlled random secret. A new streamed request whose array input contained the complete returned compaction item followed by a new user message returned the secret exactly once. This confirms the native stream form works end to end; a 404 on the standalone public `/responses/compact` endpoint does not disprove it, though that endpoint remains part of the public API.

### Web search

The corrected `tools: [{ "type": "web_search" }]` request returned HTTP 200. Its stream emitted one web-search call and one URL citation, proving actual hosted search execution rather than an answer inferred without the tool. The earlier `web_search_preview` rejection is therefore a payload-name mismatch for this service.

### Image, encrypted reasoning, and cache controls

The controlled RGB PNG input returned HTTP 200 and the model identified it as `rouge`. This establishes one working image-input case, while the earlier conflicting image result remains an open robustness issue.

The high-effort reasoning call returned HTTP 200 and the expected arithmetic result, but its completed output contained zero reasoning items and no encrypted content. A replay request was therefore not attempted; this is an absent prerequisite, not a rejection.

The two cache calls used exactly the same request payload bytes and key, with an 1800-word stable prefix. Both returned HTTP 200 and exact `42` output. `cached_tokens` was present and zero in both completed responses, so a cache hit was not observed. The semantic capture did not retain `input_tokens`; the seven-call bound was already reached, so it was not recovered with another model call.

## Limits

This only proves the observed local service behavior for the listed payloads and model, not a general compatibility guarantee. The controlled secret, encrypted compaction item, response text, credentials, and binary payloads were held only in process memory and are absent from the evidence.
