# Skeptical review — PASS

Reviewed 2026-09-20 against the current research artifacts.

The synthesis keeps the necessary boundaries between an observed local failure,
an untested prerequisite, a proxy policy, and an upstream capability. It does
not turn the HTML 403 lifecycle responses into a Codex-service verdict; it
attributes `background:true` only to the confirmed local `store:true` gate;
and it does not equate a local token estimate with native `input_tokens`.

The decisive positive claims are bounded correctly. Seven redacted native calls
prove the normal streamed `compaction_trigger` form and opaque-item replay,
and the `web_search` spelling with an actual search-call event and URL
citation. They do **not** establish the public standalone compact endpoint,
generic model compatibility, durable response storage, or public lifecycle
resources. The 1,800-word repeated cache probe observed zero cached tokens
twice but retained no `input_tokens`; that is evidence of no observed hit, not
of cache unavailability. High-effort reasoning still emitted no encrypted item,
so replay remains unproven. The conflicting RGB-red image results establish one
working case and an open robustness question, without assigning a cause.

I spot-checked primary, SHA-pinned competitor code for the claims that affect
the recommended implementation: Sub2API selects the WebSocket-v2 upstream
branch without silently falling back to HTTP; codex-lb fails closed for
owner-bearing continuation inputs and normalizes the legacy web-search alias
inside nested `allowed_tools`. A current CLIProxyAPI source snapshot also
confirms that its automatic executor chooses upstream WebSocket only for a
downstream WebSocket request, while the HTTP executor strips
`previous_response_id`; it must not be cited as an HTTP-to-WebSocket bridge.

The proposed order is appropriate: retain explicit refusal for controls with
no proven equivalent; build and test a first-turn HTTP-to-WebSocket bridge with
credential-bound affinity and stale-owner failure; translate public compaction
only after preserving the verified opaque contract; and treat store,
conversations, retrieve/delete, and background as separately-owned local
services if the product elects to expose them.

No product files were changed by this review.
