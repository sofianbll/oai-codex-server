import { expect, test } from "bun:test";
import OpenAI from "openai";
import { errorResponse } from "../src/server/app";
import { createResponsesGateway } from "../src/server/responses-gateway";
import type { ProxyOptions } from "../src/shared/contracts";

const offer = "v=0\r\ns=LOCAL_SYNTHETIC_OFFER\r\n";
const answer = "v=0\r\ns=LOCAL_SYNTHETIC_ANSWER\r\n";

function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  overrides: Partial<ProxyOptions> = {},
) {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const gateway = createResponsesGateway(
    {
      baseUrl: `${upstream.url.origin}/backend-api/codex`,
      translationMode: "minimal",
      defaultModel: "fixture",
      clientVersion: "fixture",
      maxBodyBytes: 4096,
      timeoutMs: 1000,
      ...overrides,
    },
    async () => ({ accessToken: "native-secret", accountId: "fixture-account" }),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        return await gateway.forward(request);
      } catch (error) {
        return errorResponse(error);
      }
    },
  });
  return {
    url: `${server.url.origin}/v1`,
    close() {
      gateway.close();
      server.stop(true);
      upstream.stop(true);
    },
  };
}

test("SDK WebRTC multipart preserves session fields in Codex JSON and returns a local call identity", async () => {
  let received: unknown;
  let url = "";
  let headers = new Headers();
  const local = fixture(async (request) => {
    url = request.url;
    headers = request.headers;
    received = await request.json();
    return new Response(answer, {
      status: 201,
      headers: {
        "content-type": "application/sdp",
        location:
          "https://chatgpt.com/backend-api/codex/realtime/calls/calls/rtc_fixture?secret=private",
      },
    });
  });
  try {
    const client = new OpenAI({ baseURL: local.url, apiKey: "local-only", maxRetries: 0 });
    const result = await client.realtime.calls.create({
      sdp: offer,
      session: { type: "realtime", model: "fixture-model", instructions: "Do not speak." },
    });
    expect(result.status).toBe(201);
    expect(await result.text()).toBe(answer);
    expect(received).toEqual({
      sdp: offer,
      session: { type: "realtime", model: "fixture-model", instructions: "Do not speak." },
    });
    expect(new URL(url).pathname).toBe("/backend-api/codex/realtime/calls");
    expect(new URL(url).search).toBe("");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer native-secret");
    expect(result.headers.get("location")).toBe("/v1/realtime/calls/rtc_fixture");
    expect(result.headers.get("cache-control")).toBe("no-store");
  } finally {
    local.close();
  }
});

test("native JSON preserves opaque session options and explicit routing query without creating an identity", async () => {
  let received: unknown;
  let query = "";
  const local = fixture(async (request) => {
    received = await request.json();
    query = new URL(request.url).search;
    return new Response(answer, {
      headers: { location: "/v1/live/019eb97d-8e9a-7ff3-94b0-ea019babd5d7" },
    });
  });
  try {
    const body = { sdp: offer, session: { future: { nested: [null, false, "é"] } } };
    const result = await fetch(`${local.url}/realtime/calls?intent=quicksilver&architecture=avas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(received).toEqual(body);
    expect(query).toBe("?intent=quicksilver&architecture=avas");
    expect(result.headers.get("location")).toBe(
      "/v1/realtime/calls/019eb97d-8e9a-7ff3-94b0-ea019babd5d7",
    );
    expect(await result.text()).toBe(answer);
  } finally {
    local.close();
  }
});

test("SDK without session uses the source-established SDP-only request", async () => {
  let received = "";
  let headers = new Headers();
  const local = fixture(async (request) => {
    headers = request.headers;
    received = await request.text();
    return new Response(answer, { headers: { location: "/realtime/calls/rtc_sdp_only" } });
  });
  try {
    const client = new OpenAI({ baseURL: local.url, apiKey: "local-only", maxRetries: 0 });
    const result = await client.realtime.calls.create({ sdp: offer });
    expect(headers.get("content-type")).toBe("application/sdp");
    expect(received).toBe(offer);
    expect(await result.text()).toBe(answer);
  } finally {
    local.close();
  }
});

test("invalid sessions, duplicate/unknown multipart parts and oversized offers fail before upstream", async () => {
  let calls = 0;
  const local = fixture(() => {
    calls++;
    return new Response("must not run");
  });
  try {
    for (const body of [
      { sdp: "", session: {} },
      { sdp: offer, session: null },
      { sdp: offer, session: [] },
      { sdp: offer, session: { id: "native-id-not-an-input" } },
      { sdp: offer, extra: true },
    ]) {
      const result = await fetch(`${local.url}/realtime/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(400);
      expect(await result.text()).not.toContain(offer.trim());
    }
    for (const extra of ["sdp", "unknown"]) {
      const form = new FormData();
      form.set("sdp", offer);
      form.append(extra, "private");
      const result = await fetch(`${local.url}/realtime/calls`, { method: "POST", body: form });
      expect(result.status).toBe(400);
      await result.text();
    }
    for (const body of [
      "{",
      JSON.stringify({ sdp: offer, session: { instructions: "x".repeat(4096) } }),
    ]) {
      const result = await fetch(`${local.url}/realtime/calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(result.status).toBe(body === "{" ? 400 : 413);
      await result.text();
    }
    expect(calls).toBe(0);
  } finally {
    local.close();
  }
});

test("upstream errors retain their status/body but never leak a Location destination", async () => {
  const local = fixture(() =>
    Response.json(
      { error: { code: "rollout_required", message: "Authorized rollout required" } },
      { status: 403, headers: { location: "https://private.invalid?token=private" } },
    ),
  );
  try {
    const result = await fetch(`${local.url}/realtime/calls`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: offer,
    });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({
      error: { code: "rollout_required", message: "Authorized rollout required" },
    });
    expect(result.headers.get("location")).toBeNull();
  } finally {
    local.close();
  }
});

test("missing or unsafe returned call identity fails without exposing native Location or SDP", async () => {
  for (const location of [
    null,
    "https://private.invalid/calls?secret=private",
    "/calls/rtc_%2Fprivate",
  ]) {
    const local = fixture(() => new Response(answer, { headers: location ? { location } : {} }));
    try {
      const result = await fetch(`${local.url}/realtime/calls`, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: offer,
      });
      expect(result.status).toBe(502);
      const error = await result.text();
      expect(error).toContain("invalid_realtime_location");
      expect(error).not.toContain("private");
      expect(error).not.toContain("LOCAL_SYNTHETIC");
    } finally {
      local.close();
    }
  }
});

test("raw calls and unadapted controls keep bytes, identities, query and failures unchanged", async () => {
  for (const mode of ["raw", "minimal"] as const) {
    let received = "";
    let path = "";
    const local = fixture(
      async (request) => {
        received = await request.text();
        path = new URL(request.url).pathname;
        return new Response("control not established", {
          status: 409,
          headers: { location: "/native/private" },
        });
      },
      { translationMode: mode },
    );
    try {
      const suffix = mode === "raw" ? "/realtime/calls" : "/realtime/calls/rtc_existing/hangup";
      const result = await fetch(`${local.url}${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "opaque-untouched",
      });
      expect(received).toBe("opaque-untouched");
      expect(path).toBe(`/backend-api/codex${suffix}`);
      expect(result.status).toBe(409);
      expect(result.headers.get("location")).toBe("/native/private");
      expect(await result.text()).toBe("control not established");
    } finally {
      local.close();
    }
  }
});

test("browser FormData JSON blobs preserve future session options without unbounded JSON expansion", async () => {
  const received: unknown[] = [];
  const local = fixture(async (request) => {
    received.push(await request.json());
    return new Response(answer, { headers: { location: "/calls/rtc_browser" } });
  });
  try {
    const form = new FormData();
    form.set("sdp", new Blob([offer], { type: "application/sdp" }));
    form.set("session", new Blob(['{"future":{"keep":null}}'], { type: "application/json" }));
    const result = await fetch(`${local.url}/realtime/calls`, { method: "POST", body: form });
    expect(result.status).toBe(200);
    expect(received).toEqual([{ sdp: offer, session: { future: { keep: null } } }]);
    await result.text();

    const expanding = new FormData();
    expanding.set("sdp", "\u0001".repeat(1000));
    expanding.set("session", "{}");
    const rejected = await fetch(`${local.url}/realtime/calls`, {
      method: "POST",
      body: expanding,
    });
    expect(rejected.status).toBe(413);
    expect(received.length).toBe(1);
    await rejected.text();
  } finally {
    local.close();
  }
});

test("call deadline aborts a stalled native response without retrying", async () => {
  let calls = 0;
  const local = fixture(
    async () => {
      calls++;
      await Bun.sleep(150);
      return new Response(answer, { headers: { location: "/calls/rtc_late" } });
    },
    { timeoutMs: 30 },
  );
  try {
    const result = await fetch(`${local.url}/realtime/calls`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: offer,
    });
    expect(result.status).toBe(504);
    expect(await result.text()).not.toContain("LOCAL_SYNTHETIC");
    expect(calls).toBe(1);
  } finally {
    local.close();
  }
});

test("oversized SDP answer is rejected before returning a partial successful negotiation", async () => {
  const local = fixture(
    () =>
      new Response("x".repeat(4097), {
        headers: { location: "/calls/rtc_oversized", "content-type": "application/sdp" },
      }),
  );
  try {
    const result = await fetch(`${local.url}/realtime/calls`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: offer,
    });
    await result.text().catch(() => "");
    expect(result.status).toBe(502);
  } finally {
    local.close();
  }
});

test("non-UTF8 native answer is not exposed as a successful SDP negotiation", async () => {
  const local = fixture(
    () =>
      new Response(Uint8Array.of(0xff), {
        headers: { location: "/calls/rtc_invalid" },
      }),
  );
  try {
    const result = await fetch(`${local.url}/realtime/calls`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: offer,
    });
    expect(result.status).toBe(502);
    expect(await result.text()).toContain("invalid_realtime_sdp");
  } finally {
    local.close();
  }
});
