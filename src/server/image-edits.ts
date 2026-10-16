import { z } from "zod";
import { GatewayError } from "../shared/contracts";

const reference = z.union([
  z.strictObject({ image_url: z.string() }),
  z.strictObject({ file_id: z.string().regex(/^file-[A-Za-z0-9_-]+$/) }),
]);
export const imageEditSchema = z.strictObject({
  images: z.array(reference).min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  background: z.enum(["transparent", "opaque", "auto"]).optional(),
  n: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  quality: z.enum(["low", "medium", "high", "auto"]).optional(),
  size: z.string().min(1).optional(),
});

function invalid(message: string): never {
  throw new GatewayError(400, "unsupported_image_edit_contract", message);
}

function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}

export async function adaptImageEdit(
  request: Request,
  bytes: ArrayBuffer,
  maxBytes: number,
): Promise<string> {
  if (new URL(request.url).search || request.headers.has("content-encoding"))
    invalid("Query parameters and encoded request bodies are not established for image edits.");
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  let input: unknown;
  if (mediaType === "application/json") {
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      invalid("Expected a valid UTF-8 JSON image edit request.");
    }
  } else if (mediaType === "multipart/form-data") {
    let form: Awaited<ReturnType<Response["formData"]>>;
    try {
      form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
    } catch {
      invalid("Malformed image edit multipart body or boundary.");
    }
    const fields: Record<string, unknown> = {};
    const images: { image_url: string }[] = [];
    let imageField: string | undefined;
    for (const [name, value] of form) {
      if (name === "image" || name === "image[]") {
        if (imageField && imageField !== name) invalid("Do not mix image and image[] fields.");
        imageField = name;
        if (!(value instanceof File)) invalid("Image fields must contain uploaded image bytes.");
        const data = Buffer.from(await value.arrayBuffer());
        const type = imageType(data);
        if (
          !type ||
          (value.type && value.type !== "application/octet-stream" && value.type !== type)
        )
          invalid("Uploaded images require matching PNG, JPEG or WebP signatures and MIME types.");
        images.push({ image_url: `data:${type};base64,${data.toString("base64")}` });
      } else {
        if (!["prompt", "model", "background", "n", "quality", "size"].includes(name))
          invalid(
            "Unsupported image edit option; mask, input_fidelity, formats and streaming need separate proof. No fields were discarded.",
          );
        if (Object.hasOwn(fields, name) || typeof value !== "string")
          invalid("Image edit options must be single text fields.");
        if (name === "n") {
          if (!/^\d+$/.test(value)) invalid("n must be an unsigned integer.");
          fields[name] = Number(value);
        } else fields[name] = value;
      }
    }
    input = { ...fields, images };
  } else invalid("Image edits require application/json or multipart/form-data.");

  const parsed = imageEditSchema.safeParse(input);
  if (!parsed.success)
    invalid(
      "Expected nonempty images, prompt and model with only native background, n, quality and size. Masks, input_fidelity, response/output formats, streaming and unknown options are not established; none were discarded.",
    );
  for (const image of parsed.data.images) {
    if (!("image_url" in image)) continue;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      image.image_url,
    );
    if (!match)
      invalid(
        "Inline references must be PNG/JPEG/WebP base64 data URLs, never remote URLs or filesystem paths.",
      );
    const data = Buffer.from(match[2] ?? "", "base64");
    if (data.toString("base64") !== match[2] || imageType(data) !== match[1])
      invalid("Invalid base64 encoding or mismatched image signature.");
  }
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body) > maxBytes)
    throw new GatewayError(
      413,
      "body_too_large",
      "Encoded image edit exceeds the upstream body limit",
    );
  return body;
}
