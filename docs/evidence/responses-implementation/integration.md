# Responses CLI and documentation integration

## Scope

The numbered `oai-codex test responses` family preserves the historical 01–03 identifiers and appends 04–24 in dependency order. The registry selects the correct runner: `uv run` for Python lifecycle/options scenarios and `bun run` for the WebSocket and Node SDK scenarios. It forwards `--scenario`, `--base-url`, `--model`, `--key-file`, and optional `--output-dir` without retries.

The CLI preserves each runner's exit status. A runner's nonzero `1` (rejected or semantically nonconformant) and `2` (unavailable or blocked prerequisite) remain non-success results. Reports belong to the runners and retain their separate technical and functional verdict fields.

## Commands and observed results

```sh
bun run src/cli/main.ts test responses --help
bun run src/cli/main.ts test responses --scenario invalid
bun run check
bun test tests/api-test-command.test.ts tests/responses-cli-integration.test.ts
```

Observed on 2026-09-20:

- Help printed exactly one stable list from `01 — Texte simple` through `24 — Médias natifs`.
- The invalid scenario command exited `1` and printed the targeted invalid-scenario guidance.
- `bun run check` passed.
- The two targeted test files passed `4/4`. The integration test invoked the actual CLI with `--scenario previous-response`, a disposable localhost SSE fixture, a temporary config/key, and `--output-dir`; it observed exit `0` and a redacted lifecycle report with `scenario: previous-response`, `verdict: passed`, and `functional_passed: true`.

## Truthful status copy

`README.md` and the public catalog now state that minimal streaming repairs only a terminal empty/missing `response.output`; it does not claim all stream events remain byte-for-byte unchanged. They also narrow the verified Responses creation claim to observed basic text JSON/SSE and client-supplied history. Lifecycle, persistence, WebSocket acceptance, and optional creation features remain backend-dependent until their runners record an observation.

## Files

- `src/cli/responses-scenarios.ts`
- `src/cli/api-tests.ts`
- `src/cli/main.ts`
- `tests/api-test-command.test.ts`
- `tests/responses-cli-integration.test.ts`
- `README.md`
- `src/server/catalog.ts`

## DoneClaim

The CLI and documentation integration is complete. It adds no backend behavior, persistence, retry, or status fabrication.

## Cleanup

The integration test removes its temporary config, key, fixture report directory, and local server in `finally`. No live backend scenario was run and no historical 01–03 report was overwritten.

## Verification coverage update

`tsconfig.json` now includes `api-tests/**/*.ts`, and the Biome configuration plus `bun run lint` include `api-tests/**/*.ts`. This makes the Node and WebSocket acceptance drivers part of ordinary project checks. The first newly covered check reported a driver diagnostic to its owner: `api-tests/responses/acceptance.ts` must use `process.env["OPENAI_API_KEY"]` under `noPropertyAccessFromIndexSignature`; Biome also reported pending driver formatting/import diagnostics. No driver source was changed by this integration lane.

No `src/ui/**` file was modified in this lane. Visual QA is therefore not applicable to this integration change.

Scenario 24 is labelled `Fichier en entrée` because its runner covers only an inline data URL file input. It does not establish native image or audio output support.
