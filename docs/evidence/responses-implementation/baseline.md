# Responses relay baseline

Captured before this agent's test addition: 2026-09-20 15:28:58 UTC. Shared checkout; other team agents were already editing concurrently, so this snapshot is a point-in-time record, not a clean-tree claim.

## Initial checkout state

Tracked modifications at capture: `bin/oai-codex`, `package.json`, `src/cli/main.ts`, `src/server/catalog.ts`, `src/server/openapi.ts`, `src/server/response-adapter.ts`, `src/server/upstream.ts`, `src/ui/explorer.ts`, `src/ui/shell.css`, `tests/fixtures/proxy-aggregation.test.ts`, `tests/fixtures/proxy-passthrough.test.ts`.

Untracked paths at capture: `api-tests/`, `artifacts/qa/api-tests/`, `bun.lock`, `exa-results/`, `logs/`, `src/cli/api-tests.ts`, `src/server/response-stream-adapter.ts`, `tests/api-test-command.test.ts`, `tests/responses-cli.test.ts`, `tests/responses-history-cli.test.ts`, `tests/responses-stream-cli.test.ts`.

The relay source and fixture diffs already existed at capture, including the stream-output adapter and added model defaults. They were preserved. No private log contents or secrets were copied into this evidence.

## Checks at baseline

- `bun run check`: PASS.
- `bun run build`: PASS (`Dashboard built (2 files); Scalar bundled locally.`).
- `bun run test`: the in-sandbox run failed because even a minimal `Bun.serve({ hostname: "127.0.0.1", port: 0 })` returned `EADDRINUSE`. The same minimal listener succeeded with the approved escalated command and bound `127.0.0.1:52944`. With local loopback access, the full suite passed: 147 pass, 0 fail, 21,454 expectations across 19 files.
- `bun run lint`: FAIL at capture with 2 errors and 78 informational diagnostics. The tree already had concurrent CLI edits; lint details were truncated by the default diagnostic cap. A later uncapped scan of the still-changing shared tree found formatting/import errors in `src/cli/main.ts`, `src/cli/responses-scenarios.ts`, and `tests/responses-lifecycle-cli.test.ts`; these are outside this relay slice.

## Existing relay coverage review

The suite already covered raw request bytes and multipart/binary pass-through, unknown request fields, successful request normalization, UTF-8 split byte delivery and future SSE events, streamed and nonstream output reconstruction, preservation of authoritative output, 429 body/request ID/`Retry-After`, malformed paths and size bounds, timeout, and downstream abort propagation. No confirmed production relay bug was found during this audit.

Plan gaps addressed after this baseline: direct pass-through assertions for upstream 400/401/422/500, malformed adapted request JSON, and malformed aggregated SSE JSON. See `relay.md` for targeted and mutation-proof results.
