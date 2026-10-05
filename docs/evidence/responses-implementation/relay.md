# HTTP relay integrity evidence

## Coverage addition

Added `tests/fixtures/proxy-errors.test.ts` for the plan's missing HTTP status cases (400, 401, 422, 500), exact error-body and request-ID pass-through, invalid request JSON rejection before upstream dispatch, and malformed aggregated SSE JSON returning an explicit 502 rather than fabricated success. The existing 429 case already asserts status, body, request ID, and `Retry-After`.

## Results

- Mutation proof: temporarily changed the relay's forwarded response status to 200. All four new status cases failed with actual 200 versus expected 400/401/422/500. Restored `src/server/upstream.ts` byte-for-byte to its pre-mutation contents afterward.
- Targeted green run: `bun test tests/fixtures/proxy-errors.test.ts` passed 6/6 tests after restoration (17 assertions).
- Malformed SSE currently emits the SDK's diagnostic line `Could not parse message into JSON` on stderr before the gateway returns the tested explicit 502. The status/body contract passes; this diagnostic is existing dependency behavior, not a newly added logging change.
- No production code fix was justified by these fixture observations. The full baseline suite passed 147/147 with local loopback permission; final shared-tree verification remains owned by the team lead because other agents are changing files concurrently.

## Existing coverage inventory

Existing tests already cover byte-for-byte raw request forwarding, unknown JSON fields and Unicode in minimal mode, byte-by-byte SSE delivery (including UTF-8), unknown event preservation, final output reconstruction in streamed and aggregated paths, request timeout and upload/aggregate size limits, downstream abort propagation, and 429 + `Retry-After`. These cases were not duplicated.
- Post-addition `bun run check`: PASS.
- Post-addition targeted Biome over the owned relay/test files: PASS, 2 informational `useLiteralKeys` notices in the pre-existing response adapters, 0 errors.
- Full baseline `bun run test`: PASS 147/147 with local loopback permission before the new tests; relay subset after the additions: PASS 46/46 across 7 files.
- `bun run build` passed at baseline. No production implementation changed in this slice, so the team lead should use the planned final full build/test/lint pass after shared edits settle.

## DoneClaim and cleanup

DoneClaim: baseline and relay integrity review completed for this slice; missing local status/error coverage is now locked by tests; no proven relay implementation defect required a production code change. No external provider was called. Temporary mutation backup and debug journal were removed; fixture servers closed in `finally` blocks. Persistent artifacts are this memo, the baseline memo, and the sanitized command/lint logs.
