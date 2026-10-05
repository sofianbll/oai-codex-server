# Responses feature-driver black-box tests

Added `tests/responses-features.test.ts`, which runs the existing Python `features.py` driver through `uv run --offline` against real ephemeral localhost HTTP fixtures. The driver report is checked for SDK version `3.16.2`; tests use temporary report directories and remove them after each run. No Codex or external API calls were made.

## Scenarios and observations

- Strict JSON Schema: `{"answer":42}` passes with `technical_passed=true`, `behavior_passed=true`, and exit 0. A completed SDK-valid `{"answer":41}` fails behavior with exit 1.
- Function tool: fixture returns a valid `function_call`; the real Python SDK driver submits a second HTTP request containing that call and matching `function_call_output:42`; final exact `42` passes. A final `41` fails behavior.
- Parallel tools: request includes two tools and `parallel_tool_calls=true`; fixture deliberately returns only one call. The driver completes the second turn but behavior fails, proving it does not count a one-call result as parallel success.
- Non-pass cases: HTTP 422 records `upstream_rejected`, technical false, and exit 1. A closed loopback port records `transport_unavailable`, technical false, and exit 2.
- Reasoning redaction: the fixture echoes the local API key and returns nested `encrypted_content` marked `gAAAAA-...`; the saved report is valid JSON, its response body remains parseable with nested `encrypted_content` equal to `[REDACTED]`, and neither secret marker appears anywhere in the serialized report, including the replay request.
- Missing reasoning item: a valid completed response records technical true with behavior null and exit 1, rather than presenting replay as a pass.

## Verification

- `bun test tests/responses-features.test.ts` with escalated localhost access: PASS, 6 tests and 54 expectations.
- `bun run check`: PASS.
- `bunx biome check tests/responses-features.test.ts`: PASS with nine informational `useLiteralKeys` notices; bracket access is required by the project's `noPropertyAccessFromIndexSignature` TypeScript setting.

All fixtures stop their servers in `finally`; the transport-unavailable case stops its listener before invoking the driver. Temporary report directories are removed in `finally`. No Python driver or feature implementation files were changed by this test-only task.
