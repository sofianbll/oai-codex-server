# Independent relay verification

Verified 2026-09-20 against `baseline.md`, `relay.md`, the approved Wave 1 section of `.omo/plans/responses-completion.md`, current fixture tests and relay source. Product code was read-only for this check. I ran no Codex backend or external provider calls.

## Confirmed

- **Focused fixture run:** `bun test tests/fixtures/proxy-errors.test.ts` completed with exit 0: 6 pass, 0 fail, 17 assertions. The command needed approved loopback access because the fixtures start ephemeral `Bun.serve` listeners; the default sandbox restriction documented in `baseline.md` remains relevant.
- **Upstream HTTP status/body pass-through:** the actual fixture server returned 400, 401, 422, and 500 with an OpenAI-shaped JSON body and `x-request-id`. Each assertion observed the exact status, request ID, and byte-for-byte body string. This is fixture evidence for relay behavior only, not provider capability or a real backend response.
- **Malformed client JSON:** invalid JSON returned HTTP 400 with `{error.code:"invalid_json"}` and upstream call count stayed at zero.
- **Malformed aggregated SSE JSON:** a minimal-mode nonstream request against malformed upstream `data:` JSON returned HTTP 502 with `{error.code:"invalid_upstream_stream"}`; no success response was fabricated. The SDK emitted `Could not parse message into JSON` on stderr during this passing test, matching the diagnostic already noted in `relay.md`.
- **Wave 1 status cases:** the new test complements the existing 429 coverage noted in `baseline.md` and `relay.md`; its 4xx/5xx response body and request-ID assertions correspond to plan item 2. The test checks the HTTP contract at the real local HTTP fixture seam.
- **Mutation-proof sensitivity:** the test source explicitly compares each actual status against its distinct expected parameterized value (400/401/422/500), so a status-forwarding regression to 200 will fail all four cases. `relay.md` records that such a mutation was actually applied, produced four 200-vs-expected failures, and was restored. I did not repeat the source mutation because this assignment required product code to remain read-only; I also cannot independently attest the historical byte-for-byte restoration from current state alone. The current source and tests were not modified by this verification.
- **Shared dirty state:** the current checkout contains the same broad concurrent product edits documented by `baseline.md`, plus later CLI, QA, and fixture files. I made no product-code edits and did not revert or overwrite any shared changes. This memo is the only file written for this verification.

## Needs follow-up / limits

- This focused run verifies the new error fixture cases; it is not a rerun of the full suite or the entire Wave 1 matrix. The baseline reports 147/147 full-suite pass with local loopback permission; I relied on that saved result instead of repeating the suite.
- The new malformed-SSE test covers malformed JSON in aggregated mode. It does not itself exercise every Wave 1 edge in the plan (split UTF-8/frame boundaries, unknown events, slow client, size limits, cancellation, or secret-free journaling). Those are described as existing coverage in `baseline.md`; independent re-execution was outside the requested focused test run.
- The stderr parser diagnostic appears despite the expected gateway 502 and passing assertions. It is recorded as a test observation; this check does not establish whether production logging should suppress it.
- No assertion here proves Codex backend acceptance, SDK-wide compatibility, or any external tester result. All observed outcomes came from deterministic local fixtures.

## Exact evidence

- Approved criteria: `.omo/plans/responses-completion.md`, “Vague 1 — intégrité du relais Create Responses et erreurs”, especially items 2–4 and its pass condition.
- Prior state and full-suite/sandbox record: `docs/evidence/responses-implementation/baseline.md`.
- Prior mutation and focused run record: `docs/evidence/responses-implementation/relay.md`.
- Re-executed test: `tests/fixtures/proxy-errors.test.ts` (6 pass, 17 assertions).
- Fixture transport: `tests/fixtures/proxy-harness.ts` uses local ephemeral Bun HTTP servers and `forward()`.
- Current forwarding/error handling inspected read-only: `src/server/upstream.ts`, `src/server/response-adapter.ts`, `src/server/response-stream-adapter.ts`.
