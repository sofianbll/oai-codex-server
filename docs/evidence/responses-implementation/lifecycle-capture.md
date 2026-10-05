# Responses lifecycle capture helper

Added `api-tests/responses/lifecycle_capture.py`, a reusable wrapper around the official `openai==3.16.2` SDK. `CaptureSession.call()` invokes a caller-supplied SDK operation with retries disabled; `CaptureSession.stream()` consumes Responses events through `response.completed`. `CapturedRun` returns the SDK value and a frozen `CaptureReport` with request method/URL/headers/body, response status/content type/body, duration, error class, strict `Response` schema result, stream completion, and separate technical/behavior verdicts.

The SDK-owned HTTP hooks read and replay response bodies so normal SDK parsing and stream iteration continue. Reports redact authorization and non-allowlisted headers, known supplied secrets, credential-like text, sensitive JSON fields, and sensitive URL query values. Strict schema validation runs only when requested for successful JSON operations; the stream helper requires and validates the completed response. Generic SDK operations omit response validation.

## Evidence

- `bun test tests/responses-lifecycle-capture.test.ts`: **1 pass**, 9 assertions. It uses a temporary localhost Bun fixture and official SDK subprocess; no Codex backend calls occur.
- The fixture covered strict JSON create, completed SSE, a generic models call, a non-JSON HTTP 422 error, a malformed HTTP 200 response rejected by strict schema validation, request credential redaction, and separate technical/behavior verdicts.
- `python3 -m py_compile api-tests/responses/lifecycle_capture.py`: passed.
- `basedpyright --pythonversion 3.12 api-tests/responses/lifecycle_capture.py`: 0 errors; 2 warnings report unreachable `assert_never` patterns after exhaustive matches.
- `git diff --check` on the two implementation files: passed.
- `bun run check` currently fails in peer-owned `tests/responses-features.test.ts` at lines 117 and 215 (WebSocket server generic arity and index-signature property access). It reports no diagnostic in this helper test.

The TypeScript and Python LSP servers are unavailable in this environment; no global LSP installation was performed. Python helper code is held to 250 nonblank, non-comment/non-docstring lines.
