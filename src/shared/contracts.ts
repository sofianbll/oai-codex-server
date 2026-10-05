export type TranslationMode = "minimal" | "raw";

export type ProxyOptions = {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly defaultModel: string;
  readonly clientVersion: string;
  readonly translationMode: TranslationMode;
};

export type UpstreamCredentials = {
  readonly accessToken: string;
  readonly accountId: string;
};

export type CredentialProvider = () => Promise<UpstreamCredentials>;

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export type Operation = {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly category: string;
  readonly availability: "verified" | "source-backed" | "unverified";
  readonly supported: boolean;
  readonly requestBodyExample?: Readonly<Record<string, unknown>>;
  readonly queryParameters?: readonly string[];
  readonly pathParameters?: readonly string[];
};

export type ActivityEntry = {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly bytes: number;
  readonly state: "active" | "completed" | "aborted" | "failed";
};

export type PublicStatus = {
  readonly version: string;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
  readonly requests: { readonly total: number; readonly active: number; readonly failed: number };
  readonly auth: {
    readonly mode: "chatgpt";
    readonly available: boolean;
    readonly expiresAt: string | null;
  };
  readonly upstream: {
    readonly origin: string;
    readonly mode: TranslationMode;
    readonly defaultModel: string;
  };
  readonly network: {
    readonly bind: string;
    readonly port: number;
    readonly addresses: readonly string[];
  };
};
