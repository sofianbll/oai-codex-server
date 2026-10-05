# Adversarial review — Responses bench

Review date: 2026-09-20. Scope is semantic compatibility claims, report safety, scenario pass criteria, SDK client behavior, cleanup, and exit codes. Product code was read-only during this review.

## Resolved after initial review

### P1 — feature reports leak encrypted reasoning content

`api-tests/responses/test_features.py:72-74` attempts to redact `encrypted_content` from a final JSON report with a regex that only matches unescaped object keys. `Attempt.response_body` is itself a JSON string, so `FeatureReport.model_dump_json()` writes it as `\"encrypted_content\":\"...\"`; the regex does not match it.

Evidence: `api-tests/responses/results/features-parallel-tools-20260920T153959227955Z.json` contains a complete `gAAAA...` `encrypted_content` value in `attempts[].response_body`, despite the implementation evidence claiming redaction. The same shape appears in other feature captures.

Resolved in the current `test_features.py`: `safe_body()` parses the inner upstream JSON and recursively replaces `encrypted_content` before the outer report serializes. Independent re-read found the two regenerated reports `features-native-media-20260920T155140716832Z.json` and `features-function-20260920T155147091405Z.json` parse with `jq` and contain neither `gAAAAA` nor malformed JSON. A committed regression fixture is still required before this can count as durable coverage.

### P1 — `technical_passed` is coupled to an unavailable semantic observation

`api-tests/responses/features.py:128` derives `technical_passed` as `None` whenever `behavior is None`. In `reasoning-replay`, an accepted SDK-valid first response without the optional encrypted item is changed to `reasoning_item_not_returned` at lines 90-93, then the report says both technical and behavior are null. In `builtins`, a prerequisite placeholder similarly erases the independent transport/SDK result.

Resolved in the current `features.py`: the optional missing encrypted item retains the accepted attempt and has `behavior_passed=None`; `prerequisite_missing` does not itself fail technical transport/contract aggregation. Exit status remains non-zero for the open capability.

### P1 — compact scenario accepts an endpoint response without proving continuity

`api-tests/responses/test_lifecycle.py:148-157` sends a secret in a first response and calls `client.responses.compact`, but reports success as soon as the compact endpoint returns (`compacted.passed is True`). It never uses the returned compact output/ID in another request and never verifies `COMPACT_SECRET_<random>` is recalled.

This is an accept-only false positive relative to the plan's explicit compact acceptance criterion. Add the dependent post-compaction response and require exact secret recall; preserve `blocked` when no reusable compact result exists.

### P1 — four lifecycle scenarios presently pass without their named observable result

- `conversation` (`api-tests/responses/test_lifecycle.py:99-108`) creates a conversation and sends one response, but never sends a dependent turn or checks secret recall.
- `retrieve` (`:109-120`) checks that `retrieve` and `input_items.list` returned, but does not assert the listed input item equals the created test input.
- `delete` (`:121-131`) records a successful delete call but never performs the required subsequent read to demonstrate deletion.
- `background-cancel` (`:132-142`) records a cancel call but never observes a cancelled terminal state through retrieve/polling.

These are accept-only tests. They must be marked incomplete/blocked or extended with the stated dependent observation; HTTP acceptance alone is not lifecycle compatibility.

### P2 — feature labels overstate what their behavioral assertions establish

`instructions` (`api-tests/responses/features.py:47-52`) sends omitted, null and explicit instructions but only asserts the explicit-instruction output. A PASS therefore does not prove omission and null behaved as requested. `cache` (`:84-88`) proves two accepted calls but not cache use; it should report cache counters separately and name a zero-hit run as parameter acceptance rather than caching observed. `native-media` (`:104-107`) tests an inline input file only, while its CLI label/docs promise image/audio native outputs. Do not label any of these broader capabilities passed until their direct observable assertions exist.

## Confirmed positive evidence

The independent WebSocket acceptance replay succeeded against the temporary minimal proxy:

```sh
bun run api-tests/responses/test_websocket.ts \
  --base-url http://127.0.0.1:54820/v1 \
  --model gpt-6-astra \
  --key-file .local/server-token \
  --output-dir /private/tmp/responses-adversarial-ws
```

Report `/private/tmp/responses-adversarial-ws/websocket-20260920T154332295Z.json` has exit 0, terminal `response.completed` for both turns, `first_acknowledged:true`, `second_recalled_secret:true`, and `secret_in_second_payload:false`. The captured event list also retains upstream-specific frames such as `codex.rate_limits`; success is not inferred from HTTP SSE.

`test_websocket.ts` correctly treats a close before a terminal event as failure and bounds each exchange with 30 seconds. Its ordering check is conditional on available `sequence_number`; the live capture did not establish global sequence numbers, so this remains a deliberately limited assertion rather than proof of a universal event ordering contract.

## Open blockers / re-review required

- **P1:** Lifecycle scenarios remain under replacement by `finish_lifecycle`; their original accept-only logic must not ship. See the lifecycle findings above.
- **P1:** No committed `tests/responses-features.test.ts` exists yet. The claimed feature run must gain focused fixtures that prove error status/exit behavior and structured report redaction; existing unrelated CLI tests do not cover these new Python runner boundaries.
- **P2:** `features.py` and `test_features.py` retain new `typing.Any`/untyped reflective payload boundaries. This is a type-discipline deviation; use a controlled JSON-value type or explicitly isolate the SDK boundary once the functional fixtures are in place.
- Re-check final native-media/built-in claims against their direct output assertions. Current evidence correctly says inline `input_file` is observed and image/audio outputs are not; it must not regress to a broader PASS.

## Delta verdict — features and capture helper only

**PASS (scoped).** The completed feature runner and capture helper now make the claimed distinctions without turning rejection, missing encrypted reasoning, or an unconfigured built-in into a compatibility success.

- `tests/responses-features.test.ts` passed independently: **5 tests, 43 assertions**. It exercises SDK-valid JSON Schema success versus wrong semantic output, two-turn function output, rejection of a one-call parallel result, 422/transport failures, nested encrypted reasoning/key redaction, parseability, and the independent `technical_passed:true` / `behavior_passed:null` missing-reasoning case.
- The capture helper now scrubs parsed upstream JSON before the outer report serialization. A local no-network regression verified nested encrypted values become `[REDACTED]` and the resulting JSON parses.
- `features.py` now uses a generated 64×64 RGB red PNG for image input and checks image-generation output for a base64 PNG signature while `test_features.py` redacts large binary `result` fields. Evidence correctly limits native media to what was observed.

Residual quality note: the new Python SDK boundary still uses `typing.Any` for JSON payloads. It did not create a false pass in this review, but should be replaced by a typed JSON-value boundary in later cleanup.

This PASS does **not** cover lifecycle; the lifecycle replacement remains an independent P1 open blocker.

## Delta verdict — lifecycle harness

**INCOMPLETE — do not count the current behavior fixture as scenario coverage.** Source inspection shows the replacement removes the earlier accept-only paths: `previous_response_id` and `conversation` require exact random-secret recall; delete requires a 404 readback; cancellation requires `status == "cancelled"`; input-token counts reject booleans and negatives; compaction requires a follow-up recall through the returned compact ID. The seven current reports correctly record nonzero rejected/unavailable outcomes rather than compatibility passes.

Independent verification: `bun test tests/responses-lifecycle-cli.test.ts tests/responses-lifecycle-behavior.test.ts` passed **2 tests, 13 assertions**. However, `responses-lifecycle-behavior.test.ts` constructs `ScenarioExecution` directly from already-chosen booleans and only calls `_verdict`; its `wrong_recall`, `wrong_delete`, `wrong_cancel`, and `ignored_compact` labels do not execute the matching scenario or HTTP fixture. It proves the boolean aggregator, not the requested observables. Add real SDK HTTP fixture tests that run `execute` (or individual scenario functions) with controlled create/retrieve/delete/cancel/compact responses and assert each wrong downstream observable produces nonzero output. The fresh report has a populated `operations` array and the reported HTTP gaps match the harness outcome.

Resolved: `lifecycle_scenarios.py:_retrieve` now uses a unique marker and requires it in a returned input item; the lifecycle wire fixture has both matching and unrelated-input paths.

## Final consolidated verdict — runnable Responses bench

**PASS, scoped to the bench.** The independent completed slices now provide meaningful client-facing scenarios, strict response parsing/redacted capture, distinct technical versus behavior outcomes, native lifecycle wire semantics, Node/WS coverage, and nonzero results for observed backend gaps. The bench does not create a false compatibility success for unavailable HTTP lifecycle features.

Final lifecycle re-review: `bun test tests/responses-lifecycle-wire.test.ts` passed **2 tests, 59 assertions** outside the filesystem sandbox, which is required for Bun ephemeral loopback fixtures. These tests drive the actual Python lifecycle runner through fixture HTTP endpoints and verify positive and deliberately wrong outcomes for secret continuation, conversation, retrieval marker, delete-then-404, queued background cancellation plus cancelled retrieval, and compact-output replay. This replaces the earlier boolean-only `_verdict` pseudo-coverage.

The pass means the compatibility **bench is reliable enough to report current evidence**. It is not a declaration of full Responses compatibility: current native evidence still rejects/unavailablely reports HTTP `previous_response_id`, conversation, retrieval/delete, background/cancel, token counting and compaction on the tested backend, while WebSocket continuation is separately observed. These remain product capability gaps, not test failures to hide or emulate.

## Final delta — typed lifecycle payloads

**PASS (latest lifecycle sources).** The final type-only correction in
`api-tests/responses/lifecycle_scenarios.py` preserves the public request
semantics exercised by the wire fixture:

- `_create` validates user input as `ResponseInputParam`, sends an explicit
  `ResponseCreateParamsStreaming` envelope, and includes
  `previous_response_id` only for a continuation. The valid baseline remains
  `store: false`, `stream: true`.
- The `store` omission and `store: true` probes remain separate observations;
  neither has been folded into continuation success.
- Background work remains `background: true`, `store: true`, `stream: false`
  before cancel and final retrieval. Compaction replays returned compact output
  as validated input without manufacturing a `previous_response_id`.
- Retrieval retains a per-run `input_items` marker, deletion requires a missing
  readback, and continuation/compaction require the original secret to be
  absent from the dependent payload.

The latest scenario-only type check is clean (zero errors and warnings); the
aggregate report retains five pre-existing warnings outside this module. The
current lifecycle wire/CLI/capture fixtures passed **4 tests, 84 assertions**
after this correction. `git diff --check` was clean for the reviewed lifecycle
paths. The scoped bench verdict remains **PASS**; native HTTP lifecycle
refusals remain explicit compatibility gaps.

## Commands used

- Read full current runners and focused tests: `features.py`, `test_features.py`, `test_lifecycle.py`, `test_websocket.ts`, `acceptance.ts`, lifecycle/Node/WebSocket tests.
- Inspected saved report values with `jq`; no credential or raw auth value is recorded here.
- Executed the WebSocket scenario above against the supplied temporary proxy. It completed in 9.7 seconds with exit 0.
