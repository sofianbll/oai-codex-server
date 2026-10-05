# Responses gap comparison

Request: identify what currently fails, inspect mature Codex-compatible competitors, determine missing translations, fixes, or intrinsic limits.

Research first: do not introduce persistence, alternative providers, or execute downloaded code. Source-backed findings are hypotheses until reproduced with our session.

Hypotheses:
- H1: some failures are our path, header, tool naming or payload translation mistakes; compare outbound evidence with Codex official and competitor code.
- H2: native Codex exposes a narrower contract, while competitors emulate public API state or switch transport; identify exact implementation and persistence semantics.
- H3: apparent failures are incomplete test preconditions or misleading observations; inspect original status/body and expected result.

Tasks:
- [x] Local failing evidence audit (Luna).
- [x] CLIProxyAPI/Plus source comparison (Luna).
- [x] Sub2API/codex-lb source comparison (Terra).
- [x] Official contract and candidate maturity comparison (root).
- [x] Consolidated fix/translate/defer matrix and skeptical verification.
- [x] Cleanup temporary source checkouts and archive team evidence.

The initial research changed only evidence and owned temporary source downloads. The user’s later cache instruction authorized the focused gateway and benchmark fixes recorded below; the existing service was left running.

## User steering: cache diagnosis and implementation

The user requires the same method for every issue: check for local defects, inspect resolved competitor implementations, compare, define and apply a clean solution. Cache is now the active priority; the general matrix remains relevant and is not the final cache verdict.

- [x] Audit actual local service, cache request integrity and usage reporting (Luna).
- [x] Compare current CLIProxyAPI cache code/resolved issues (Luna).
- [x] Compare current Sub2API/codex-lb cache code/resolved issues (Terra).
- [x] Trace official Codex cache identity/header/transport behavior (root).
- [x] Controlled A/B reproducer against the verified runtime (Terra).
- [x] Implement only the evidence-supported correction with failing-first regression coverage.
- [x] Verify actual cache behavior and independent review; reconcile unresolved native conditions honestly.
- [x] Cleanup all diagnostic resources and archive team state.
