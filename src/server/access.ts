import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GatewayError } from "../shared/contracts";

export async function loadServerToken(path: string, create = false): Promise<string> {
  if (create) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, `${randomBytes(32).toString("base64url")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
      throw new GatewayError(500, "invalid_server_token", "La clé du serveur est invalide.");
    await chmod(path, 0o600);
    return token;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      500,
      "server_token_missing",
      "Clé du serveur introuvable. Utilisez oai-codex init.",
    );
  }
}

export function authorized(request: Request, expected: string): boolean {
  let value = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";
  if (!value && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const protocols =
      request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((part) => part.trim()) ?? [];
    value =
      protocols
        .find((protocol) => protocol.startsWith("oai-codex-token."))
        ?.slice("oai-codex-token.".length) ?? "";
  }
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function checkOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
