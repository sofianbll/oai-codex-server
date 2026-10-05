import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { GatewayError } from "../shared/contracts";

const messageSchema = z.object({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export function refreshCodexSession(
  codexHome: string,
  options: {
    readonly command?: readonly [string, ...string[]];
    readonly timeoutMs?: number;
  } = {},
): Promise<void> {
  const [executable, ...prefix] = options.command ?? ["codex"];
  const args = [
    "app-server",
    "--stdio",
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    "analytics.enabled=false",
    "-c",
    "features.remote_control=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.plugin_hooks=false",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...prefix, ...args], {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        CODEX_HOME: resolvePath(codexHome),
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      },
    });
    let complete = false;
    let completionError: GatewayError | undefined;
    let buffer = "";
    let received = 0;
    let expectedId = 1;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const failure = () =>
      new GatewayError(
        503,
        "codex_refresh_failed",
        "Renouvellement Codex impossible. Reconnectez-vous dans Codex.",
      );
    const finish = (error?: GatewayError) => {
      if (complete) return;
      complete = true;
      completionError = error;
      clearTimeout(timeout);
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill("SIGTERM");
      forceStop = setTimeout(() => {
        child.kill("SIGKILL");
      }, 500);
      forceStop.unref();
    };
    const timeout = setTimeout(() => finish(failure()), options.timeoutMs ?? 20_000);
    child.once("error", () => finish(failure()));
    child.once("close", () => {
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
      if (!complete || completionError) reject(completionError ?? failure());
      else resolve();
    });
    child.stdin.on("error", () => finish(failure()));
    child.stdout.on("error", () => finish(failure()));
    const send = (message: object) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const consume = (line: string) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (error) {
        if (error instanceof SyntaxError) {
          finish(failure());
          return;
        }
        throw error;
      }
      const parsed = messageSchema.safeParse(json);
      if (!parsed.success) {
        finish(failure());
        return;
      }
      const message = parsed.data;
      if (message.id === undefined && message.method) return;
      if (
        message.id !== expectedId ||
        !Object.hasOwn(message, "result") ||
        Object.hasOwn(message, "error")
      ) {
        finish(failure());
        return;
      }
      if (expectedId === 1) {
        expectedId = 2;
        send({ method: "initialized" });
        send({ id: 2, method: "account/read", params: { refreshToken: true } });
      } else finish();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (complete) return;
      received += Buffer.byteLength(chunk);
      if (received > 1_048_576) {
        finish(failure());
        return;
      }
      buffer += chunk;
      for (
        let newline = buffer.indexOf("\n");
        newline !== -1 && !complete;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) consume(line);
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "oai_codex_gateway", version: "0.1.0" },
        capabilities: null,
      },
    });
  });
}
