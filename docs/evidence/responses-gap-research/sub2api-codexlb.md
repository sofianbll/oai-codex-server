# Sub2API and codex-lb: source comparison for the local Responses gap

**Scope.** Source read only; neither external repository was executed, configured,
or sent credentials. Consequently, source and repository-test evidence below means
"implemented/tested by that project at the pinned revision", never that a ChatGPT
Codex OAuth account accepts it today.

## Selection and snapshot

This is deliberately not a claim that either is the global best proxy.

| Repository | Why selected | Pinned source | Snapshot metadata (2026-09-20) |
| --- | --- | --- | --- |
| [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) | The original public upstream, rather than the many deployment copies/forks; it implements OAuth and API-key Responses routing in Go. | [`7c700729`](https://github.com/Wei-Shaw/sub2api/tree/7c700729c23187d31ed320f6b19c790e2f194826) (2026-09-20) | 42,140 stars; 8,987 forks; 3,397 open issues; LGPL-3.0; pushed 2026-09-20. |
| [Soju06/codex-lb](https://github.com/Soju06/codex-lb) | Original public repository, not the `codex-lb-nightly` fork; focused on Codex/ChatGPT multi-account routing and contains a large Responses/WS test corpus. | [`9637bdee`](https://github.com/Soju06/codex-lb/tree/9637bdee36744ca65e7cd13ffd47b7e79741f551) (2026-09-18) | 3,196 stars; 477 forks; 190 open issues; MIT; pushed 2026-09-19. |

Metadata is a point-in-time GitHub API read recorded in
[`repositories.json`](repositories.json). Repository tests were inspected but not
run.

## What is demonstrably missing locally

The local evidence is already precise enough to avoid treating normal HTTP
Responses and native WebSocket Responses as interchangeable:

* a valid HTTP envelope has `store:false`, `stream:true`, array `input`, and
  `instructions`, but HTTP rejects `previous_response_id`; the native WebSocket
  two-turn check does recall the secret ([local result](../responses-implementation/RESULTAT.md#L35-L39));
* input image is accepted but did not semantically identify the controlled red
  PNG; cache counters were both zero; `encrypted_content` was absent despite
  `include` ([feature evidence](../responses-implementation/features.md#L8-L23));
* the lifecycle runner reports 403/400/404 for conversations, retrieve/input
  items, delete, background/cancel, token counting and legacy compact. This
  proves failure for the tested local path, not a universal Codex product
  absence ([matrix](../responses-implementation/lifecycle.md#L63-L95)).

## Competitor mechanisms and the faithful lesson

### 1. HTTP ingress to upstream WebSocket is an implementation pattern, not a
REST continuation emulation

Sub2API changes an HTTP Responses request to a WebSocket v2 upstream path when
the selected account/transport says so; it decodes the body only in that branch,
checks for `previous_response_id`, and intentionally does not silently fall back
to HTTP ([forward switch](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_forward.go#L789-L805)).
It resolves session and conversation headers before connecting, using the prompt
cache key only as a fallback identity ([session resolution](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_ws_forwarder_logutil.go#L62-L93)),
and retains a response-id-to-connection preference for later turns
([connection preference](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_ws_forwarder_ingress.go#L1927-L1943)).

codex-lb exposes both HTTP and WebSocket `/responses`, adds a downstream
`x-codex-turn-state` for WebSocket callers, then passes it to the Responses WS
service ([WS route](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L1290-L1329)).
Its affinity code treats a populated `previous_response_id`, `conversation`, or
input file id as owner-bearing and fail-closed ([owner rule](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L490-L508)).
Its documentation explicitly distinguishes soft cache/sticky preference from
hard account affinity for continuation state ([routing contract](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/docs/routing.md#L36-L43)).

**Faithful local translation candidate.** Add an explicitly opt-in HTTP-to-WS
bridge for the OAuth/Codex route. The *first* create must traverse the same
upstream WS session/owner map as its later `previous_response_id` follow-up;
bridging only turn two risks making an HTTP-created ID non-portable. Keep the
raw Responses payload and event sequence, synthesize no stored response, and
scope an opaque response-id → account/connection/turn-state mapping by proxy
credential with bounded lifetime. On a missing/stale owner, return a clear
continuation failure instead of migrating to an arbitrary account.

This is source-backed, but needs a live two-turn HTTP client test (including
reconnect), an interleaved two-account test, and a raw SSE event-order test
before it can replace the current HTTP failure statement.

### 2. Compaction: distinguish legacy route support from current trigger flow

codex-lb implements a public `POST /responses/compact` route
([route](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L6949-L7006)).
More importantly for current Codex compatibility, its normal `/responses`
handler recognizes a terminal `compaction_trigger`, makes a compact request with
the original history plus that trigger, and then turns the result into a
Responses stream ([translation](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L6344-L6385),
[stream result](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L6442-L6529)).
It accepts a compaction output only when it contains opaque
`encrypted_content`, rather than manufacturing one
([normalizer](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L7149-L7164)).

**Boundary.** The local 404 is a probe of the legacy route. It does *not* test
the current normal-Responses trigger protocol. First add a separate live probe
with the exact current `compaction_trigger` form. Only if that succeeds, offer
an optional legacy-route adapter that translates to the verified trigger form
and returns the opaque result unchanged. Do not claim `/responses/compact`
itself exists under OAuth merely because codex-lb exposes it.

### 3. Tool spelling/mapping must be capability-gated

codex-lb normalizes the legacy `web_search_preview` alias to `web_search` in
both `tool_choice` and nested `allowed_tools`
([normalizer](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L5387-L5420)).
For source-routed traffic it drops unsupported hosted tools and their matching
`include` prefixes, then removes dangling forced tool choices
([filter](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L5423-L5531)).
Sub2API's cross-API conversion emits `input_image` for `image_url` message
parts ([image conversion](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/pkg/apicompat/chatcompletions_to_responses.go#L366-L385))
and maps `web_search` / `code_execution` as hosted Responses tools
([tool conversion](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/pkg/apicompat/chatcompletions_to_responses.go#L436-L451)).

**Faithful local translation candidate.** Map only the observed legacy spelling
to the spelling accepted by the particular selected upstream, preserve the
unknown original tool fields, and reject unsupported tools explicitly. Never
drop a user-requested forced tool or fabricate `web_search_call` output just to
obtain a 200. The existing local rejection is correct until a model/route
matrix demonstrates the mapping.

### 4. Images, encrypted reasoning, and cache are transport/state concerns

codex-lb's source documents that image requests can remain WS-capable; it
bypasses the HTTP-to-WS bridge only for an external image URL or frame-size
limit, not merely because an `input_image` exists
([transport policy](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/docs/routing.md#L73-L104)).
This is relevant to the local semantic image failure: a bridge must preserve
the exact data URL and `detail`, with no text-only reconstruction.

For opaque reasoning/compaction state, Sub2API serializes an existing
`encrypted_content` only when supplied on a reasoning item
([wire serializer](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/pkg/apicompat/responses_stream_event_wire.go#L178-L186)),
and codex-lb requires it for a usable compaction output. The local proxy should
round-trip opaque encrypted items verbatim and keep report redaction; it must
not construct a replacement because the upstream did not return one.

For cache locality, codex-lb accepts a supplied key or derives a bounded
transcript anchor and writes it back for bridge fallback consistency
([cache-key resolution](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L708-L746)).
This can improve account/session affinity, but it cannot prove a cache hit.
Continue treating `cached_tokens: 0` as no demonstrated cache benefit.

### 5. Token count is not equivalent across authentication paths

Sub2API routes native `/responses/input_tokens` upstream only when it can; its
code explicitly falls back to a local estimator for custom relays
([forward/fallback](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_count_tokens.go#L43-L67)).
For OAuth, 401/403/404, missing scope, or a blocked platform endpoint are
classified as unsupported, then return a local tiktoken estimate
([OAuth fallback](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_count_tokens.go#L500-L560)).
The configured API-key route, in contrast, can choose the account base URL for
`/v1/responses/input_tokens` ([request construction](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_count_tokens.go#L429-L479)).

**Local decision.** Do not turn the current OAuth 403 into a claimed native
token-count feature. If adding an estimator, label it `estimated`, exclude it
from upstream usage evidence/billing, and retain the raw upstream failure.

## Explicit lifecycle boundary

Neither reviewed OAuth-oriented route surface establishes public Responses
resource storage. Sub2API registers `POST /responses`, guarded
`POST /responses/*subpath`, and a GET only for WebSocket upgrade
([routes](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/server/routes/gateway.go#L217-L235));
codex-lb's reviewed API exposes response creation/WS and explicit compact,
but this source read found no externally routed Responses retrieve, delete,
input-items, background/cancel, or conversations resource implementation.

Therefore:

| Feature | Current local outcome | Source-backed conclusion | Correct next action |
| --- | --- | --- | --- |
| Retrieve / delete / input items | OAuth route 403 | No source basis to emulate a public response store under Codex OAuth. | Keep explicit unsupported; only forward after a separately verified upstream route and ownership model. |
| Background / cancel | Create 400 | No evidence that either OAuth bridge turns it into a durable public job API. | Keep unsupported; do not fake polling/cancel state. |
| Conversations | Create 403 | Hard affinity is a proxy routing concern, not a public Conversations API implementation. | Use opaque affinity only for response forwarding; do not expose a conversation resource. |
| `store:true` | Local HTTP refusal | Competitor continuity relies on WS session/owner state, not proof that HTTP storage is available. | Bridge the first turn over WS and test it; otherwise keep refusal. |
| Input token count | OAuth 403 | Sub2API's fallback is explicitly estimated; API-key path can be upstream. | Preserve this distinction in response metadata and docs. |

## Recommended verification order

1. Probe native normal `/responses` compaction-trigger flow separately from the
   legacy `/responses/compact` endpoint; assert opaque compaction output and a
   dependent follow-up without logging encrypted content.
2. Build the smallest HTTP-to-WS bridge behind a feature flag. Prove a two-turn
   HTTP SDK flow, exact SSE event order, reconnect, response-id owner isolation
   between two credentials, and a clear stale-owner failure.
3. Re-run the controlled red-image test over that bridge. Record the exact
   upstream transport and input payload shape; do not call acceptance of the
   JSON body semantic vision success.
4. Add one explicit `web_search_preview`/`web_search` model-route test before
   applying a mapping. Require the upstream tool-call item, not a text claim.
5. Keep lifecycle resources, background, public conversations, and native token
   counting marked unsupported for OAuth unless direct live evidence changes it.
