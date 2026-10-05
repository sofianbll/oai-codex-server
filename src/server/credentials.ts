import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type CredentialProvider,
  GatewayError,
  type UpstreamCredentials,
} from "../shared/contracts";
import { refreshCodexSession } from "./codex-refresh";

const authSchema = z.object({
  auth_mode: z.literal("chatgpt").optional(),
  tokens: z.object({
    access_token: z
      .string()
      .min(1)
      .max(65536)
      .regex(/^[\x21-\x7e]+$/),
    account_id: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[\x21-\x7e]+$/),
  }),
});
const expirySchema = z.object({ exp: z.number().min(0).max(8_640_000_000_000) });
type Session = { readonly credentials: UpstreamCredentials; readonly expiresMs: number | null };

function expiryFromToken(token: string): number | null {
  const segments = token.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) return null;
  try {
    // JWT expiry is a display/refresh hint; upstream alone validates the signature.
    const parsed = expirySchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data.exp * 1000 : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readSession(codexHome: string): Promise<Session> {
  try {
    const auth = authSchema.parse(JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")));
    return {
      credentials: { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id },
      expiresMs: expiryFromToken(auth.tokens.access_token),
    };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      503,
      "codex_auth_unavailable",
      "Session Codex indisponible. Connectez-vous dans Codex.",
    );
  }
}

export function createCredentialStore(
  codexHome: string,
  options: {
    readonly refresh?: (codexHome: string) => Promise<void>;
    readonly now?: () => number;
  } = {},
): {
  readonly get: CredentialProvider;
  readonly status: () => Promise<{
    readonly available: boolean;
    readonly expiresAt: string | null;
  }>;
} {
  const refresh = options.refresh ?? refreshCodexSession;
  const now = options.now ?? Date.now;
  let refreshing: Promise<void> | undefined;
  const expired = (session: Session) => session.expiresMs !== null && session.expiresMs <= now();
  const sameAccount = (before: Session, after: Session) => {
    if (before.credentials.accountId !== after.credentials.accountId) {
      throw new GatewayError(
        503,
        "codex_account_changed",
        "Le compte Codex a changé pendant le renouvellement. Réessayez.",
      );
    }
  };
  const renew = async (before: Session) => {
    const latest = await readSession(codexHome);
    sameAccount(before, latest);
    if (expired(latest)) {
      await refresh(codexHome).catch(() => {
        throw new GatewayError(
          503,
          "codex_refresh_failed",
          "Renouvellement Codex impossible. Reconnectez-vous dans Codex.",
        );
      });
    }
  };
  return {
    get: async () => {
      const before = await readSession(codexHome);
      if (!expired(before)) return before.credentials;
      refreshing ??= renew(before).finally(() => {
        refreshing = undefined;
      });
      await refreshing;
      const after = await readSession(codexHome);
      sameAccount(before, after);
      if (expired(after)) {
        throw new GatewayError(
          503,
          "codex_auth_expired",
          "Session Codex expirée. Reconnectez-vous dans Codex.",
        );
      }
      return after.credentials;
    },
    status: async () => {
      try {
        const session = await readSession(codexHome);
        return {
          available: !expired(session),
          expiresAt: session.expiresMs === null ? null : new Date(session.expiresMs).toISOString(),
        };
      } catch (error) {
        if (error instanceof GatewayError) return { available: false, expiresAt: null };
        throw error;
      }
    },
  };
}
