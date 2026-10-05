# Temporary QA proxy runtime

Started 2026-09-20 from current checkout source using `bun run src/cli/main.ts ... serve` in two persistent terminal sessions. These are temporary QA instances on loopback; no existing service was restarted or modified. Keep them running until the team lead explicitly requests cleanup.

| Mode | Base URL | PID | Persistent terminal session | Config |
| --- | --- | ---: | ---: | --- |
| minimal | `http://127.0.0.1:54820/v1` | 46947 | 70969 | `/var/folders/0_/1mcnsfdn41z6sltt2pmtqcrc0000gn/T/responses-qa-JmwH7v/minimal.json` |
| raw | `http://127.0.0.1:54819/v1` | 46946 | 99450 | `/var/folders/0_/1mcnsfdn41z6sltt2pmtqcrc0000gn/T/responses-qa-JmwH7v/raw.json` |

Both configs were cloned from `<repo>/oai-codex.config.json`. They preserve model `gpt-6-astra`, upstream URL `https://chatgpt.com/backend-api/codex`, client version and limits; set `host=127.0.0.1`, `port=0`, disable dashboard/docs, and select their respective translation mode. `auth.codexHome` and `auth.tokenFile` are absolute paths: `~/.codex` and `<repo>/.local/server-token`. The access token value was not emitted or copied. Temporary config/log/PID files are under `/var/folders/0_/1mcnsfdn41z6sltt2pmtqcrc0000gn/T/responses-qa-JmwH7v/` with restrictive file modes.

## Verification

Verified from an escalated local request process so loopback/network access was not confused with sandbox denial:

- Both `/health` endpoints returned HTTP 200 and `{"status":"ok","service":"oai-codex"}`.
- Authorized `GET /v1/models` to minimal mode returned HTTP 200 and IDs `gpt-6-astra`, `gpt-reserve`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and `codex-auto-review`.
- Authorized `GET /v1/models` to raw mode returned HTTP 400 from upstream: required query field `client_version` was missing. This is an observed mode-specific models-list result, not a listener/auth failure. The live Responses workers can still target `/v1/responses` directly; do not count raw model listing as verified success.
- `lsof` observed Bun listeners on the two assigned ephemeral ports with PIDs above after checks. The original failed detached launch processes had exited; those were replaced by these persistent sessions and are not part of the runtime set.

## Access details for test workers

Use the relevant base URL above and the configured model `gpt-6-astra`. For SDK calls, use the local server key file `<repo>/.local/server-token`; do not print it or paste it into reports. The matching Codex auth lives at `~/.codex`. Config provenance is the current repo config noted above, cloned to temporary files with only listener/auth-path/mode/dashboard/docs changes. Sessions remain active pending explicit cleanup from `/root`.

## Cleanup receipt

Cleanup requested by `/root` after live provider verification completed, 2026-09-20. Sent SIGINT to only owned terminal sessions: raw session `99450` (PID `46946`, port `54819`) and minimal session `70969` (PID `46947`, port `54820`). Both terminal sessions returned exit code 0. Follow-up `lsof` checks found no listener on either owned port. Existing user service remained untouched; `127.0.0.1:8788` was still listening as PID `45253` at the check.

Before deleting the adversarial test directories, verified report copies existed as JSON and checked only their metadata/top-level keys: `docs/evidence/responses-implementation/websocket-independent.json` (3,251 bytes) and `node-independent.json` (1,364 bytes). Then removed only `/private/tmp/responses-adversarial-ws` and `/private/tmp/responses-adversarial-node`; follow-up existence checks returned false. Removed the owned cloned QA config/log directory `/var/folders/0_/1mcnsfdn41z6sltt2pmtqcrc0000gn/T/responses-qa-JmwH7v`; follow-up existence check returned false. The user token file, Codex auth home, repo source, and user service were not removed or changed.
