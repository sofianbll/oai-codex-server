# Lifecycle Python typing verification

The read-only audit found SDK request payload type errors in `lifecycle_scenarios.py`; the lifecycle finisher transferred ownership for correcting that file. The correction uses SDK `ResponseCreateParamsStreaming` and `ResponseInputParam` types, narrows captured response values before accessing IDs, and validates dynamically returned compact/input items at the SDK boundary. It removes the generic `**fields` forwarding in favor of the one explicit `previous_response_id` option used by the scenario.

The scenario module now passes scoped basedpyright by itself with **0 errors, 0 warnings, 0 notes**. The final combined check, run from `api-tests/responses` with Python 3.12, OpenAI SDK 3.16.2, Pydantic 2, Typer, Rich, HTTPX2, and basedpyright provided ephemerally, reports **0 errors, 5 warnings, 0 notes**:

```sh
UV_CACHE_DIR=/private/tmp/responses-lifecycle-uv-cache uv run --python 3.12 --with openai==3.16.2 --with 'pydantic>=2,<3' --with 'typer>=0.16,<1' --with 'rich>=14,<15' --with 'httpx2>=0.3' --with basedpyright basedpyright --pythonversion 3.12 lifecycle_capture.py lifecycle_scenarios.py test_lifecycle.py
```

Remaining warnings are outside the changed scenario module: `lifecycle_capture.py:125` and `:208` have exhaustive-pattern comparisons on `Never`; `test_lifecycle.py:30` and `:37` lack annotations on `model_config`; `test_lifecycle.py:76` discards an integer result.

Local lifecycle fixtures validate the wire behavior and CLI:

```sh
bun test tests/responses-lifecycle-wire.test.ts tests/responses-lifecycle-cli.test.ts tests/responses-lifecycle-capture.test.ts
```

Result: **4 passed, 0 failed, 84 assertions**. The wire tests verify previous-response linkage, conversation turns, compact output replay, deletion, and behavior failure classification. No live backend calls were made.
