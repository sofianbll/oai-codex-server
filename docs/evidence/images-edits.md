# Images edits and variations — bounded source/local evidence

Ticket #22, 2026-10-17. No live image edit/variation was attempted. The coordinator's generation budget is exhausted (1/1); its dimension mismatch is documented separately in [images-generation.md](images-generation.md). It proves nothing about edits or variations.

## Sources and faithful input mapping

Pinned Codex [ImageEditRequest](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/images.rs), [ImagesClient](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/images.rs) and [ImageReference](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/protocol/src/models.rs#L910-L916): POST JSON `images/edits`, ordered `images` array of `{image_url:string}` or `{file_id:string}`, explicit `prompt`/`model`, optional background/n/quality/size. The endpoint's own edit test serializes both a base64 data URL and `file-image`. This establishes representation, not accepted image pixels, file ownership, account entitlement or editing quality.

[OpenAI Node SDK 7.20.0](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/images.ts) always serializes `images.edit` using multipart; its public `image` uploads are not native `images` references. Minimal mode maps uploaded image bytes to inline base64 data URLs with the same bytes and order. Single `image` or repeated `image[]` fields work; mixing the names is refused. Filenames are never interpreted as filesystem paths. PNG/JPEG/WebP signatures select the MIME type; a conflicting MIME type is refused (empty/octet-stream can be inferred). This is not pixel decoding or a guarantee of valid/processable pixels.

## Contract and refusals

- `model`, nonempty `prompt`, at least one image are required. No model/defaults are injected.
- Native JSON `images` accepts canonical base64 PNG/JPEG/WebP data URLs with matching signatures or opaque `file-[A-Za-z0-9_-]+` IDs. IDs require existing authorized upstream resources; no local file lookup, upload, ownership claim or transfer of Responses/file-storage IDs is provided. Public JSON `image` is not interchangeable with native `images`.
- Background: transparent/opaque/auto; quality: low/medium/high/auto; `n`: nonnegative safe integer (native u64 serialization subset); `size`: nonempty string. These are source-backed input types, **not** verified count, dimension, quality or background effects.
- `mask`, `input_fidelity`, `response_format`, `output_format`, `output_compression`, `stream` (even false), `partial_images`, `user`, unknown fields, explicit nulls, repeated scalar fields, query parameters and content-encoded bodies return **400 unsupported_image_edit_contract** before credentials/upstream. No field is silently dropped. Mask and fidelity semantics cannot be inferred from generation.
- Native variations are not established in the bounded source inspection. Minimal POST variations returns **501 image_variation_contract_unverified** after bounded reception, before credentials/effects; no substitution with generation/editing. This is not a universal backend-impossibility claim.
- Input bytes and expanded JSON each obey `proxy.maxBodyBytes`; malformed multipart/base64/types are refused. Receipt, conversion, credentials and upstream use the existing Exchange deadline/cancellation. Base64 and signature checks do not decompress pixels or allocate image-sized pixel buffers. No temporary files, remote fetches, redirects, new credential destinations, decoder dependency or paid fallback.
- Output bytes/envelope, extra fields, HTTP failures and both request IDs retain the #21 relay behavior. No output conversion, image repair, pixel-validation or synthetic success. A truncated raw/binary response can retain the original HTTP status.
- Raw bypasses this adaptation/refusal and retains multipart/JSON bytes and unknown fields unchanged. Relayability (`supported`) remains distinct from adaptation and verified compatibility.

## SDK / Explorer examples (not permission to execute)

Use only an existing authorized proxy, model and input resource. These examples are **not live-tested** and must not be run under the exhausted image budget.

```ts
import OpenAI from "openai";
import { createReadStream } from "node:fs";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8788/v1", apiKey: process.env.OAI_CODEX_TOKEN, maxRetries: 0 });
// Local client reads the selected file; the proxy never reads this path.
await client.images.edit({
  model: "EXPLICIT_AUTHORIZED_IMAGE_MODEL", prompt: "Keep the image unchanged.",
  image: createReadStream("./selected-image.png"),
});
// SDK images.edit is multipart-only in 7.20.0. Native references use post instead:
await client.post("/images/edits", { body: {
  model: "EXPLICIT_AUTHORIZED_IMAGE_MODEL", prompt: "Keep the image unchanged.",
  images: [{ file_id: "file-existing-authorized-image" }],
} });
```

Explorer's JSON example deliberately uses a placeholder model and an existing-file prerequisite. Replace its file reference with `{image_url:"data:image/png;base64,…"}` for an inline source; do not use HTTP/file URLs. For a single upload select multipart, replace the JSON body with only `model` and `prompt`, set the file field name to `image`, then select the image file. Multiple uploads use the SDK array example rather than Explorer's single-file picker. Scalar keeps the public multipart reference and adds the bounded native JSON schema, with qualification metadata. Selecting/viewing either example makes no backend request.

## Local verification and live boundary

`bun test tests/images.test.ts` uses only integrated app/gateway and loopback upstreams with tiny known image fixtures. Checks cover ordered multipart conversion, all three signatures, native inline/file references, malformed/unsafe references, options/refusals before credentials, output bytes/errors/IDs, raw preservation, input and expanded-body limits, slow upload and cancellation. These checks establish local transport/adaptation, not editing-result fidelity.

Observed red → green: `bun test tests/images.test.ts -t 'multipart edit'` initially received multipart upstream instead of JSON, then passed with ordered inline references. `bun test tests/images.test.ts -t 'edit capabilities'` initially reported relay/no example, then passed with adaptation/source evidence and the native example. The initial variations assertion used a thenable SDK promise incorrectly; it is not reliable baseline evidence. Using `.asResponse()` verifies the explicit 501 and zero credential/upstream access.

After merging integration `55721dd0fe594d9adfbe8b0f81705852dec98357` into the ticket branch: `bun test tests/images.test.ts tests/openapi.test.ts tests/realtime-calls.test.ts` **73 pass**; `bun run test` **317 pass / 0 fail** (40 files); `bun run check`, `bun run build`, `bun run lint`, `git diff --check` pass. Lint reports 164 informational suggestions, no errors. The existing malformed-SSE fixture prints its expected parse diagnostic. Corrections were limited to the SDK assertion harness, fixture initialization/types, and updating the existing OpenAPI expectation for the new explicit adaptation; no remaining failing check.

Explorer was inspected in the native browser at desktop 1440×900 and mobile 390×844 with a temporary loopback fixture: credentials throw and every `/v1/*` call returns backend-forbidden. The native JSON example and separate adaptation/source/non-live qualifiers render; no image execution button was used. The UI's automatic model listing received only the fixture refusal. The fixture was stopped afterward. No production, credentials, quota or media backend was touched. Independent two-agent review is left to the coordinator's integration review (no subagent tool exposed to this worker).

There is **no authorized edit/variation probe to prepare or run in this lot**. A future separately authorized edit would need a known input fixture and an explicit expected pixel/content change, with model/options and actual output decoded independently; HTTP 200 or SDK parsing alone is insufficient. Masks, fidelity, response formats, n, size and variations need separate result evidence.
