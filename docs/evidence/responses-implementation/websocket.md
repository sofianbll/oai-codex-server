# WebSocket and Node SDK implementation evidence

## Commands and results

- Baseline without escalation: `bun test tests/websocket.test.ts` failed before test code with Bun `EADDRINUSE` on every `Bun.serve({ port: 0 })` fixture.
- Targeted regression with local ephemeral resources: `bun test tests/responses-node.test.ts tests/responses-websocket.test.ts tests/websocket.test.ts` passed: 16 tests, 0 failures.
- Targeted formatting: `bunx biome check tests/responses-node.test.ts tests/responses-websocket.test.ts` passed.
- Whitespace check: `git diff --check` passed.
- Reproducible shared QA proxy at `127.0.0.1:54820`: `bun run api-tests/responses/test_websocket.ts --base-url http://127.0.0.1:54820/v1 --model gpt-6-astra --key-file .local/server-token --output-dir api-tests/responses/results` produced `websocket-20260920T154311671Z.json`, exit 0. It recorded ordered `response.created` through `response.completed` events, ACK on turn 1, exact secret recall on turn 2, and no secret in turn 2's input.
- Authenticated Node SDK acceptance against the same shared QA proxy: `bun run api-tests/responses/test_node.ts --base-url http://127.0.0.1:54820/v1 --model gpt-6-astra --key-file .local/server-token --output-dir api-tests/responses/results` produced `node-20260920T154310127Z.json`. JSON, SSE and JSON-schema output passed with `openai@7.20.0`; `previous_response_id` was refused by the minimal proxy with HTTP 400 `store_not_supported`.

## DoneClaim

The server's existing WebSocket relay was exercised end to end with a two-turn native Responses frame sequence. No normalization change was justified: an initial rejected string `input` was corrected in the acceptance driver to the backend's accepted list shape. The new Node acceptance runner independently exercises JSON, SSE, structured output and native continuity reporting.

## Gaps

Node HTTP native continuity remains an open result in minimal mode. The runner now probes `previous_response_id` independently after `store:false`, then records the separate `store:true` minimal guard as unavailable. The existing `node-20260920T154310127Z.json` predates that split and proves only the `store:true` HTTP 400 `store_not_supported`; no new live call was made after this reporting correction. This does not negate the observed WebSocket continuity.

## Cleanup

Each temporary proxy was stopped with SIGINT. Reports contain redacted authentication and test-secret fields; no service was restarted and no server source changed.
