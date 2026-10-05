import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { refreshCodexSession } from "../src/server/codex-refresh";
import { createCredentialStore } from "../src/server/credentials";

const now = 1_800_000_000_000;
const freshExpiry = now / 1000 + 3600;
const jwt = (exp: number) =>
  `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
let home = "";
const save = async (token: string, accountId = "test-account") => {
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: token,
        account_id: accountId,
        refresh_token: "private-refresh",
        id_token: "private-identity",
      },
    }),
  );
};
const createStore = (refresh = async () => {}) =>
  createCredentialStore(home, { now: () => now, refresh });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-credentials-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("Codex credential file boundary", () => {
  test("reads current credentials when the auth file is valid", async () => {
    // Given
    await save(jwt(freshExpiry));
    const store = createStore();
    // When
    const credentials = await store.get();
    // Then
    expect(credentials).toEqual({ accessToken: jwt(freshExpiry), accountId: "test-account" });
  });

  test("rereads renewed credentials when Codex updates the file", async () => {
    // Given
    await save(jwt(freshExpiry));
    const store = createStore();
    await store.get();
    await save(jwt(freshExpiry + 60));
    // When
    const credentials = await store.get();
    // Then
    expect(credentials.accessToken).toBe(jwt(freshExpiry + 60));
  });

  test("refreshes once when concurrent callers encounter an expired token", async () => {
    // Given
    await save(jwt(now / 1000 - 1));
    let refreshes = 0;
    const store = createStore(async () => {
      refreshes++;
      await save(jwt(freshExpiry));
    });
    // When
    const credentials = await Promise.all(Array.from({ length: 12 }, () => store.get()));
    // Then
    expect(refreshes).toBe(1);
    expect(credentials.every((value) => value.accessToken === jwt(freshExpiry))).toBe(true);
  });

  test("reports unavailable without refreshing when the token is expired", async () => {
    // Given
    const expired = now / 1000 - 1;
    await save(jwt(expired));
    let refreshes = 0;
    const store = createStore(async () => {
      refreshes++;
    });
    // When
    const status = await store.status();
    // Then
    expect(status).toEqual({ available: false, expiresAt: new Date(expired * 1000).toISOString() });
    expect(refreshes).toBe(0);
  });

  test("exposes only readiness and expiry when session metadata contains secrets", async () => {
    // Given
    await save(jwt(freshExpiry));
    // When
    const status = await createStore().status();
    // Then
    expect(status).toEqual({
      available: true,
      expiresAt: new Date(freshExpiry * 1000).toISOString(),
    });
  });

  test.each([
    null,
    "malformed",
    JSON.stringify({ tokens: {} }),
    JSON.stringify({
      auth_mode: "apikey",
      tokens: {
        access_token: "private",
        account_id: "private-account",
      },
    }),
  ])("fails with sanitized status when file content is %j", async (content) => {
    // Given
    if (content !== null) await writeFile(join(home, "auth.json"), content);
    const store = createStore();
    // When
    const status = await store.status();
    // Then
    expect(status).toEqual({ available: false, expiresAt: null });
    await expect(store.get()).rejects.toMatchObject({
      status: 503,
      code: "codex_auth_unavailable",
    });
  });

  test("rejects credentials when the account changes during refresh", async () => {
    // Given
    await save(jwt(now / 1000 - 1));
    const store = createStore(async () => {
      await save(jwt(freshExpiry), "another-account");
    });
    // When / Then
    await expect(store.get()).rejects.toMatchObject({ code: "codex_account_changed" });
  });

  test("rejects stale credentials when refresh completes without a new token", async () => {
    // Given
    await save(jwt(now / 1000 - 1));
    // When / Then
    await expect(createStore().get()).rejects.toMatchObject({ code: "codex_auth_expired" });
  });

  test("sanitizes refresh failures when the subprocess returns private details", async () => {
    // Given
    await save(jwt(now / 1000 - 1));
    const store = createStore(async () => {
      throw new Error("private-token and private-path");
    });
    // When
    const error: unknown = await store.get().catch((failure: unknown) => failure);
    // Then
    expect(error).toMatchObject({ code: "codex_refresh_failed" });
    expect(error instanceof Error && error.cause === undefined).toBe(true);
    expect(String(error)).not.toContain("private");
  });

  test.each(["opaque-token", "header.invalid.signature", jwt(Number.MAX_VALUE)])(
    "defers expiry to upstream when token is opaque or unparseable: %s",
    async (token) => {
      // Given
      await save(token);
      // When
      const status = await createStore().status();
      // Then
      expect(status).toEqual({ available: true, expiresAt: null });
    },
  );
});

describe("official app-server refresh transport", () => {
  const script = (response: string) => `
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { createInterface } = require("node:readline");
    writeFileSync(join(process.env.CODEX_HOME, "pid.json"), JSON.stringify(process.pid));
    writeFileSync(join(process.env.CODEX_HOME, "home.json"), JSON.stringify(process.env.CODEX_HOME));
    const messages = [];
    createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line); messages.push(request);
      if (request.method === "initialize") process.stdout.write(JSON.stringify({id: 1, result: {}}) + "\\n");
      if (request.method === "account/read") {
        writeFileSync(join(process.env.CODEX_HOME, "requests.json"), JSON.stringify(messages));
        ${response}
      }
    });
    setInterval(() => {}, 1000);
  `;

  test.each([false, true])(
    "negotiates refresh and terminates its child when the home is relative: %s",
    async (relativeHome) => {
      // Given
      const command: readonly [string, ...string[]] = [
        process.execPath,
        "-e",
        script(
          'process.stdout.write(JSON.stringify({id: 2, result: {account: {type: "chatgpt"}}}) + "\\n");',
        ),
        "--",
      ];
      // When
      await refreshCodexSession(relativeHome ? relative(process.cwd(), home) : home, {
        command,
        timeoutMs: 1000,
      });
      // Then
      expect(JSON.parse(await readFile(join(home, "home.json"), "utf8"))).toBe(home);
      const requests: unknown = JSON.parse(await readFile(join(home, "requests.json"), "utf8"));
      expect(requests).toEqual([
        {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "oai_codex_gateway", version: "0.1.0" },
            capabilities: null,
          },
        },
        { method: "initialized" },
        { id: 2, method: "account/read", params: { refreshToken: true } },
      ]);
      const pid = z
        .number()
        .int()
        .parse(JSON.parse(await readFile(join(home, "pid.json"), "utf8")));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  test.each([
    'process.stdout.write("malformed\\n");',
    'process.stdout.write(JSON.stringify({id: 2, error: {message: "private-session"}}) + "\\n");',
    'process.stdout.write("x".repeat(1048577));',
    "process.exit(0);",
    'process.on("SIGTERM", () => {});',
  ])("fails safely and terminates its child when protocol response is %s", async (response) => {
    // Given
    const command: readonly [string, ...string[]] = [
      process.execPath,
      "-e",
      script(response),
      "--",
    ];
    // When
    const error: unknown = await refreshCodexSession(home, { command, timeoutMs: 1000 }).catch(
      (failure: unknown) => failure,
    );
    // Then
    expect(error).toMatchObject({ code: "codex_refresh_failed" });
    expect(String(error)).not.toContain("private-session");
    const pid = z
      .number()
      .int()
      .parse(JSON.parse(await readFile(join(home, "pid.json"), "utf8")));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
