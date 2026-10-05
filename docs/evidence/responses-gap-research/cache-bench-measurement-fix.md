# Cache benchmark measurement correction

20 September 2026. This records a local fixture-only change; it made no model
calls and does not claim an upstream cache hit.

## Defect and causal proof

Before the change, `features.py` marked scenario `cache` behavior true when both
responses contained exact `CACHE_OK` text. It did not use `usage`, so a valid
response with `input_tokens=2048`, `cached_tokens=0`, and
`cache_write_tokens=0` exited `0`.

Red fixture result, after the test was added and before the predicate change:

```text
cache scenario requires a positive second cached-read counter and reports raw zero
Expected: 1
Received: 0
```

That fixture toggles only the cache counter while retaining an accepted
two-request exchange; it establishes the scenario predicate as the cause of
the false pass.

## Change

`test_features.py` now records raw `usage` separately from SDK semantic
validation: raw usage presence, `input_tokens`, and cache-read/cache-write
counter state (`absent`, `null`, `value`, or `malformed`). `features.py` keeps
the two-request byte-identical immutable prefix and one generated
`prompt_cache_key`, but marks behavior true only when the second response has:

1. observed positive `input_tokens`; and
2. a positive cached-read counter no greater than input tokens.

This is a plausibility check on observed accounting, not a prompt-size or
Codex OAuth admission contract. A zero, absent, malformed, missing-input, or
cached-greater-than-input value cannot produce PASS. HTTP/SDK contract success
remains the independent `technical_passed` result.

## Fixture verification

The targeted local test command used a temporary loopback server and did not
call a provider:

```text
bun test ./tests/responses-features.test.ts
13 pass, 0 fail, 92 expect() calls
```

It covers a positive hit; explicit zero; absent/null counters; malformed
counter contract failure; low input with zero read; zero input with positive
read; cached-read larger than input; and missing input total. It also asserts
the two request bodies and cache keys are identical and that the stable prefix
is longer than 4,096 bytes.

The requested static check was executed from `api-tests/responses` with the
feature script's declared dependencies available offline:

```text
uv run --offline --with basedpyright --with openai==3.16.2 \
  --with 'pydantic>=2,<3' --with 'typer>=0.16,<1' \
  basedpyright --level error features.py test_features.py
0 errors, 0 warnings, 0 notes
```

Source hashes at verification:

```text
ad0904308359cd78eb52e313a6a240a2e6a9239b880c2c839c3211f0d10a5466  features.py
d3f7a1476de177e52d6ee194eea364859633414e47fea577a18c546e56ea0b9d  test_features.py
4a81bece5b295dac32650a6a4e806f071e4046a7d167afdedbb0c71275936ffa  responses-features.test.ts
```
