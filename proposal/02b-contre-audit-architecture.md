# Contre-audit — `proposal/02-architecture.md`

20/09/2026, lecture seule stricte : aucun fichier du projet modifié, aucun serveur démarré. Méthode : relecture directe de `src/**` et recomptage indépendant du snapshot `codex-contract-atlas/snapshot/openapi.json` avec le filtre de `catalog.ts:34-41`.

## 1. Verdict

Globalement exact ; une erreur chiffrée, un composant manquant, plusieurs invariants partiels.

- **Fiable — le comptage du catalogue.** J'ai recompté 224 chemins de premier niveau dans le snapshot (recherche `^ {4}"/` → 224) et, avec le filtre exact de `catalog.ts:34-41`, **38 opérations HTTP** (audio 9 + images 3 + live 7 + models 3 + realtime 9 + responses 7) + le WebSocket `catalog.ts:111-120` = **39**. Les répartitions du §4 sont justes et **les 17 comptes de lignes du tableau §3 sont exacts** (`app.ts` 150, `access.ts` 55, `upstream.ts` 163, `upstream-stream.ts` 102, `response-adapter.ts` 142, `credentials.ts` 133, `codex-refresh.ts` 146, `catalog.ts` 121, `openapi.ts` 146, `websocket.ts` 195, `config.ts` 115, `activity.ts` 86, `static.ts` 25, `contracts.ts` 75, `main.ts` 84, `lifecycle.ts` 191, `options.ts` 96).
- **Faux** : le §4 annonce **32 opérations `unverified`** ; le compte réel est **33**.
- **Incomplet de façon matérielle** : `src/server/runtime.ts` (98 lignes) est absent du tableau §3 alors qu'il porte la garde d'accès WebSocket, le fichier d'état et `Bun.serve` — que le §2 attribue à `app.ts:53-65`.
- **À corriger** : « revient inchangée à l'appelant » (§2), « si le corps est bien du SSE » (§7), « même origine exigée » (§3), et le §9 qui laisse croire que le catalogue borne le relais.

## 2. Tableau de vérification

| Affirmation | Code réel | Exacte | Correction |
| --- | --- | --- | --- |
| 38 opérations HTTP + 1 WS = 39 (§3, §4) | recomptage 9+3+7+3+9+7 = 38, + 1 en `catalog.ts:111-120` | oui | — |
| « Sur 224 chemins dans le snapshot » (§4) | 224 clés `^ {4}"/` | oui | — |
| audio 9 / realtime 9 / live 7 / responses 7 / images 3 / models 3 (§4) | vérifié chemin par chemin (`/audio/*` 6 chemins → 9 ops ; `/responses/*` 6 → 7 ; `/models` 2 → 3) | oui | — |
| `verified` = `createResponse` seul ; `source-backed` = `listModels`, `createImage`, `createImageEdit`, `create-realtime-call`, + WS (§4) | `catalog.ts:49-54, 76-81` ; les 4 ids existent (snapshot l. 4653, 4291, 4176, 13026) et passent le filtre | oui | — |
| `unverified` = « toutes les autres (32 opérations) » (§4) | 38 − 1 − 4 = **33** | **non** | écrire 33 |
| Filtre = familles + « sans `?` » (`catalog.ts:34-41`) | regex `^\/(responses\|models\|images\|audio\|realtime\|live)(\/\|$)` + `!path.includes("?")` | oui | — |
| `supported:true` = routable localement, pas accepté par l'abonnement | `supported: true` en dur, `catalog.ts:99` | oui | — |
| `catalog.ts:28` lit le snapshot au démarrage | `await readFile(new URL("../../codex-contract-atlas/snapshot/openapi.json", …))`, l. 25-32 ; dossier non exclu (`.gitignore:1-18`) | oui | dépendance d'exécution confirmée |
| Corps `/api/*` borné à 64 Kio (`app.ts:68-72`) | `bodyLimit({ maxSize: 65536 })`, l. 69 | oui | — |
| 16 Mio, 120 s, 16 concurrents, 100 entrées | `config.ts:19-20, 40-41` (+ `oai-codex.config.json:8,9,19,20`) | oui | — |
| WebSocket : 64 simultanés (`websocket.ts:95`) | `connections.size + pending >= 64`, refus **503** (l. 96) | oui | préciser 503, pas 429 |
| Aucun retry / redirections non suivies (`upstream.ts:118,120`) | `retry: 0` l. 118, `redirect: "manual"` l. 120 | oui | — |
| Garde origine+jeton sur `/api/*` et `/v1/*` (`app.ts:53-65`) | l. 53-65 exact, **mais** les upgrades WS sont interceptés avant Hono (`runtime.ts:58-71`) | partielle | garde WS en `runtime.ts:62-65` |
| `authorization` remplacée (`upstream.ts:105-106`) | `headers.set("authorization", …)` | oui | voir §5.3 (`api-key`) |
| En-têtes privés supprimés (`upstream.ts:16-38`) | `privateHeaders` = l. 16-24 ; en-têtes hop = l. **6-15** | partielle | plage à corriger |
| `auth.json` relu à chaque appel (`credentials.ts:102-104`) ; expiration = indice (`:34`) ; refresh dédupliqué (`105-108`) ; changement de compte refusé (`79-87`) | `readSession` l. 103 ; commentaire l. 34 ; `refreshing ??=` l. 105-107 ; `sameAccount` l. 79-87 | oui | — |
| `publicConfig` sans `codexHome`/`tokenFile` | `config.ts:61-68` : server/proxy/dashboard/docs seuls | oui | « vérifié en direct » non rejouable (§7) |
| Journal : méthode, chemin sans query, statut, durée, taille | `activity.ts:15-24` (chemin tronqué à 256 car., l. 18) | oui | — |
| Modes `raw`/`minimal` (§7) ; `stream=true` imposé ; `store:true` refusé | `upstream.ts:89-91` ; `response-adapter.ts:22-58, 86-95, 134-141` ; l. 56 ; l. 39-44 | oui | réserve §5.5 |
| 7 contrôles serveur ; `/health` sans sécurité (`openapi.ts:100`) | `controls` l. 4-48 (health, status, config get/put, capabilities, activity, stop) ; l. 100 | oui | — |
| 5 pages + `#showcase` + `/docs` | `shell.ts:10-33` (5 routes) et l. 146 | oui | — |
| README annonce 39 ; config ignorée par git ; `start` détaché ≠ service macOS | `README.md:69` ; `.gitignore:4` ; `detached: true`/`unref()` `lifecycle.ts:140,168`, `README.md:30` | oui | — |
| Journal `.local/server.log` 0600 (`lifecycle.ts:127-129`) ; clé locale 0600/dossier 0700 re-chmodé (`access.ts:6-32`) | `open(…, "a", 0o600)` l. 129 ; `mode: 0o600` l. 12, `chmod` l. 22, `mkdir … 0o700` l. 8 | oui | — |
| État `.local/server.json` 0600 (§5) | `writeFile(…, { mode: 0o600 })`, `runtime.ts:86-90` | oui | référence absente du doc |

## 3. Références `fichier:ligne` fausses ou décalées

1. **`upstream.ts:16-38` pour « cookies/origine/hop supprimés »** (§2 l.32, §3) : les en-têtes hop sont en `upstream.ts:6-15`, 16-24 = `privateHeaders`, la fonction va jusqu'à la ligne 39.
2. **`credentials.ts:45-51` pour « `auth.json` validé par schéma »** (§3) : le schéma est en l. 11-25, la validation en l. 47 ; la plage décrit `readSession`, pas la validation.
3. **`credentials.ts:45-51` porté au §2 l.35 comme « relus à chaque appel »** : ce « à chaque appel » est en `credentials.ts:102-104` (correctement cité au §6.1, pas au §2).
4. Deux plages pour la même borne : `app.ts:66-73` (§3) et `app.ts:68-72` (§8). Les deux encadrent la ligne 69, aucune n'est fausse, mais l'écart complique la vérification.
5. Exactement vérifiées : `app.ts:53-65, 131-132`, `access.ts:36-46, 47-49, 52-55`, `upstream.ts:41-80, 105-106, 107, 118, 120`, `catalog.ts:28, 34-41, 49-54, 76-89`, `openapi.ts:100`, `websocket.ts:95`, `lifecycle.ts:127-129`.

## 4. Chiffres inexacts

| Chiffre du document | Réel | Preuve |
| --- | --- | --- |
| `unverified` = **32** (§4) | **33** | 38 − 1 `verified` (`catalog.ts:76-81`) − 4 `source-backed` (`catalog.ts:49-54`) |
| Exemples audio : 7 cités pour 9 | 9 | manquent `POST /v1/audio/translations` (snapshot l. 571) et un op de consentement : `/audio/voice_consents/{consent_id}` en porte 3 (`get` 717, `post` 756, `delete` 805) |
| Exemples realtime : 8 cités pour 9 | 9 | manque `POST /v1/realtime/translations/client_secrets` (l. 13387) |

Tous les autres chiffres sont exacts : j'ai recompté les 38 opérations une par une depuis le snapshot, et les 17 comptes de lignes du §3 coïncident avec les fichiers lus.

Fragilité non signalée : le catalogue compte **les clés de l'objet de chemin** (`catalog.ts:39-41`), pas les méthodes HTTP. Une clé `parameters` ou `summary` deviendrait une fausse opération. Sans impact aujourd'hui : seuls `get`/`post`/`delete` apparaissent sous les familles filtrées (recompté).

## 5. Invariants de sécurité mal décrits

1. **Origine : rejet conditionnel, pas exigence.** `access.ts:52-55` → `return !origin || origin === new URL(request.url).origin` : une requête **sans** en-tête `Origin` passe (curl, SDK). « même origine exigée » (§3) ne décrit que le cas d'une origine présente et différente ; il n'y a pas de refus par défaut.
2. **La porte d'accès WebSocket est dans `runtime.ts`, pas dans `app.ts`.** `runtime.ts:58-71` intercepte `upgrade` avant Hono et réapplique origine + jeton (l. 62-65) ; `app.ts:53-65` ne voit jamais le WebSocket.
3. **« supprimé puis remplacé » : vrai pour `authorization`, faux pour `api-key`.** `privateHeaders` (`upstream.ts:16-24`) liste `x-api-key` mais **pas** `api-key` : cet en-tête client part verbatim vers `chatgpt.com`.
4. **Asymétrie favorable non mentionnée** : `websocket.ts:115-127` reconstruit une liste blanche (authorization, chatgpt-account-id, openai-beta/organization/project, x-client-request-id) et ne relaie jamais le sous-protocole `oai-codex-token.*`. Le WS est plus strict que le HTTP.
5. **« En-tête SSE manquant rétabli si le corps est bien du SSE » (§7)** : le corps n'est jamais inspecté. `upstream.ts:125-127` teste seulement `response.ok` et un `content-type` absent ou `text/plain`.
6. **« revient inchangée à l'appelant » (§2)** : l'enveloppe change — `content-length` supprimé (`upstream.ts:30`), `set-cookie` et `content-encoding` supprimés (l. 35-36), `accept-encoding: identity` imposé (l. 107). En minimal, le corps de `POST /v1/responses` est désérialisé puis réécrit (`upstream.ts:97-101`, `response-adapter.ts:47-57`) : les octets ne sont pas identiques.
7. **La destination figée vient du schéma, pas de `upstream.ts`** : `config.ts:17` (`z.literal("https://chatgpt.com/backend-api/codex")`). `upstream.ts:41-80` ne vérifie que la non-sortie de `baseUrl` (l. 73-78) ; le §3 crédite uniquement `upstream.ts`.
8. **Journal plus étroit qu'annoncé** : `activity.begin` n'est appelé que sur `/v1/*` (`app.ts:133`). `/health`, `/api/*` et les refus de porte (401/403/429) n'y entrent pas, et `stats().active` — qui pilote la limite de concurrence (`app.ts:131`) — ne compte que les `/v1/*`.

## 6. Composants ou comportements importants omis

1. **`src/server/runtime.ts` (98 lignes), absent du tableau §3** : `Bun.serve` (l. 51-74), `maxRequestBodySize: config.proxy.maxBodyBytes` (l. 55), garde WS (l. 62-65), écriture de `.local/server.json` en 0600 (l. 85-90), suppression du fichier d'état au stop si le PID correspond (l. 27-39), SIGINT/SIGTERM (l. 95-96). Toute la section « Cycle de vie » du §5 s'appuie sur ce code.
2. **`src/shared/assets.d.ts`** (mineur, types d'assets).
3. **Le catalogue ne borne pas le relais** : `app.all("/v1/*", …)` (`app.ts:130`) transmet **tout** chemin `/v1/*`. Le §9 (« Pas de route Chat Completions ») est vrai pour l'annonce, faux pour le relais : `POST /v1/chat/completions` est transféré. `openapi.ts:127` le dit, le document ne le reprend pas.
4. **Bornes omises** : file WS de 1024 frames (`websocket.ts:56`), sortie du refresh plafonnée à 1 Mio (`codex-refresh.ts:122`) et 20 s (l. 73), délai CLI 1500 ms (`lifecycle.ts:64`), attente de démarrage 15 s (l. 161), attente d'arrêt 5 s (l. 99), chemin du journal tronqué à 256 car. (`activity.ts:18`), agrégation SSE plafonnée à `maxBodyBytes` (`upstream.ts:136`), déconnexion client → 499 (`upstream-stream.ts:18`).
5. **Permissions de la configuration** : `oai-codex.config.json` est écrit en 0600, atomiquement par `rename` (`config.ts:88-89` ; à l'init `options.ts:66-69`). Le §5 documente les permissions des autres fichiers, pas celle-là.
6. **`PUT /api/config` ne peut toucher ni `auth` ni `limits`** : `app.ts:110-118` n'accepte que `server`, `proxy`, `dashboard`, `docs` (`z.strictObject`) puis fusionne et revalide (l. 119-120). Invariant réel, non mentionné.
7. **Fusion des chemins dans la spec servie** : `POST` et `GET /v1/responses` cohabitent (`catalog.ts:94-96, 111-120` ; `openapi.ts:71-91`) → 39 opérations réparties sur 34 chemins.
8. **En-têtes globaux** `nosniff`, `referrer-policy`, `x-frame-options: DENY` et `cache-control: no-store` sauf `/v1/*` (`app.ts:46-51`).

## 7. Ce que je n'ai pas pu vérifier

- **Tout constat « vérifié en direct »** : `/api/config` sans `codexHome` (§3), `/api/status` sans jetons (§6.6), refus réels `429 usage_limit_reached` et `403` (§4). Aucune requête émise, aucun serveur démarré : ces invariants sont vrais **statiquement** (`config.ts:61-68`, `contracts.ts:55-75`), non observés.
- **Le compte de 2336 lignes de `src/ui`** (§3) et des CSS : aucun outil de comptage dans ce run. Les 15 fichiers `.ts` existent, les 5 routes + `#showcase` aussi (`shell.ts:10-33, 146`).
- **L'acceptation réelle des 38 routes et des 64 WebSockets par Codex** : hors de portée en lecture seule.
- **`upstream/`, `compatibility-tests/`** : non ouverts ; les affirmations du §5 appuyées sur le README (`README.md:30,56,69,94`) sont notées comme telles, non rejouées.
