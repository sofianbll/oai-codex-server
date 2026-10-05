# Cache-affinity gateway fix

## Change

After the four-call cache A/B at [`cache-ab-20260920.json`](cache-ab-20260920.json) showed a hit only on the repeated matching `session-id` treatment, minimal-mode `POST /v1/responses` now derives that header from a valid body `prompt_cache_key` only when the caller did not send `session-id`.

`prompt_cache_key` remains an optional unknown in the loose schema and stays in the translated body unchanged. Header derivation accepts only a nonempty printable-ASCII string that is unchanged by `trim`; absent, null, non-string, empty, whitespace-padded, CR/LF, and Unicode values are forwarded without a derived header or new validation error. Explicit `session-id` wins. The derivation is limited to requests already handled by the minimal Responses adapter; raw mode and all other routes retain their existing headers/body behavior. The proxy does not synthesize usage fields or invent cache keys.

Implementation: [`response-adapter.ts`](<repo>/src/server/response-adapter.ts:7) and [`upstream.ts`](<repo>/src/server/upstream.ts:103). Regression fixtures: [`proxy-cache.test.ts`](<repo>/tests/fixtures/proxy-cache.test.ts:12).

## Red/green evidence

Before the implementation, the new regression failed for the intended reason: the valid body key reached the upstream fixture, but `session-id` was absent. The explicit-header, absent/invalid-key, raw-mode, and usage-pass-through cases passed.

```text
Command: bun test tests/fixtures/proxy-cache.test.ts
Environment: escalated local fixture run (ephemeral localhost binds are denied in the normal sandbox)
Result before fix: 11 pass, 1 fail
Failure: maps a valid prompt_cache_key to session-id without changing the body key
Expected: "cache-session-123"
Received: null
```

After the implementation, the expanded targeted suite passed all 13 cases, including the non-Responses route boundary and exact body pass-through there.

```text
Command: bun test tests/fixtures/proxy-cache.test.ts
Result after fix: 13 pass, 0 fail; 38 expect() calls
```

## Checks and limits

- `bun run check` — passed (`tsc --noEmit` and UI TypeScript check).
- `bunx biome check tests/fixtures/proxy-cache.test.ts src/server/response-adapter.ts src/server/upstream.ts` — passed with no errors. Biome reports one informational `useLiteralKeys` suggestion for the pre-existing `event.data.response["output"]` access.
- `git diff --check` — passed.
- No real upstream call was made by this worker. The existing process on port 8788 was not stopped or reconfigured. Fresh-gateway QA is delegated to `gap_native_probes` and was pending at artifact creation.

The working tree already contained changes in `response-adapter.ts` and `upstream.ts` before this patch, plus dirty sibling fixture files. This change preserved those edits; it did not modify `proxy-aggregation.test.ts`, `proxy-passthrough.test.ts`, or `proxy-errors.test.ts`.
