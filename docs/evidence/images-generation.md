# Images generation: source contract and local evidence

Issue: [#21](https://github.com/sofianbll/oai-codex-server/issues/21). Observed locally on 2026-10-17; **no live generation, credentials, quota or production access**.

## Decision

Keep `POST /v1/images/generations` as the existing relay in both minimal and raw modes. The native request and public SDK already share a JSON route and compatible core fields. An adapter would add no established equivalence. Do not wrap the response, filter unknown keys, select a model implicitly, fetch returned URLs or fabricate output. Edit/mask/variation contracts belong to #22, not this change.

Primary sources inspected:

- [Native structs, pinned 83086188](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/images.rs).
- [Native endpoint and examples, same revision](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/images.rs).
- [Public Node SDK 7.20.0](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/images.ts), also installed locally.
- [Existing bounded CLI/Desktop research](../research/2026-10-16-codex-compatibility-frontier.md). No repeated artifact audit.

## Options and prerequisites

All values, absent fields, explicit nulls and unknown fields are transported unchanged. This is **relayability**, not universal validation or account access. No allowlist or new local refusal hides a possible backend extension.

| Field | Native source evidence | Remaining uncertainty |
| --- | --- | --- |
| `prompt` | Required string | Prompt limits and policy remain backend-dependent |
| `model` | Required string; native tests include `gpt-image-1.5` and `gpt-image-2` | No account/model entitlement established; public SDK allows omission but this proxy supplies no default |
| `background` | Optional `transparent`, `opaque`, `auto` | Transparency/model/format combinations not verified |
| `n` | Optional unsigned integer | Accepted range and multiple-image generation not verified |
| `quality` | Optional `low`, `medium`, `high`, `auto` | Public `standard`, `hd`, `xhigh`, `max` are not in the pinned native enum; none removed or downgraded |
| `size` | Optional string | Source example `1024x1536` is not proof of all dimensions or `auto`; requested output dimensions must be checked live |
| `output_format`, `output_compression` | Not in native request struct | PNG/JPEG/WebP transport checked locally; backend selection/compression not established |
| `response_format` | Not in native request struct | Native response requires base64; URL mode not established, never downloaded server-side |
| `stream`, `partial_images` | Native client buffers a JSON response, not an image SSE API | Public streaming fixture/abort works as transport only; no native streaming claim |
| `moderation`, `style`, `user` | Not in native request struct | Passed through; no policy, style or identity equivalence inferred |
| Nulls, unknown fields | Not evidence of native acceptance | Retained, including unknown nested structures; refusal/status/body remain upstream-owned |

An eligible Codex account, image model entitlement and backend access under the existing fixed Codex prefix are prerequisites. Source code is not account authorization. No Desktop `/wham/images` destination, paid API fallback or separate resource is introduced.

Native response: `created` plus `data[].b64_json`, optional per-image `generation_id` and top-level background/quality/size. Additional `usage`, `output_format` and future metadata are retained rather than projected through the narrower Rust struct. Both outer `x-request-id` and nested `x-codex-imagegen-request-id` survive, including errors.

## Local verification

`bun test tests/images.test.ts` uses the actual app and runtime-injected Responses gateway with a loopback upstream and public OpenAI Node SDK, no private helper tests.

- OpenAPI exposes a source-backed relay, qualified options and the bounded example (also consumed by Explorer).
- Minimal/raw preserve native JSON, unknown nested options and nulls; preserve envelope, usage, generation ID and both request IDs.
- A known 1×1 opaque white PNG is decoded through zlib to its grayscale/alpha scanline. Separate 1×1 white JPEG/WebP fixtures preserve every base64-decoded byte. All three fixtures were independently decoded by the installed Edge browser (PNG pixels `[255,255,255,255]`, JPEG/WebP dimensions `1×1`). These tiny fixtures **do not** claim a backend-generated image or requested 1024/1536 dimensions.
- Format/compression/moderation/partial-image options stay unchanged. An upstream binary PNG remains binary via SDK `.asResponse()`, not invented Images JSON.
- 400/403/429/503 errors keep their codes, parameter and request IDs, with one upstream attempt. Oversized requests get 413 before generation; a stalled generation gets 504; SDK stream cancellation reaches upstream without retry.
- A malformed image envelope remains unchanged: the SDK does not validate pixels. No image URL is fetched. Transport acceptance alone never marks this operation compatible.
- Explorer was rendered against a credentials-free local fixture in Edge at 1440px and 390px: the generation qualification and expanded option limitations are visible, with no document-level horizontal overflow. Local screenshots: `artifacts/qa/images-generation-{1440,390}.png` (ignored QA output, not committed).

Existing transport bounds still apply: `maxBodyBytes` limits request bytes; streamed image replies are not decoded or fully buffered by the proxy and do **not** have a total response-byte cap. Consumers choosing buffered JSON must bound their own memory; the existing deadline and cancellation close the upstream. No local output resizing, decompression or temporary media storage is added.

## Single live probe prepared for the coordinator — NOT EXECUTED

Reserve exactly one attempt, `maxRetries: 0`, through the temporary loopback QA instance in **minimal** mode. Use only its local proxy token, not a separate OpenAI key. No retry, edit, variation, resource creation or extra format probe.

Exact request: `POST /v1/images/generations`, `Content-Type: application/json`:

```json
{
  "model": "gpt-image-1.5",
  "prompt": "A single solid blue circle centered on a plain white background. No text.",
  "n": 1,
  "quality": "low",
  "size": "1024x1024",
  "background": "opaque"
}
```

`gpt-image-1.5` comes from the pinned native generation example, not a discovered account entitlement. Intentionally omit unestablished `output_format`, `response_format` and streaming parameters.

Expected business result: exactly one genuinely decodable **1024×1024 opaque image**, a blue circle centered on white, no text. Inspect actual decoded pixels/rendering, not just a 200 or SDK parse. Record actual format, dimensions, envelope fields, model, mode, timestamp and sanitized request IDs. Expected native envelope is `created` plus one `data[].b64_json`; preserve extra fields.

If refused or malformed, record status/code/message and unmet prerequisite without retry; if response has no decodable image or violates the prompt/dimensions, report business failure. A refusal is scoped to this account/model/request/date, not universal impossibility. Until that probe is observed, backend generation and account availability remain **unverified**, and #21 must not be represented as verified compatibility.
