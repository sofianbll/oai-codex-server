import type { ActivityEntry } from "../shared/contracts";

export function createActivity(limit: number) {
  let total = 0;
  let active = 0;
  let failed = 0;
  const entries: ActivityEntry[] = [];

  function begin(request: Request) {
    total += 1;
    active += 1;
    const id = crypto.randomUUID();
    const started = performance.now();
    let finished = false;
    const initial: ActivityEntry = {
      id,
      method: request.method,
      path: new URL(request.url).pathname.slice(0, 256),
      status: 0,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      bytes: 0,
      state: "active",
    };
    entries.unshift(initial);
    entries.splice(limit);
    function finish(status: number, bytes: number, state: ActivityEntry["state"]) {
      if (finished) return;
      finished = true;
      active -= 1;
      if (status >= 400 || state === "failed") failed += 1;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0)
        entries[index] = {
          ...initial,
          status,
          bytes,
          state,
          durationMs: Math.round(performance.now() - started),
        };
    }
    return { finish };
  }

  function observe(response: Response, transaction: ReturnType<typeof begin>): Response {
    if (!response.body) {
      transaction.finish(response.status, 0, "completed");
      return response;
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            transaction.finish(
              response.status,
              bytes,
              response.status >= 400 ? "failed" : "completed",
            );
            controller.close();
          } else {
            bytes += chunk.value.byteLength;
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          transaction.finish(response.status, bytes, "aborted");
          controller.error(error);
        }
      },
      async cancel(reason: unknown) {
        transaction.finish(response.status, bytes, "aborted");
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return { begin, observe, entries: () => [...entries], stats: () => ({ total, active, failed }) };
}

export type Activity = ReturnType<typeof createActivity>;
