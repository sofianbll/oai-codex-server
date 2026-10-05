# Cache correction review — PASS

This is a separate verdict from the earlier general Responses-gap review. It
binds the cache correction to the final dirty-file fingerprints recorded in
`cache-final-files.sha256`:

```text
b768e5357934ecf55127067b8b369b23a8a4aa419e06c5a75041bd87d20ebc0b  README.md
0cb24f4dec4f321b0266b1a5dfe42fa67caf31c8643b598ace0c69f1c2331ad4  src/server/response-adapter.ts
859f6a5c7e2d290841332afc48019b96991ececf7a40c8902f0455a4ca6a09a2  src/server/upstream.ts
a4d9b97d4ab6ef2026486c16a9ad4b69498b89347959330a0728762b1302fce2  tests/fixtures/proxy-cache.test.ts
ad0904308359cd78eb52e313a6a240a2e6a9239b880c2c839c3211f0d10a5466  api-tests/responses/features.py
d3f7a1476de177e52d6ee194eea364859633414e47fea577a18c546e56ea0b9d  api-tests/responses/test_features.py
5e3418783453746dae54e72b9dda2187dea4cc598b042b20eb2fd7db0f4fc379  api-tests/responses/features.md
4a81bece5b295dac32650a6a4e806f071e4046a7d167afdedbb0c71275936ffa  tests/responses-features.test.ts
```

The implementation is a narrow protocol translation: minimal-mode `POST
/v1/responses` projects a nonempty, trim-stable printable-ASCII body
`prompt_cache_key` into `session-id` only if the caller did not provide that
header. It preserves the JSON value and explicit valid header, leaves raw mode
and other routes alone, and creates neither keys nor cache/usage counters.

The permanent benchmark now accepts a cache hit only when raw observed usage
has a positive input total and `0 < cached_tokens <= input_tokens`. Its fixtures
cover zero, absent, null, malformed, missing-input, and overlarge cache values,
so an exact text response cannot create a cache false positive.

Evidence supports an observed fix, with the right limits. The pre-change A/B
was positive but did not exclude timing or warm-up. After the source change, a
fresh temporary minimal gateway received two unmodified standard-SDK requests:
both reported 2,893 input tokens and exact output; cached tokens were `0` then
`2,688`. The final predicate was replayed against those retained redacted
responses with no additional network call and returned `false`, then `true`.
The existing service on port 8788 was intentionally not restarted, so it has
not loaded this correction yet.

Validation is recorded in `cache-final-checks.md`: full check, test (187 pass,
0 fail), build, lint, and `git diff --check` all passed. The source evidence
does not establish deterministic cache hits for every account, model, or timing
condition, and the gateway does not attempt to provide that guarantee.
