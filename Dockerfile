# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.3.13

# CLI Codex officielle : le proxy lance `codex app-server` pour rafraîchir la session.
FROM --platform=$BUILDPLATFORM alpine:3 AS codex
ARG CODEX_VERSION=0.160.0
ARG TARGETARCH
# ponytail: version épinglée sans vérification sigstore ; ajouter `cosign verify-blob` avec le .sigstore publié si exigé.
RUN arch=$([ "$TARGETARCH" = arm64 ] && echo aarch64 || echo x86_64) \
 && wget -qO- "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${arch}-unknown-linux-musl.tar.gz" | tar -xz \
 && mv "codex-${arch}-unknown-linux-musl" /codex

# Dashboard et Scalar : outillage de build, absent de l'image finale.
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir /data /codex && chown bun:bun /data /codex
COPY . .
COPY --from=build /app/dist dist
COPY --from=codex /codex /usr/local/bin/codex
ENV CODEX_HOME=/codex
USER bun
VOLUME /data
EXPOSE 8788
# Première exécution : génère la config et la clé locale dans /data, puis sert sur toutes les interfaces du conteneur.
CMD ["sh", "-c", "[ -f /data/oai-codex.config.json ] || bun src/cli/main.ts init --config /data/oai-codex.config.json --host 0.0.0.0 --port 8788; exec bun src/cli/main.ts serve --config /data/oai-codex.config.json"]
