# Codex OAuth prompt-cache diagnosis: Sub2API and codex-lb

20 September 2026. This is a source review plus a proposed experiment; no
competitor code was run, no model call was made, and no product code changed.
The two source snapshots below are deliberately pinned. GitHub issue text is
reported as an author's runtime observation, not protocol truth.

## Local fact to explain

The local seven-probe run used a repeated roughly 1,800-word prompt and a
stable key, but retained neither raw `input_tokens` nor an unmodified terminal
`usage` object; its reported cached counters are `0/0`. It also did not return
encrypted reasoning. The project result correctly calls this **no demonstrated
cache hit**, rather than proof that caching is unavailable
([RESULTAT.md](../responses-implementation/RESULTAT.md)). Encrypted reasoning
is a separate replay capability and must be held constant, not diagnosed as a
cache counter.

## Evidence boundary

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| Pinned competitor source | What that proxy accepts, rewrites, routes, or counts. | What the Codex OAuth upstream accepts or caches. |
| codex-lb unit/integration tests | Its intended local routing behavior. | A cache hit at OpenAI. Its selected test models are GPT-5.3/5.4, not GPT-6. |
| Sub2API issue #4632 | A July 2026 reporter observed delayed/intermittent hits despite a stable key/account, on HTTP GPT-5.6 OAuth Responses. | A general upstream cache contract or a resolution: the issue is still open. |
| Current official audit supplied by the parent team | `session-id` and `thread-id` are hyphenated canonical current Codex headers; the root session header is the cache affinity root. | That public `prompt_cache_options`, breakpoints, or retention controls are accepted on the Codex OAuth route. |

Repository selection is contextual, not a global quality claim: on 20 September
the local metadata snapshot records Sub2API at 42,140 stars / LGPL-3.0 and
codex-lb at 3,196 stars / MIT, both active ([repositories.json](repositories.json)).

## What the competitors actually do

### Header and fingerprint handling

* **Sub2API**, at
  [`7c70072` `openai_ws_forwarder_logutil.go:68-93`](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_ws_forwarder_logutil.go#L68-L93), takes `session-id` first, then legacy `session_id`; it also treats legacy `conversation_id` as a session fallback and then falls back to `prompt_cache_key`. It explicitly keeps the key on a WS retry because it considers it the stable session fallback ([`L490-L519`](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_ws_forwarder_logutil.go#L490-L519)).
* But its current HTTP header allow-lists name only underscore `session_id` and
  `conversation_id`, alongside `originator`, UA, and `x-codex-turn-state`
  ([`openai_gateway_service.go:73-105`](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_service.go#L73-L105)). That disagrees with its own WS resolver's preferred hyphen spelling. This is a concrete potential lossy bridge, not evidence that both aliases should be sent upstream.
* It also rewrites a session identity with the downstream API-key id to prevent
  cross-user collisions
  ([`openai_gateway_service.go:1098-1110`](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_service.go#L1098-L1110)). That is a multi-tenant proxy safety measure; copying its hash changes the client-visible Codex identity and is not a cache admission fix.
* **codex-lb**, at
  [`9637bde` `affinity.py:224-276`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L224-L276), accepts `session_id`, `session-id`, and two `x-codex-*` aliases; it recognizes only `thread-id` for the thread. This is backward-compatible proxy input behavior, not canonical-wire evidence.
* Its non-native fingerprint code identifies native traffic by UA/originator,
  specifically excludes `x-codex-turn-state` as an identity signal, and rewrites
  non-native traffic to a `codex_cli_rs` UA and originator
  ([`proxy.py:811-908`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/core/clients/proxy.py#L811-L908)). It applies the same rewrite to an HTTP SDK follow-up routed onto WebSocket
  ([`L1080-L1112`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/core/clients/proxy.py#L1080-L1112)). This is a transport/fingerprint consistency tactic, not proof that UA changes cache admission.

### Key derivation, routing, and controls

codex-lb separates a *soft locality key* from durable response ownership.
Its derived key is minted per API-key/model-class/instructions/thread window,
is forwarded upstream, stays stable across transcript extension and bridge
replay, and intentionally becomes cold after compaction
([`affinity.py:312-406`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L312-L406)).
An explicit `prompt_cache_key` wins; an unanchorable turn receives no injected
key ([`L708-L740`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L708-L740)).

The same module prioritizes `x-codex-turn-state`, then thread/session identity,
then prompt-cache locality; it explicitly says `previous_response_id` ownership
is resolved later and remains hard-owner-bound
([`L749-L829`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L749-L829)).
That separation is transferable: do not use a cache key as a continuation or
authorization token.

The meaningful fixed regression is narrower. codex-lb replaced a truncated
content approach that collapsed threads sharing a 512-character prefix with a
thread anchor ([`affinity.py:349-370`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L349-L370)); its unit test verifies the complete initial input differentiates those threads, and that the inferred HTTP key is soft and API-key scoped
([`test_http_continuation.py:48-66`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/tests/unit/test_http_continuation.py#L48-L66)). This prevents proxy-side locality mistakes. It does **not** demonstrate a Codex cache hit.

The most important negative result is codex-lb's subscription normalizer: it
removes `prompt_cache_options` and explicit prompt-cache breakpoints before
upstream transmission ([`requests.py:840-878`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/core/openai/requests.py#L840-L878), [`L912-L931`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/core/openai/requests.py#L912-L931)). It also strips `prompt_cache_retention` as unsupported ([`L828-L837`](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/core/openai/requests.py#L828-L837)). Therefore no selected competitor source supports adding GPT-6-specific public cache options to our Codex OAuth route.

Sub2API makes the HTTP-versus-WS distinction observable and, once WSv2 is
selected, does not fall back to HTTP
([`openai_gateway_forward.go:789-805`](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_forward.go#L789-L805)). Its current usage struct has separate cache-read and cache-creation fields
([`openai_gateway_service.go:222-231`](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_service.go#L222-L231)); for terminal WS events it replaces collected usage with parsed terminal usage unless that would erase existing tokens
([`openai_ws_forwarder_logutil.go:201-214`](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_ws_forwarder_logutil.go#L201-L214)). This is a representation/aggregation behavior, so local diagnosis must retain the raw terminal event as well as the final client-facing value.

## Issue evidence, correctly scoped

Open [Sub2API issue #4632](https://github.com/Wei-Shaw/sub2api/issues/4632)
reports HTTP GPT-5.6 OAuth Responses with stable `prompt_cache_key`,
`session_id`, `conversation_id`, model, prefix, and selected account still
showing delayed or intermittent cache reads. The reporter also observed that
public cache options/breakpoints returned 400 on that route. It is useful
runtime evidence that identical inputs and account affinity alone do not prove
immediate hits; it is not a resolved upstream explanation.

Closed [issue #1421](https://github.com/Wei-Shaw/sub2api/issues/1421) addressed
a different client-side failure: compatibility clients without any explicit
session/cache signal were randomly account-routed, so its proposed content
fallback created proxy stickiness. It cannot explain our probes, which already
use an explicit key. Open [issue #5727](https://github.com/Wei-Shaw/sub2api/issues/5727)
correctly identifies the stronger protocol risk: independently rewritten
session, thread, and body-key values can describe incompatible identities
across HTTP, WS, and compact. It remains a design proposal, not merged proof.

## Minimal discriminating A/B experiment

Do this before changing the proxy. It requires eight successful calls, the
same Codex OAuth account, and raw redacted capture at ingress, outbound HTTP or
WS handshake, terminal upstream event, and client response. Hash identity
values in the capture; retain field presence separately from numeric zero.

| Arm | Transport | Body `prompt_cache_key` | Header `session-id` | Purpose |
| --- | --- | --- | --- | --- |
| H0 / H1 | Forced HTTP | same opaque `K` | absent / `K` | Tests whether the current canonical header is necessary beyond the body key. |
| W0 / W1 | Forced WS | same opaque `K` | absent / `K` | Tests the same identity mapping while isolating transport. |

For each arm, make an initial warm-up followed by a request with the exact
same immutable prefix, instructions, model, tools and ordering, then a short
different tail *after* the prefix. Keep `store:false`, reasoning settings, UA,
originator, account, and timing policy fixed. Do not send underscore aliases,
`conversation_id`, synthetic turn-state, cache-retention/options/breakpoints,
or `previous_response_id`: each would add a second unverified identity or
continuation variable. Repeat the four arms once with a fresh key `K2`.

For every response record raw `usage` exactly as received, including
`input_tokens` and every cache subfield; then record the proxy's final usage
separately. The expected diagnoses are:

* Raw positive cache field only in H1/W1: body-key to canonical-header
  projection is a justified next change, applied once before both transports.
* Positive only in W1: transport and canonical identity jointly matter; inspect
  the HTTP bridge rather than adding public cache controls.
* Positive raw value but zero/missing final value: this is an observability or
  aggregation defect, not a cache miss.
* All raw values absent/zero while input tokens are present: no local routing
  conclusion follows; preserve the evidence as an upstream admission/eligibility
  result. The Sub2API report shows this can be intermittent even after a
  matching key and account.
* Missing raw input tokens again: stop interpreting `0/0`; first repair only
  lossless telemetry, then rerun.

## Recommendation

Do not apply a cache feature change yet. The only source-backed candidate is a
transport-neutral, single-owner projection of an existing body
`prompt_cache_key` to the **hyphenated** current `session-id` when that header
is absent, after the A/B proves it. Preserve an explicit caller header, do not
also emit underscore/conversation aliases, and do not derive a new identity
from prompt text or account IDs. Keep `x-codex-turn-state`, `thread-id`,
`previous_response_id`, compaction window state, and encrypted reasoning on
their own ownership paths. Do not add public prompt-cache controls or invent a
GPT-6 cache option: selected source actively strips those controls for
subscription upstreams and supplies no GPT-6-specific Codex cache contract.

## Subsequent local result

The experiment proposal above records the pre-change research, not an instruction to spend additional calls. The team narrowed execution to four HTTP calls: baseline 0/0 cached, then matching `session-id` 0/1664 cached out of 1822 input tokens, with the same body/key. See [A/B evidence](cache-ab-20260920.json) and [final correction record](CACHE.md). Warm-up and timing are not excluded without a reversal. The HTTP-only result made the broader WS matrix unnecessary for this narrowly scoped HTTP fix.
