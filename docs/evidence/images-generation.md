# Images generation: source contract and local evidence

Issue: [#21](https://github.com/sofianbll/oai-codex-server/issues/21). Local fixtures checked on 2026-10-17. The coordinator separately reported the single authorized live generation at **2026-10-16T22:27:36.855Z**: an image was generated, but **dimension fidelity failed**. Image budget **1/1 exhausted; no retry authorized**. This worker made no live call and accessed no credentials, quota or production.

## Decision

Keep `POST /v1/images/generations` as the existing relay in both minimal and raw modes. The native request and public SDK already share a JSON route and compatible core fields. An adapter would add no established equivalence. Do not wrap the response, filter unknown keys, select a model implicitly, fetch returned URLs or fabricate output. Edit/mask/variation contracts belong to #22, not this change.

Primary sources inspected:

- [Native structs, pinned 83086188](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/images.rs).
- [Native endpoint and examples, same revision](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/images.rs).
- [Public Node SDK 7.20.0](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/images.ts), also installed locally.
- [Existing bounded CLI/Desktop research](../research/2026-10-16-codex-compatibility-frontier.md). No repeated artifact audit.
- [Current official Codex image-generation guide](https://developers.openai.com/codex/image-generation.md), checked on 2026-10-17: built-in generation uses `gpt-image-2`. This is not a general account entitlement guarantee.

## Options and prerequisites

All values, absent fields, explicit nulls and unknown fields are transported unchanged. This is **relayability**, not universal validation or account access. No allowlist or new local refusal hides a possible backend extension.

| Field | Native source evidence | Remaining uncertainty |
| --- | --- | --- |
| `prompt` | Required string | Prompt limits and policy remain backend-dependent |
| `model` | Required string; native tests include `gpt-image-1.5` and `gpt-image-2` | One coordinator-account generation observed with `gpt-image-2`; no `gpt-image-1.5` or general entitlement established. Public SDK allows omission but this proxy supplies no default |
| `background` | Optional `transparent`, `opaque`, `auto` | Opaque result observed for the one request; other transparency/model/format combinations not verified |
| `n` | Optional unsigned integer | `n:1` returned one image; accepted range and multiple-image generation not verified |
| `quality` | Optional `low`, `medium`, `high`, `auto` | `low` was accepted in the single request, not independently calibrated. Public `standard`, `hd`, `xhigh`, `max` are not in the pinned native enum; none removed or downgraded |
| `size` | Optional string | **Requested `1024x1024`, decoded `1374x1145`: failed fidelity.** Declared/requested size must not substitute for decoded dimensions. Other dimensions and `auto` not verified |
| `output_format`, `output_compression` | Not in native request struct | PNG/JPEG/WebP transport checked locally; backend selection/compression not established |
| `response_format` | Not in native request struct | Native response requires base64; URL mode not established, never downloaded server-side |
| `stream`, `partial_images` | Native client buffers a JSON response, not an image SSE API | Public streaming fixture/abort works as transport only; no native streaming claim |
| `moderation`, `style`, `user` | Not in native request struct | Passed through; no policy, style or identity equivalence inferred |
| Nulls, unknown fields | Not evidence of native acceptance | Retained, including unknown nested structures; refusal/status/body remain upstream-owned |

An eligible Codex account, image model entitlement and backend access under the existing fixed Codex prefix are prerequisites. Source code is not account authorization. No Desktop `/wham/images` destination, paid API fallback or separate resource is introduced.

Native response: `created` plus `data[].b64_json`, optional per-image `generation_id` and top-level background/quality/size. Additional `usage`, `output_format` and future metadata are retained rather than projected through the narrower Rust struct. Both outer `x-request-id` and nested `x-codex-imagegen-request-id` survive, including errors.

## Local verification

`bun test tests/images.test.ts` uses the actual app and runtime-injected Responses gateway with a loopback upstream and public OpenAI Node SDK, no private helper tests.

- OpenAPI exposes a relay with runtime evidence scoped to the coordinator report, qualified options and the bounded example (also consumed by Explorer). Availability intentionally remains `source-backed`, not `verified`, because the dimension acceptance criterion failed; `supported:true` still means relayability only. Original pinned source evidence remains linked.
- Minimal/raw preserve native JSON, unknown nested options and nulls; preserve envelope, usage, generation ID and both request IDs.
- A known 1×1 opaque white PNG is decoded through zlib to its grayscale/alpha scanline. Separate 1×1 white JPEG/WebP fixtures preserve every base64-decoded byte. All three fixtures were independently decoded by the installed Edge browser (PNG pixels `[255,255,255,255]`, JPEG/WebP dimensions `1×1`). These tiny fixtures **do not** claim a backend-generated image or requested 1024/1536 dimensions.
- Format/compression/moderation/partial-image options stay unchanged. An upstream binary PNG remains binary via SDK `.asResponse()`, not invented Images JSON.
- 400/403/429/503 errors keep their codes, parameter and request IDs, with one upstream attempt. Oversized requests get 413 before generation; a stalled generation gets 504; SDK stream cancellation reaches upstream without retry.
- A malformed image envelope remains unchanged: the SDK does not validate pixels. No image URL is fetched. Transport acceptance alone never marks this operation compatible.
- Explorer was rendered against a credentials-free local fixture in Edge at 1440px and 390px: the generation qualification and expanded option limitations are visible, with no document-level horizontal overflow. Local screenshots: `artifacts/qa/images-generation-{1440,390}.png` (ignored QA output, not committed).

Existing transport bounds still apply: `maxBodyBytes` limits request bytes; streamed image replies are not decoded or fully buffered by the proxy and do **not** have a total response-byte cap. Consumers choosing buffered JSON must bound their own memory; the existing deadline and cancellation close the upstream. No local output resizing, decompression or temporary media storage is added.

## Single coordinator live observation — image generated, dimensions failed

The coordinator executed the one authorized attempt through the temporary loopback QA instance in **minimal** mode at **2026-10-16T22:27:36.855Z**. **Budget 1/1 exhausted. Do not execute this example again without a new authorization.** No worker retry, edit, variation, resource creation or extra format probe is authorized.

Exact request: `POST /v1/images/generations`, `Content-Type: application/json`:

```json
{
  "model": "gpt-image-2",
  "prompt": "A single solid blue circle centered on a plain white background. No text.",
  "n": 1,
  "quality": "low",
  "size": "1024x1024",
  "background": "opaque"
}
```

Historical preparation used `gpt-image-1.5` from a pinned native generation example; it was not executed or proof of entitlement. The coordinator selected `gpt-image-2` using the current official guide; pinned native tests also include it. All other request values were unchanged. Unestablished `output_format`, `response_format` and streaming parameters were omitted.

Expected business result: exactly one genuinely decodable **1024×1024 opaque image**, a blue circle centered on white, no text. Native envelope expected: `created` plus one `data[].b64_json`; extra fields remain preserved.

Sanitized result reported by the coordinator (not independently re-run by this worker):

- HTTP **200**, `application/json`, one base64 image; browser decoded an opaque RGB PNG of **1,027,860 bytes**.
- Actual dimensions **1374×1145**, not requested **1024×1024**. Dimension contract **FAILED**; requested or declared size metadata is not evidence of pixel dimensions.
- Coordinator visual inspection: blue circle centered on white, no text. Pixel analysis: approximately **34.3% blue**, **65.5% white**, opaque alpha. Image-generation/content result observed; this does not cancel the dimension failure.
- No local resize, crop, transcoding or metadata correction is applied to manufacture compliance. Raw remains an unadapted relay.
- This establishes only the observed model/account/date/request combination. It does not establish other options/models/qualities/formats/sizes, edits, masks, variations or streaming.

The private report and image remain with the coordinator; no private artifact paths, hashes, tokens or image bytes are published here. Generation is now runtime-observed, **not fully OpenAI-compatible**. #21 must not be represented as verified dimension fidelity or full compatibility.
