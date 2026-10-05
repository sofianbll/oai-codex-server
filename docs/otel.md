# Observer la CLI Codex avec OpenTelemetry

La CLI Codex exporte nativement en OTLP (crate `codex-rs/otel`). Aucune instrumentation du proxy n'est nécessaire : on fait écrire ces événements dans un fichier par un collecteur local.

**Ce qu'on obtient :** la carte du flux. Endpoints appelés, statuts HTTP, types d'événements SSE/WebSocket (`event.kind`), durées, appels d'outils, récupération d'authentification.
**Ce qu'on n'obtient pas :** les corps et les en-têtes. Pour le contenu filaire, faire passer la CLI par le proxy en mode `raw`.

## 1. Démarrer le collecteur

```sh
docker compose --profile otel up -d otel     # écoute 127.0.0.1:4318, écrit otel/out/codex-otel.jsonl
```

## 2. Activer l'export dans `~/.codex/config.toml`

Syntaxe vérifiée dans `codex-rs/config/src/types.rs` (`OtelConfigToml`, `OtelExporterKind`) :

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "json" } }
log_user_prompt = false   # true ajoute le texte des prompts aux événements
```

## 3. Lire

```sh
# Séquence des événements d'une session
jq -r '.resourceLogs[]?.scopeLogs[].logRecords[].attributes
  | map({(.key): (.value.stringValue // .value.intValue)}) | add
  | [."event.name", ."event.kind", .endpoint, ."http.response.status_code"] | @tsv' otel/out/codex-otel.jsonl

# Types d'événements SSE/WebSocket vus : à comparer après chaque mise à jour de Codex
jq -r '.resourceLogs[]?.scopeLogs[].logRecords[].attributes[] | select(.key=="event.kind") | .value.stringValue' \
  otel/out/codex-otel.jsonl | sort | uniq -c
```
