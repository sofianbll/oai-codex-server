# Cache A/B probe preparation

## Previous seven-call limitation

The earlier cache result retained only statuses, exact short outputs, and zero `cached_tokens`. Its temporary probe source and in-memory SDK hooks were removed after cleanup. It cannot prove the exact client request headers, the proxy's remote target, the upstream account, or whether a zero arose from a missing versus present usage field beyond the persisted report statement. Those claims remain unobserved for the earlier calls.

## Source-backed candidate

Official Codex `client.rs:574-582` states that ChatGPT derives cache affinity from the Responses `session-id` header. The generated session identity equals the prompt-cache key for a root session. The local relay copies non-private incoming headers before supplying its own credentials (`src/server/upstream.ts:27-39`, `103-117`), so an ordinary inbound `session-id` header can reach the configured upstream. This is a candidate, not a diagnosis of the running service.

## Controlled design

`cache_probe.py` first self-tests against a local ephemeral fixture. It proves that two baseline SDK requests use byte-identical bodies before any live call. Its authorized live sequence is four requests with one fresh, constant key and source input: two without `session-id`, then two with `session-id` equal to that key. It records the exact request-body hash, input length/hash, cache-key hash, header names with safe values or hashes, response status/content type/duration, and a normalized full numeric usage object once final stream parsing is completed.

The remote target and upstream account are not client-observable. They must be supplied as redacted runtime observations by the local-runtime audit before live execution.

## A/B result

The local-runtime audit verified the active service as the repository Bun process, configured for the Codex upstream in minimal mode, `gpt-6-astra`, and client version `0.155.0`. Four standard-SDK streamed calls then used one fresh cache key and byte-identical request body: two baseline requests without `session-id`, followed by two requests with `session-id` equal to that cache key. The full redacted capture is [cache-ab-20260920.json](cache-ab-20260920.json).

Every call used 1,822 actual input tokens, exceeding the public documented 1,024-token threshold used to size this probe. That threshold does not prove the complete Codex OAuth cache-eligibility contract. Both baseline calls and the first treatment call returned `cached_tokens: 0`. The second treatment returned `cached_tokens: 1664`, while input and output totals remained 1,822 and 5. The request header manifest proves the sole intentional variant was the matching hyphenated `session-id` routing header.

This is positive A/B evidence for the official cache-affinity header candidate. The evidence boundary is client-side SDK body/header capture and returned usage, plus separately verified local runtime configuration; it is not a direct upstream wire capture. It is not an A-B-A proof or a deterministic-cache guarantee: the fresh raw key was held only in the exited probe process and was not retained, so the two planned same-key reversal calls were correctly not attempted.

## Post-fix owned runtime

An isolated minimal gateway was initialized from the current source with a fresh local server key, dashboard and docs disabled, and an ephemeral loopback listener. Its `/health` endpoint returned HTTP 200 with the expected service status. An authenticated malformed `POST /v1/responses` body of `{` returned HTTP 400 with `invalid_json`, proving the fresh process is serving the current request-validation path without sending a model request. The original user service on port 8788 was not changed.

The permanent cache benchmark uses the ordinary SDK `features.py --scenario cache` path: its two requests carry only `prompt_cache_key` in the body. This is the matching client surface for validating that the gateway now derives the ordinary upstream `session-id` header itself.

## Post-fix standard-SDK result

The root-run permanent benchmark on the isolated gateway used SDK 3.16.2 standard JSON Responses calls, no client-supplied `session-id`, and one echoed cache key matching the requested body key. Its two calls returned exact `CACHE_OK`; cached input tokens changed from 0 to 2,688 with 2,893 input tokens on both calls. The durable redacted proof is `cache-postfix-qa.json` in this evidence directory.

The final predicate replay then passed without network calls: the first cache observation was false, the second true, and both outputs were exact. The redacted proof includes the source SHA. After that replay, only the owned gateway PID on its ephemeral port was sent `SIGINT`; its listener was absent afterward, while the user-owned service on port 8788 remained listening. The owned temporary directory, including its fresh server key, config, and raw output, was removed. Durable redacted evidence remains in this directory.
