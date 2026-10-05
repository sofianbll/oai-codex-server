# Responses feature-driver typing evidence

The feature driver now uses the OpenAI SDK's `ResponseCreateParamsNonStreaming`, `FunctionToolParam`, `ResponseInputItemParam`, and `ResponseReasoningItemParam` types at request construction boundaries. Payload composition mutates a TypedDict rather than widening SDK kwargs to a plain dict. JSON redaction parses and serializes through Pydantic `JsonValue`/the SDK payload adapter, and reasoning/input records are validated by the SDK TypedDict adapters before use.

Validation used the PEP 723 dependencies already declared by the scripts (`openai==3.16.2`, Pydantic 2, Typer); no project dependency was added. The checker must run from the scripts' own directory because `features.py` is a directly executed script that imports its sibling `test_features.py` as a top-level module:

```sh
cd api-tests/responses
UV_CACHE_DIR=/private/tmp/responses-lifecycle-uv-cache uv run --with openai==3.16.2 --with 'pydantic>=2,<3' --with 'typer>=0.16,<1' --with basedpyright basedpyright --pythonversion 3.11 --level error features.py test_features.py
```

Result: `0 errors, 0 warnings, 0 notes`. Running the same check from the repository root reports one `reportImplicitRelativeImport` diagnostic at `features.py:22`, because the checker models the file as a package module while runtime invokes it as a script. From the script directory the import is correctly resolved, and no suppression or type-ignore is needed.

```sh
bun test tests/responses-features.test.ts
```

Result: 6 passed, 0 failed, 54 assertions. These local fixtures cover JSON-schema output validation, tool loop and parallel calls, encrypted-reasoning redaction, API/transport failures, malformed/non-JSON responses, and unavailable reasoning behavior. No backend calls were made.
