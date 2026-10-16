# Audio REST: transcription and translation qualification (#23)

## Decision and bounded evidence

**Neither operation is verified compatible.** Keep the existing unadapted relay in
both modes; do not replace missing audio inference with Responses text, Realtime,
Desktop dictation, a local engine or a paid API. `supported: true` still means
relayable, not that the account accepts the request. Discovery sends no upstream
request. No backend attempt, credential read or quota usage occurred in this work.

The [CLI research](2026-10-16-codex-compatibility-frontier.md) and
[Desktop REA findings](2026-10-16-codex-desktop-static.md) are reused, including their
partial coverage and integrity qualifications. The only additional native-source
check was the pinned CLI [endpoint module](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/mod.rs)
(0.163.0), retrieved on 2026-10-17: it exports Responses, models, images, memories,
search and Realtime clients, not Audio REST transcription or translation clients.
That module's absence is **not proof that a backend route cannot exist**. The
Desktop `/backend-api/transcribe` lead is outside the authorized prefix and remains
unusable here. Realtime audio/transcript events establish neither REST contract.

Public contracts were checked against the installed official OpenAI Node **7.20.0**
sources ([transcriptions](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/audio/transcriptions.ts),
[translations](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/audio/translations.ts))
and the [official file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text)
retrieved on 2026-10-17. These describe the public API, not Codex subscription access.

## Visible matrix

| Contract | Public behavior | Authorized mechanism / prerequisite | Current result |
| --- | --- | --- | --- |
| `POST /v1/audio/transcriptions` | Multipart audio file + model; transcript in original language | Relay only to `/backend-api/codex/audio/transcriptions`; faithful native mechanism and account access not established | Unverified, no adapter; only coordinator may spend the one synthetic attempt |
| `POST /v1/audio/translations` | Multipart audio file + model; English translation, not arbitrary target language | Relay only to `/backend-api/codex/audio/translations`; requires independent mechanism/access proof | Unverified, no adapter; **no live attempt authorized** |
| Transcription JSON / text / verbose / SRT / VTT | Formats depend on model; `whisper-1` supports timestamps/subtitles | Public options are not inferred from Codex text/realtime support | Local wire preservation only |
| Diarization / detected languages / word or segment timestamps | Model-specific fields; `diarized_json` for speaker annotations, `verbose_json` for timestamp granularities | Must actually be supplied by an established audio mechanism | Never invented or derived from file duration, text or request hints |
| File streaming | Audio `transcript.text.*` SSE, not Responses events; not `whisper-1` | Requires a compatible file-streaming model and backend | Local SSE relay only; translation has no corresponding streaming contract here |
| Files, decoding and limits | Guide: up to 25 MB; mp3/mp4/mpeg/mpga/m4a/wav/webm. SDK also lists flac/ogg | Model/backend limits remain unverified; documentation differs in listed formats | No conversion/decoding/duration detection; configured whole-request cap applies first (default 16 MiB, multipart overhead included) |
| Invalid files, unknown options and upstream failures | Backend decides semantic validity | Preserve all fields, binary bytes, status/content type/body; no automatic retry or fallback | Locally tested with controlled upstreams; not actual backend refusals |

No format is advertised as accepted by Codex. There is no new public validation
that would reject future formats or silently discard options. Existing size,
deadline, destination and authentication protections remain in force. No media URL
is fetched. There is no new persistent audio file or transcript storage.

## Clients and examples

Explorer exposes separate qualifications and form-field examples for both routes.
Select **Multipart avec fichier**, keep the example object as fields, attach the
audio to field **file**. Do not send the file name as a JSON audio input. Scalar
retains the full public multipart schemas, not a claimed supported subset.

Example only, **not permission to execute** or a claim of backend availability:

```js
import fs from 'node:fs';
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:QA_PORT/v1',
  apiKey: process.env.OAI_CODEX_TOKEN, // local proxy token, never Codex credentials
  maxRetries: 0,
});
const result = await client.audio.transcriptions.create({
  file: fs.createReadStream('synthetic.wav'),
  model: 'gpt-4o-transcribe',
  response_format: 'json',
});
console.log(result.text);
// Translation has its own endpoint/model and no authorized live probe:
// client.audio.translations.create({ file, model: 'whisper-1', response_format: 'json' })
```

The current public guide recommends `gpt-transcribe`; the frozen SDK/snapshot
contain other transcription model examples too. None establishes an eligible
Codex model. The bounded probe below selects the public `gpt-4o-transcribe`
candidate deliberately; a model/route rejection consumes the attempt and remains
an explicit prerequisite, not permission to try alternatives.

## Coordinator-only single transcription request (prepared, NOT run)

Use the already prepared local `qa-fixtures-01/speech-16000.wav`: canonical PCM WAV,
mono, 16-bit, 16 kHz, 2.289 seconds, 73,292 bytes, SHA-256
`421921ed7e454088a28b0031c45e2e680c7e21a9b8cc2ba33dd01c57e29be113`.
The synthetic spoken phrase is **“This is a local transcription test.”** No prompt
containing that phrase or language hint is sent. The 24 kHz alternative must not
be a second attempt.

Only after the coordinator chooses to spend the reserved attempt on its temporary
loopback QA instance (minimal mode; raw has the same Audio transport):

```sh
curl --silent --show-error --retry 0 --max-time 120 \
  --request POST "${QA_URL}/v1/audio/transcriptions" \
  --header "Authorization: Bearer ${OAI_CODEX_TOKEN}" \
  --form "file=@${QA_FIXTURES}/speech-16000.wav;type=audio/wav" \
  --form-string 'model=gpt-4o-transcribe' \
  --form-string 'response_format=json'
```

`QA_URL` must be the coordinator's temporary `http://127.0.0.1:<port>` instance;
`QA_FIXTURES` is its existing synthetic-fixture directory, not an uploaded URL.
Destination: exactly `POST https://chatgpt.com/backend-api/codex/audio/transcriptions`
through the existing relay, never Desktop `/backend-api/transcribe`. No redirect
following, alternate model, translation call or retry is authorized by this note.

Expected business result: HTTP success **and** an actual JSON transcript matching
the known spoken phrase (case/punctuation differences may be reported separately).
An HTTP 200 alone, empty/unrelated text, HTML, or text echoed from a prompt is not
success. Record date, proxy mode, chosen model, input hash, content type, status,
sanitized response/error and semantic verdict. Keep any returned language,
timestamps or speaker fields as received; never fill missing ones. A refusal only
bounds that request/account/date, not universal availability. A JSON success would
not verify translation, other formats, diarization, streaming or larger files.

## Local verification scope

`tests/audio-rest.test.ts` exercises the runtime's integrated gateway through the
authenticated app over loopback HTTP and SDK, using only synthetic credentials
and controlled local upstreams. A generated 10 ms silent WAV tests bytes/metadata,
**not recognition accuracy**. Fixture transcripts and timestamps are upstream test
data, never production fallbacks. Tests cover separate multipart endpoints,
repeated/unknown fields, JSON/text/SRT/VTT/diarized wire formats, Audio SSE,
400/413/415/422/429/503 errors, HTML refusal and exact whole-multipart byte limits.
Catalogue qualification has a recorded red → green through `/api/capabilities`;
unchanged relay tests are regression evidence, not a new audio implementation.

Essential unknown remains native REST equivalence/account access. This ticket
must not be reported as a verified working transcription/translation feature.

### Observed checks (2026-10-17)

- Red: `bun test tests/app.test.ts` initially returned **6 pass, 1 fail** because
  the shared Audio qualification did not distinguish original-language transcription
  from English translation or expose the REST prerequisite. Green after the
  metadata change: **7 pass**. A second red for absent form examples also became green.
- Focused SDK/HTTP + catalogue/OpenAPI checks: **21 pass**, no failures.
- Full `bun test ./tests`: **225 pass**, **0 fail**, 35 files.
- `bun run check`, `bun run build`, `bun run lint`, `git diff --check`: passed.
  Biome retains pre-existing informational `useLiteralKeys` suggestions; no lint errors.
- Real browser checks used an isolated app with synthetic local token and a relay
  that always returns 501: **no backend or credential capability exists in this
  fixture**. Explorer transcription/translation qualifications and form examples,
  multipart file selector, expanded limitations/prerequisites were observed at
  desktop 1440×1000 and mobile 390×844. No page errors or horizontal document
  overflow observed. Screenshots inspected locally, not published with user data.
- No product repair was necessary: the existing relay met the local transport
  checks. Test-fixture adjustments: one each for Bun's WAV MIME (`audio/x-wav`),
  SDK lazy `APIPromise` rejection assertions (native Promise assimilation), and
  TypeScript's FormData/SDK expected-value types. No assertion was weakened to
  turn an upstream failure into success.
- Standards self-review: no new dependency, credential destination, runtime
  transport, authentication, persistence or deployment change. Spec self-review:
  bounded prerequisite delivered, not working Audio inference. Independent
  two-axis integration review remains the coordinator's responsibility.
