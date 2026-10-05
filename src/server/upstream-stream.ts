import { GatewayError } from "../shared/contracts";

type StreamPolicy = {
  readonly maxBytes?: number;
  readonly overflowStatus?: number;
  readonly complete?: boolean;
  /** Corps remis tel quel au serveur HTTP (et non relu par le proxy). */
  readonly direct?: boolean;
  readonly sse?: boolean;
};

function sseError(reason: unknown): Uint8Array {
  const error =
    reason instanceof GatewayError
      ? { code: reason.code, message: reason.message }
      : { code: "upstream_unavailable", message: "Upstream stream failed" };
  return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
}

export class Exchange {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly downstream: AbortSignal;
  private readonly cancel: () => void;

  constructor(downstream: AbortSignal, timeoutMs: number) {
    this.downstream = downstream;
    this.cancel = () =>
      this.controller.abort(new GatewayError(499, "request_aborted", "Client disconnected"));
    this.timer = setTimeout(() => {
      this.controller.abort(
        new GatewayError(504, "upstream_timeout", "Upstream request exceeded its timeout"),
      );
    }, timeoutMs);
    downstream.addEventListener("abort", this.cancel, { once: true });
    if (downstream.aborted) this.cancel();
  }

  close(): void {
    clearTimeout(this.timer);
    this.downstream.removeEventListener("abort", this.cancel);
  }

  async wait<T>(pending: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const cancel = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([pending, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  wrap(body: ReadableStream<Uint8Array>, policy: StreamPolicy = {}): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const signal = this.controller.signal;
    const downstream = this.downstream;
    let bytes = 0;
    let settled = false;
    let onAbort = () => {};
    const finish = () => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (policy.complete) this.close();
    };
    // Bun.serve ne transmet pas l'erreur d'un corps de réponse : le client voit une fin propre
    // et Bun lève un rejet non géré (arrêt du process). Un corps direct est donc terminé ici,
    // avec un événement SSE `error` que les SDK OpenAI convertissent en APIError.
    // ponytail: un corps direct non-SSE tronqué finit sans signal ; couper la connexion si Bun l'expose.
    const fail = (controller: ReadableStreamDefaultController<Uint8Array>, reason: unknown) => {
      if (!policy.direct) return controller.error(reason);
      if (policy.sse && !downstream.aborted) controller.enqueue(sseError(reason));
      controller.close();
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        onAbort = () => {
          if (settled) return;
          finish();
          fail(controller, signal.reason);
          void reader.cancel(signal.reason).catch((error: unknown) => {
            if (!(error instanceof Error)) throw error;
          });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (settled) return;
          if (chunk.done) {
            finish();
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (policy.maxBytes !== undefined && bytes > policy.maxBytes) {
            throw new GatewayError(
              policy.overflowStatus ?? 502,
              "body_too_large",
              "Body exceeds the configured byte limit",
            );
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          if (settled) return;
          finish();
          this.controller.abort(error);
          fail(controller, error);
        }
      },
      cancel: async (reason: unknown) => {
        finish();
        this.controller.abort(reason);
        await reader.cancel(reason);
      },
    });
  }
}
