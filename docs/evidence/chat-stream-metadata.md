# Chat SSE native metadata classification

## Observations and limits

The coordinator's single Chat SSE probe on 2026-10-16 failed with
`unsupported_chat_output`. Its detailed error and native events were not retained.
A different, authorized Responses SSE probe subsequently succeeded: 15 events,
text before the terminal, the expected synthetic marker and a completed response.
That separate event pattern included `response.metadata` between the last text
delta and `response.output_text.done`.

No additional backend request was made for this diagnosis. Replaying the retained
15-event shape through a controlled local WebSocket, the integrated gateway and
OpenAI Node 7.20.0 Chat reproduced:

```text
unsupported_chat_output: Unsupported Chat stream event: response.metadata
```

This establishes a local adapter defect reachable with an observed native event
pattern. It does **not** establish the cause of the original Chat probe, whose
events remain unavailable. Original live Chat has not been retried; the local fix
is not a new live compatibility result.

## Isolation and fix

- Red minimized exchange: `response.created`, `response.metadata`,
  `response.completed` containing ordinary assistant text.
- Removing only `response.metadata` made that exchange green.
- Keeping the event type with an empty metadata payload remained red. The payload,
  response identity and terminal text were not the cause of this local refusal.
- The Chat event classifier explicitly recognizes this native, non-content
  envelope. It emits no fabricated content, refusal, model change or Chat event.
  Terminal output, actual Response identity, usage and errors remain authoritative.
- The shared Responses pipeline is unchanged: it still preserves this event and
  unidentified extensions. Raw remains an unadapted relay. Chat still refuses
  unknown event types, unsupported structured output and conflicting tool IDs.

The original 15-event replay and minimized exchange passed after one repair cycle.
The committed regression is a small synthetic projection of the observed event
pattern: fixture identities, synthetic text and usage, no private trace, original
identifiers, original moderation payload, ciphertext or machine paths. A second SDK check
covers native metadata headers without replacing Response identity, and a failed
terminal after metadata remains an error. The Responses gateway regression checks
that `response.metadata` and unknown extensions remain exposed unchanged.

```sh
bun test tests/chat-stream.test.ts --test-name-pattern 'retained native text'
bun test tests/chat-stream.test.ts tests/chat-json.test.ts tests/responses-safety.test.ts
```

## Primary sources

- [Codex frozen source, revision 132c2be](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/codex-api/src/sse/responses.rs):
  `turn_state`, `model_verifications`, `turn_moderation_metadata`, `response_model`
  and their dispatch distinguish native state/model/moderation metadata from
  generated output. This source snapshot is not proof of the current backend's
  complete event vocabulary.
- [Codex test helpers at the same revision](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/core/tests/common/responses.rs):
  `ev_model_verification_metadata` uses the same native event type.
- OpenAI Node [Responses event union](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/responses/responses.ts)
  and [Chat chunks](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/chat/completions/completions.ts):
  no public `response.metadata` event or corresponding Chat metadata delta. Its
  native spelling does not make it a public generated-content event.
