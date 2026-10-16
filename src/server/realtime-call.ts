import { GatewayError } from "../shared/contracts";

function invalid(): never {
  throw new GatewayError(
    400,
    "invalid_realtime_call",
    "Expected a nonempty SDP offer and an optional JSON session object; duplicate or unknown envelope fields and session.id are not supported",
  );
}

// Only the envelope changes: session options and protocol selection remain the caller's responsibility.
export async function realtimeCallBody(bytes: ArrayBuffer, headers: Headers) {
  const type = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type === "application/sdp") {
    if (!bytes.byteLength) invalid();
    return { body: bytes, contentType: "application/sdp" };
  }
  let sdp: unknown;
  let session: unknown;
  let hasSession = false;
  try {
    if (type === "multipart/form-data") {
      const form = await new Request("http://local", {
        method: "POST",
        headers,
        body: bytes,
      }).formData();
      for (const key of form.keys()) {
        if (!["sdp", "session"].includes(key) || form.getAll(key).length !== 1) invalid();
      }
      const part = form.get("sdp");
      sdp = part instanceof Blob ? await part.text() : part;
      hasSession = form.has("session");
      if (hasSession) {
        const value = form.get("session");
        session = JSON.parse(value instanceof Blob ? await value.text() : String(value));
      }
    } else if (type === "application/json") {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
      if (Object.keys(value).some((key) => !["sdp", "session"].includes(key))) invalid();
      sdp = "sdp" in value ? value.sdp : undefined;
      hasSession = "session" in value;
      session = "session" in value ? value.session : undefined;
    } else {
      throw new GatewayError(
        415,
        "unsupported_realtime_media_type",
        "Use multipart/form-data, application/json or application/sdp for call creation",
      );
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    invalid();
  }
  if (typeof sdp !== "string" || !sdp.trim()) invalid();
  if (!hasSession) return { body: sdp, contentType: "application/sdp" };
  if (typeof session !== "object" || session === null || Array.isArray(session) || "id" in session)
    invalid();
  return { body: JSON.stringify({ sdp, session }), contentType: "application/json" };
}

export function realtimeCallLocation(headers: Headers) {
  const location = headers.get("location");
  const path = location?.split(/[?#]/)[0];
  const id = path?.split("/").filter(Boolean).at(-1);
  if (
    !id ||
    !/^(?:rtc_[A-Za-z0-9_-]+|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(id)
  ) {
    throw new GatewayError(
      502,
      "invalid_realtime_location",
      "Realtime call response is missing a valid call identity",
    );
  }
  headers.set("location", `/v1/realtime/calls/${id}`);
}
