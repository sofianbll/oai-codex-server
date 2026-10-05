# Lifecycle implementation evidence

## Baseline and red/green test

- Baseline: `bun test tests/responses-lifecycle-cli.test.ts` was red before the
  runner existed (exit 2 from `uv`, missing runner/cache initialization).
- Green after adding the runner: `bun test tests/responses-lifecycle-cli.test.ts`
  passed: 1 test, 11 assertions, 2026-09-20.
- Syntax and size: `python3 -m py_compile api-tests/responses/test_lifecycle.py`
  passed; 165 non-comment/non-blank lines. `git diff --check --no-index` passed
  for the new Python runner, markdown, and test.

## Real authorized execution

```sh
uv run api-tests/responses/test_lifecycle.py \
  --scenario previous-response \
  --base-url http://100.64.0.1:8788/v1 \
  --model gpt-6-astra \
  --key-file .local/server-token \
  --output-dir api-tests/responses/results
```

Result: exit 2, `unavailable`. Redacted report:
`api-tests/responses/results/lifecycle-previous-response-20260920T153744183331Z.json`.
The first create operation raised `APIConnectionError`; no HTTP status exists,
no response resource was created, and the dependent continuation is correctly
recorded as `blocked`. This is an operational failure and leaves native
continuation compatibility open.

## Cleanup

No resource was created by the real run, so no remote cleanup action was needed.

## Fresh raw-proxy matrix

The fresh proxy supplied for QA at `http://127.0.0.1:54819/v1` was used with
the local configured token, model `gpt-6-astra`, no SDK retries, an array input
and explicit instructions. These are separate requests, with no secret or token
printed.

| Variant | Observed result | Interpretation |
| --- | --- | --- |
| `store` omitted, `stream:false` | HTTP 400, `Store must be set to false` | Invalid for this HTTP backend path; does not test continuation. |
| `store:false`, `stream:false` | HTTP 400, `Stream must be set to true` | Invalid for this HTTP backend path; does not test continuation. |
| `store:false`, `stream:true`, initial array input | Create completed | Known-valid HTTP envelope. |
| Same envelope, then `previous_response_id` | HTTP 400, `Unsupported parameter: previous_response_id` | HTTP native continuation rejected on this backend path. It does not contradict the separately observed WebSocket continuation. |

The `store:true` minimal QA probe returned `blocked` before any resource was
created; its report is `lifecycle-previous-response-20260920T154249084501Z.json`.

## Lifecycle runner integration and local execution

The runner now uses `CaptureSession` for every SDK operation and records each
raw redacted request/response, status, duration, strict response result, and
separate technical/functional verdict. It does not create local persistence.
`bun test tests/responses-lifecycle-cli.test.ts tests/responses-lifecycle-wire.test.ts`
passed: 3 tests, 70 assertions. The localhost SDK fixture drives the actual
scenario code and proves valid lifecycle flows while wrong recall, deletion,
cancellation, and ignored compaction are rejected. `python3 -m py_compile` for
the runner and scenarios, `bun run check`, and `git diff --check` also passed.

Seven fresh local reports were captured at `http://127.0.0.1:54820/v1` using
the configured local token and `gpt-6-astra`:

| Scenario | Verdict | Observed gap |
| --- | --- | --- |
| previous-response | rejected | `store=true` HTTP 400 and `previous_response_id` HTTP 400 |
| conversation | unavailable | conversation creation HTTP 403 |
| retrieve | rejected | retrieve and input-items HTTP 403 after a successful source create |
| delete | rejected | delete and deleted-resource readback HTTP 403 |
| background-cancel | unavailable | background creation HTTP 400 |
| input-tokens | unavailable | count route HTTP 403 |
| compact | rejected | compaction HTTP 404 after a successful source create |

Reports: `api-tests/responses/results/lifecycle-previous-response-20260920T160028175032Z.json`,
`lifecycle-conversation-20260920T160028746385Z.json`,
`lifecycle-retrieve-20260920T160032954337Z.json`,
`lifecycle-delete-20260920T160036327391Z.json`,
`lifecycle-background-cancel-20260920T160037165875Z.json`,
`lifecycle-input-tokens-20260920T160037745525Z.json`, and
`lifecycle-compact-20260920T160040203670Z.json`.

The last two reports above are historical only. Corrected captures are
`api-tests/responses/results/lifecycle-background-cancel-20260920T160720819536Z.json`,
whose request body has `background:true`, `store:true`, and `stream:false`, and
`api-tests/responses/results/lifecycle-compact-20260920T160532134371Z.json`,
whose request has explicit source history in `input` and no
`previous_response_id`. Both were captured before QA shutdown and copied without
rerunning any server request.

## DoneClaim

Complete for the lifecycle harness: all seven routes are exercised and gaps
produce nonzero outcomes with replayable redacted evidence. The local backend
does not currently demonstrate any persistence-dependent lifecycle capability.
