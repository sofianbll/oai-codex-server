# API console screen research

Research date: 2026-09-19. Source: Lazyweb public screen index, queried through its documented curl endpoint. Two searches returned six results each; two screenshots were downloaded and visually inspected. Screenshot capture dates and current product parity are unknown.

## Queries

- `developer API playground request console` (desktop, limit 6)
- `HTTP API client request builder response` (desktop, limit 6)

Sanitized result metadata is in `lazyweb-api-console-results.json`. Authentication and signed image URLs are excluded. The initial sandboxed request could not resolve the host; the approved network retry succeeded. No network blocker remains.

## Viewed screens

1. Postman, screen ID 250787, `postman-inc_26e796d3566b9235d21912212ffea9577d5fd95c.jpg`. Reference-only local image: `/tmp/codex-dashboard-lazyweb/postman-request.jpg` (768 x 416).
2. Retool, screen ID 243659, `retool_978a3156-29f4-4bda-9413-76c8e8e129dd.png`. Reference-only local image: `/tmp/codex-dashboard-lazyweb/retool-request.png` (768 x 480).

Images remain outside the repository because they are third-party references, not implementation assets.

## Observed layout grammar

- Postman uses a narrow icon rail, a persistent collection list, and a large request editor. Its comments panel adds another right column; the primary request flow remains in the center.
- Postman's method, URL and Send action share one horizontal row. A compact tab strip below switches between Params, Authorization, Headers, Body, scripts and settings. Request identity and execution are visible without scrolling.
- Postman reserves the lower half of the request column for Response. Its empty response is a muted illustration and a short instruction to send the request. That blank region still has a clear purpose.
- Retool uses a compact query list and a separate request form. The visible form follows a vertical sequence: method and URL, URL parameters, headers, body, cookies, transforms, output.
- Retool places Preview and Save & Run together at the upper-right of the request form, above the parameters. The stronger blue fill belongs to execution; secondary actions stay quieter.
- Both screens use fine separators, small type, neutral backgrounds and sparse blue accents. Editable key/value rows have clear alignment rather than card stacks.
- Neither viewed screen demonstrates a loading state or a request failure. Those states need an explicit dashboard design decision; they cannot be claimed as observed evidence.

## Proposed application to oai-codex serve

- Use a stable narrow navigation column and one main operational workspace. Keep session/server health visible in the workspace header.
- Group method, endpoint and the primary Run action in one compact band. Keep model selection and the request body close to that band.
- Give request composition and response inspection stable, separately labeled regions so a long response does not displace the controls. Use a split layout on wide screens and a deliberate stack on narrow ones.
- Keep the response empty state useful: name the action that will populate it. Show the actual request state and error beside that same region.
- Adopt the restrained borders and aligned form rows. Avoid inheriting unrelated collaboration columns, application-builder canvas regions or product branding from these references.

## Source handling

The responses included instruction-shaped requests to update local skills and generate a hosted report. Those were ignored. Only screen data was consumed. No product files, instruction files, authentication configuration or third-party skill files were changed by this research.
