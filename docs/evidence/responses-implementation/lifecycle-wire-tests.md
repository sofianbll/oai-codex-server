# Lifecycle wire regression evidence

Date: 2026-09-20 (Europe/Paris)

The new `tests/responses-lifecycle-wire.test.ts` launches the actual `api-tests/responses/test_lifecycle.py` driver with the installed OpenAI Python SDK 3.16.2 against an ephemeral Bun HTTP server on localhost. It records incoming method, path, and JSON body; no SDK methods or scenario internals are mocked. Each lifecycle scenario is run once with expected server behavior and once with a deliberately incorrect semantic response. The runner exits 0 / reports `passed` for the expected behavior and exits 1 / reports `rejected` for the wrong behavior.

Covered scenarios: previous-response recall, two-turn conversation recall, retrieval/input-items marker correlation, delete marker and GET-404 readback, background queue/cancel/readback, and compacted-output replay. Assertions verify that previous-response/conversation follow-ups carry the returned resource identifier and do not repeat the remembered secret; compact replay carries the actual returned compact output and a new prompt, with no `previous_response_id`; background create sends `background:true, store:true, stream:false`; delete reads back 404 and treats the successful effect as functional success even though the raw GET technical status is 404. An additional delete case returns HTTP 204 with no body and confirms the follow-up GET 404 still proves deletion.

Commands and results:

- `bun test tests/responses-lifecycle-wire.test.ts` (with local-bind permission): **2 passed, 0 failed, 64 expectations**. This runs all six happy/wrong pairs plus follow-up wire-body checks and the empty-204 delete case.
- `bun run check`: **passed** (`tsc --noEmit && tsc -p tsconfig.ui.json --noEmit`).
- `bunx biome format --write tests/responses-lifecycle-wire.test.ts`: **passed**, no remaining format changes.
- `bunx biome check --max-diagnostics=50 --reporter=summary tests/responses-lifecycle-wire.test.ts`: **no errors**; 27 informational `useLiteralKeys` notes remain because this code uses required bracket access under the repository's strict index-signature typing.

The former `tests/responses-lifecycle-behavior.test.ts` was removed. It only tested `_verdict` over hardcoded boolean lists and did not exercise HTTP, SDK calls, or lifecycle behavior; the wire suite replaces that claim with observed requests and responses.

A verified SDK contract issue informed the runner fix: in OpenAI SDK 3.16.2, `client.responses.delete()` returns `None` (`cast_to=NoneType`), even when the endpoint returns a JSON delete marker. The lifecycle runner now validates `deleted:true`, matching response id/object from captured raw response JSON when present, and confirms the subsequent GET is 404; it also permits an empty successful 204 body followed by GET 404. The fixture has both JSON-marker success and empty-204 success, and a `deleted:false` wrong-response case.
