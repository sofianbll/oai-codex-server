# Architecture — oai-codex-server

**Version 2, corrigée le 20/09/2026 après contre-audit contradictoire** (voir `02b-contre-audit-architecture.md`). Journal des corrections au §10.

Document descriptif de l'existant. Rédigé le 20/09/2026 en lecture seule : aucun fichier du projet n'a été modifié, aucun serveur n'a été démarré pour la rédaction.
Méthode : lecture directe du code et du catalogue servi ; les affirmations techniques portent une référence `fichier:ligne`. Ce qui vient du README et n'a pas été relu dans le code est signalé. `[statique]` = constaté dans le code mais non rejoué en exécution.

---

## 1. Vue d'ensemble

`oai-codex-server` est une passerelle locale qui place une **API HTTP compatible OpenAI** devant la **session ChatGPT de Codex** déjà installée sur la machine. Un unique processus Bun sert quatre choses : le relais `/v1/*`, un dashboard de test, la documentation Scalar et la spécification OpenAPI. Le relais ne traduit presque rien : il transmet les octets, la méthode, la requête et les champs inconnus, et **remplace l'authentification côté serveur**. Les identifiants Codex ne quittent jamais le processus ; les clients reçoivent une clé locale distincte.

---

## 2. Flux

```text
  Client compatible OpenAI (SDK, curl, dashboard, Scalar)
        |   Authorization: Bearer (cle locale)     Origin (navigateur)
        v
  [0] Upgrade WebSocket        runtime.ts:58-71   intercepte AVANT Hono
        |   origine + cle locale revalidees ici : app.ts ne le voit jamais
        v
  [1] Porte d'acces            app.ts:53-65      origine + cle locale (temps constant)
        |      origine : rejetee seulement si presente ET differente
        +--> /health, /, /docs, /assets, /openapi.json   public
        +--> /api/status|config|capabilities|activity    cle locale requise
        |
        v
  [2] Relais /v1/*             app.ts:130-145    concurrence bornee (maxConcurrent)
        |   app.all("/v1/*") : TOUT chemin /v1/* est relaye, meme hors catalogue
        v
  [3] Destination figee        config.ts:17 + upstream.ts:41-80
        |   rejet: traversal, %-encoding double, schema, echappement d'origine
        v
  [4] En-tetes assainis        upstream.ts:6-24 (hop 6-15 + prives 16-24)
        |   Authorization REMPLACE par le jeton de l'abonnement (upstream.ts:105-106)
        v
  [5] Credentials Codex        credentials.ts:11-25, :47 - relus a chaque appel :102-104
        |   expire ? -> codex app-server (rafraichissement officiel, deduplique)
        v
  [6] Backend ChatGPT Codex    https://chatgpt.com/backend-api/codex
        |
        v
  [7] Retour                   JSON | SSE | binaire | frames WebSocket
            (SSE agrege si le client a demande stream=false, response-adapter.ts)
```

Lecture linéaire : une requête entre par la porte d'accès locale, ne peut aller qu'à une seule destination figée par le schéma de configuration, et y arrive authentifiée par l'abonnement.

**Correction importante par rapport à la version 1 :** la réponse **n'est pas** renvoyée « inchangée ». L'enveloppe est modifiée — `content-length` supprimé (`upstream.ts:30`), `set-cookie` et `content-encoding` supprimés de la réponse (`:35-36`), `accept-encoding: identity` imposé à l'aller (`:107`) — et en mode `minimal`, le corps de `POST /v1/responses` est désérialisé puis réécrit (`:97-101`, `response-adapter.ts:47-57`). Les octets ne sont identiques qu'en mode `raw` et hors ces en-têtes.

---

## 3. Composants et invariants

| Fichier | Lignes | Responsabilité unique | Invariant vérifié |
| --- | --- | --- | --- |
| `src/cli/main.ts` | 84 | Commandes `init`, `serve`, `start`, `stop`, `status`, `token`, `config validate` | — |
| `src/cli/lifecycle.ts` | 191 | Démarrage détaché, état PID, journal | état `.local/server.json` (0600), journal `.local/server.log` (`127-129`) |
| `src/cli/options.ts` | 96 | Options CLI prioritaires sur le fichier | — |
| `src/server/runtime.ts` | 98 | `Bun.serve`, cycle de vie du processus, **porte des WebSockets** | `maxRequestBodySize` = borne des corps (`55`) ; **garde origine + jeton des upgrades WS, interceptée avant Hono (`58-71`, contrôles `62-65`)** ; écriture `.local/server.json` en 0600 (`85-90`) ; suppression du fichier d'état au stop si le PID correspond (`27-39`) ; SIGINT/SIGTERM (`95-96`) |
| `src/server/app.ts` | 150 | Routes, gardes, bornes | garde origine + jeton sur `/api/*` et `/v1/*` (`53-65`, **HTTP seulement**) ; corps `/api/*` borné à 64 Kio (`68-72`) ; concurrence `maxConcurrent` (`131-132`) ; relais de **tout** `/v1/*` (`130`) ; journal ouvert seulement ici (`133`) |
| `src/server/access.ts` | 55 | Clé locale et contrôle d'origine | clé 32 octets aléatoires, fichier créé en 0600, re-chmodé à chaque lecture (`6-32`) ; comparaison `timingSafeEqual` (`47-49`) ; jeton par sous-protocole WebSocket (`36-46`) ; **origine rejetée seulement si présente et différente** — une requête sans en-tête `Origin` passe (`52-55`) |
| `src/server/upstream.ts` | 163 | Destination et transfert | destination vérifiée (`41-80`) ; **en-têtes hop `6-15`, en-têtes privés `16-24`** ; `authorization` **remplacée** (`105-106`) ; `accept-encoding: identity` (`107`) ; aucun retry, redirections non suivies (`118-120`) |
| `src/server/upstream-stream.ts` | 102 | Bornage et annulation du corps | dépassement → 413 ; déconnexion client → 499 (`18`) |
| `src/server/response-adapter.ts` | 142 | Mode minimal | `model`/`instructions`/`store:false` ajoutés seulement s'ils manquent ; `store:true` refusé ; `stream=true` toujours demandé ; réponse finale reconstruite depuis les `output_item.done` |
| `src/server/credentials.ts` | 133 | Lecture privée de la session | schéma `auth.json` (`11-25`), validation (`47`) ; relecture à chaque appel (`102-104`) ; rafraîchissements concurrents dédupliqués (`105-108`) ; changement de compte détecté et refusé (`79-87`) |
| `src/server/codex-refresh.ts` | 146 | Rafraîchissement officiel | lance le mécanisme du CLI Codex, fonctionnalités annexes désactivées ; sortie plafonnée à 1 Mio (`122`) et 20 s (`73`) |
| `src/server/catalog.ts` | 121 | Catalogue des opérations | 38 opérations HTTP + 1 WebSocket ; niveau de preuve par opération (`49-54`, `76-89`) ; ⚠️ **lit `codex-contract-atlas/snapshot/openapi.json` au démarrage** (`28`) : le sous-projet est une dépendance d'exécution, pas un dossier annexe |
| `src/server/openapi.ts` | 146 | Spécification servie | 39 opérations + 7 contrôles serveur ; `security: LocalBearer` ; `/health` sans sécurité (`100`) ; schémas publics conservés verbatim ; **dit lui-même que d'autres chemins `/v1/*` sont relayables hors référence** (`127`) |
| `src/server/websocket.ts` | 195 | Relais WebSocket | maximum 64 connexions simultanées, refus **503** (`95-96`) ; file de 1024 frames (`56`) ; **liste blanche d'en-têtes reconstruite** (`115-127`) : `authorization` remplacée, `chatgpt-account-id`, `openai-*`, `x-client-request-id` — le sous-protocole porteur de la clé locale n'est **jamais** relayé |
| `src/server/config.ts` | 115 | Configuration et vue publique | **destination figée par `z.literal` (`17`)** ; `publicConfig` n'expose ni `codexHome` ni `tokenFile` (`61-68`) ; écriture atomique en 0600 (`88-89`) |
| `src/server/activity.ts` | 86 | Journal en mémoire | méthode, chemin sans query tronqué à 256 caractères (`18`), statut, durée, taille — **jamais** de corps ni d'en-tête d'authentification |
| `src/server/static.ts` | 25 | Sert `dist/` | — |
| `src/shared/contracts.ts` | 75 | Types partagés et `GatewayError` | — |
| `src/shared/assets.d.ts` | — | Types des assets | — |
| `src/ui/*` | 2336 (19 fichiers) | Dashboard (DOM vanilla, sans framework) | 5 pages + `#showcase` + `/docs` |

---

## 4. Types d'API réellement servis

Méthode de comptage : lecture de `codex-contract-atlas/snapshot/openapi.json` avec le **même filtre que `catalog.ts:34-41`** (familles `responses`, `models`, `images`, `audio`, `realtime`, `live`, chemins sans `?`).

Sur 224 chemins dans le snapshot, **38 opérations HTTP** sont retenues, plus **1 WebSocket** ajouté à la main → **39 entrées** au catalogue, chiffre identique à celui du README.

| Famille | Opérations | Exemples |
| --- | --- | --- |
| `audio` | 9 | `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`, `POST /v1/audio/voices`, consentements de voix (liste, lecture, mise à jour, suppression) |
| `realtime` | 9 | `POST /v1/realtime/calls`, `client_secrets`, `sessions`, `transcription_sessions`, `POST /v1/realtime/translations/client_secrets`, accept/refer/reject/hangup |
| `live` | 7 | `POST /v1/live/sessions`, fork, refer, reject, accept, hangup, téléchargement d'enregistrement |
| `responses` | 7 | `POST /v1/responses`, lecture/suppression/annulation, `input_items`, `input_tokens`, `compact` |
| `images` | 3 | `generations`, `edits`, `variations` |
| `models` | 3 | liste, lecture, suppression |
| **Total HTTP** | **38** | |
| WebSocket | 1 | `GET /v1/responses` en montée de protocole |

Niveaux de preuve portés par le catalogue (`catalog.ts:49-54`, `76-89`) :

- **`verified`** : `createResponse` uniquement — observé sur le vrai backend.
- **`source-backed`** : `listModels`, `createImage`, `createImageEdit`, `create-realtime-call`, plus le WebSocket — présents dans le code source Codex, disponibilité d'exécution non vérifiée.
- **`unverified`** : toutes les autres (**33 opérations**).

Point de conception à conserver : le catalogue décrit le **contrat public**, pas la disponibilité du backend. `supported: true` signifie « le relais local peut transmettre », jamais « l'abonnement accepte ». Les refus réels remontent tels quels — observé le 20/09 : `429 usage_limit_reached` sur `/v1/responses`, enregistré dans `artifacts/qa/ui-live/evidence.json`.

**Fragilité du comptage, non signalée en version 1 :** le catalogue compte **les clés de l'objet de chemin** (`catalog.ts:39-41`), pas les méthodes HTTP. Une clé `parameters` ou `summary` compterait comme une fausse opération. Sans effet aujourd'hui : sous les familles filtrées, seuls `get`, `post` et `delete` apparaissent.

---

## 5. Cycle de vie et emplacements

```sh
./oai-codex init      # crée la configuration, refuse d'écraser un fichier existant
./oai-codex serve     # premier plan
./oai-codex start     # arrière-plan détaché
./oai-codex status    # état + disponibilité de la session Codex
./oai-codex stop
./oai-codex token     # clé du proxy, à coller dans les clients
./oai-codex config validate
```

| Élément | Emplacement | Permissions |
| --- | --- | --- |
| Configuration | `oai-codex.config.json` | **0600**, écrite atomiquement par `rename` (`config.ts:88-89`, à l'init `options.ts:66-69`) |
| Clé locale | `.local/server-token` | `0600`, dossier `0700` |
| État du processus | `.local/server.json` | `0600` (`runtime.ts:85-90`) |
| Journal | `.local/server.log` | `0600`, ouvert par `lifecycle.ts:127-129` |
| Identifiants Codex | hors du dépôt : `auth.json` du `CODEX_HOME` | lu, jamais copié |

`start` détache le processus : il survit à la fermeture du terminal mais **n'est pas un service macOS** — il ne redémarre pas après un redémarrage de la machine. C'est un choix documenté du README, pas un oubli.

Le fichier d'état n'est supprimé au `stop` que si le PID enregistré correspond au processus courant (`runtime.ts:27-39`) : un serveur mort ne peut pas effacer l'état d'un serveur vivant.

---

## 6. Authentification et rafraîchissement

1. `auth.json` est relu **à chaque appel** (`credentials.ts:102-104`), pas mis en cache au démarrage.
2. L'expiration est lue dans le jeton comme **indice**, jamais comme validation — la signature reste validée par l'amont (`credentials.ts:34`).
3. Si le jeton est expiré : le rafraîchissement officiel du CLI est lancé une seule fois, les appels concurrents attendent la même promesse (`105-108`).
4. Si le compte a changé entre-temps, l'appel est refusé (`79-87`) : on ne mélange pas deux comptes dans une même session.
5. L'en-tête `authorization` du client est **supprimé puis remplacé** (`upstream.ts:102-106`) : un client ne peut pas injecter ses propres identifiants vers l'amont. **Nuance :** la garantie couvre `authorization`, `x-api-key`, `cookie`, `host`, `origin`, `referer`, `forwarded` (`privateHeaders`, `upstream.ts:16-24`). Un en-tête client nommé `api-key` (sans `x-`) n'est pas listé et part **verbatim** vers `chatgpt.com` — inoffensif pour l'abonnement, mais ce n'est pas une liste blanche.
6. Le WebSocket est **plus strict que le HTTP** : `websocket.ts:115-127` reconstruit une liste blanche explicite au lieu de recopier les en-têtes entrants.
7. Le dashboard ne reçoit jamais les jetons Codex : `/api/status` n'expose que `available` et `expiresAt` `[statique]`.

---

## 7. Modes `raw` et `minimal`

| | `raw` | `minimal` (défaut) |
| --- | --- | --- |
| Corps, SSE, fichiers, frames | transmis sans traduction | transmis sans traduction **sauf** `POST /v1/responses` et `GET /v1/models` |
| `POST /v1/responses` | rien n'est ajouté | ajoute `model`, `instructions: ""`, `store: false` s'ils manquent ; transforme un `input` texte en message ; demande `stream=true` en amont ; refuse `store: true` |
| Client `stream: false` | reçoit ce que Codex renvoie | reçoit l'objet `response` final, reconstruit depuis les `output_item.done` si Codex ne les répète pas |
| `GET /v1/models` | charge utile d'origine | ajoute `client_version` si absent, expose `data[].id` en conservant les champs Codex |
| En-tête SSE manquant | transmis tel quel | réétiqueté en `text/event-stream` quand la réponse est OK et que le `content-type` est **absent ou `text/plain`** (`upstream.ts:125-127`) — **le corps n'est jamais inspecté** |

---

## 8. Limites et bornes

| Borne | Valeur | Source |
| --- | --- | --- |
| Corps `/api/*` | 64 Kio | `app.ts:68-72` |
| Corps `/v1/*` | 16 777 216 octets (16 Mio) | `config.ts:20` (`maxBodyBytes`), appliqué par `runtime.ts:55` |
| Délai amont | 120 000 ms | `config.ts:19` (`timeoutMs`) |
| Concurrence | 16 requêtes `/v1/*` actives | `config.ts:40-41` (`maxConcurrent`) → `429 too_many_requests` (`app.ts:131-132`) |
| WebSocket | 64 simultanés, refus **503** | `websocket.ts:95-96` |
| File WebSocket | 1024 frames | `websocket.ts:56` |
| Journal | 100 entrées en mémoire, chemin tronqué à 256 car. | `config.ts` (`activityEntries`), `activity.ts:18` |
| Rafraîchissement Codex | sortie plafonnée à 1 Mio, délai 20 s | `codex-refresh.ts:122`, `:73` |
| CLI | lancement 1500 ms, attente de démarrage 15 s, attente d'arrêt 5 s | `lifecycle.ts:64`, `:161`, `:99` |
| Agrégation SSE | plafonnée à `maxBodyBytes` | `upstream.ts:136` |
| Déconnexion client | 499 | `upstream-stream.ts:18` |
| Redirections amont | non suivies | `upstream.ts:120` |
| Retry | aucun | `upstream.ts:118` |

---

## 9. Ce que le projet ne fait pas

- Pas d'émulation de l'API publique : le relais est un passe-plat, pas un serveur de modèles.
- Pas de stockage des réponses (`store: true` refusé explicitement).
- **Pas de route Chat Completions au catalogue — mais le relais est plus large que le catalogue.** `app.all("/v1/*")` (`app.ts:130`) transmet tout chemin `/v1/*`, donc `POST /v1/chat/completions` est bel et bien relayé vers l'amont, même absent de la référence servie. La spécification le dit explicitement (`openapi.ts:127`). La version 1 de ce document laissait croire l'inverse.
- Pas de suivi des redirections, pas de retry automatique, pas de reconnexion WebSocket.
- Pas de multipart vers un stockage intermédiaire : les octets traversent.
- Pas de compte utilisateur, pas de base de données, pas de persistance des conversations.
- Pas de service de démarrage automatique macOS.
- Journal limité aux `/v1/*` : `/health`, `/api/*` et les refus de la porte (401, 403, 429 de concurrence) n'y figurent pas, et la limite de concurrence ne compte que les `/v1/*` (`app.ts:130-133`).

---

## 10. Journal des corrections apportées en version 2

Contre-audit source : `02b-contre-audit-architecture.md` (20/09/2026, 90 lignes, lecture seule, recomptage indépendant).

| Correction | Ce qui était faux ou incomplet |
| --- | --- |
| `src/server/runtime.ts` ajouté au §3 | Composant **absent** de la version 1, alors qu'il porte `Bun.serve`, la borne des corps, le fichier d'état et **la garde d'accès des WebSockets**, attribuée à tort à `app.ts`. |
| Garde WS déplacée au §2 étape [0] | `app.ts:53-65` ne voit jamais un upgrade WebSocket : il est intercepté avant Hono (`runtime.ts:58-71`). |
| `unverified` : 32 → **33** (§4) | Erreur de soustraction : 38 − 1 `verified` − 4 `source-backed` = 33. |
| Exemples `audio` et `realtime` complétés (§4) | Deux opérations manquaient dans les exemples cités (`/audio/translations`, `POST /v1/realtime/translations/client_secrets`). |
| « même origine exigée » → rejet conditionnel (§2, §3) | Une requête **sans** en-tête `Origin` passe (`access.ts:54`) : ce n'est pas un refus par défaut. |
| « revient inchangée à l'appelant » corrigé (§2) | L'enveloppe change (content-length, set-cookie, content-encoding, accept-encoding) et le corps est réécrit en mode `minimal`. |
| « rétabli si le corps est bien du SSE » corrigé (§7) | Le corps n'est jamais inspecté : le test porte sur `response.ok` et le `content-type`. |
| `upstream.ts:16-38` → hop `6-15` / privés `16-24` (§2, §3) | La plage citée mélangeait deux listes distinctes. |
| `credentials.ts:45-51` → `11-25` + `47` + `102-104` (§2, §3) | La plage décrivait `readSession`, pas la validation par schéma. |
| Destination figée créditée à `config.ts:17` (§2, §3) | La garantie vient du schéma `z.literal`, pas du contrôle d'échappement. |
| `api-key` ajouté comme nuance (§6.5) | Contrairement à `x-api-key`, cet en-tête n'est pas retiré des requêtes entrantes. |
| Liste blanche WebSocket documentée (§3, §6.6) | Asymétrie favorable non mentionnée : le WS est plus strict que le HTTP. |
| §9 corrigé sur Chat Completions | Le catalogue ne l'annonce pas, mais le relais le transmet : la formulation initiale était trompeuse. |
| Bornes complétées (§8) et journal circonscrit (§9) | Manquaient file WS, refresh, délais CLI, troncature du chemin, plafond d'agrégation, 499, 503, permissions de la configuration, et le fait que le journal ne couvre que `/v1/*`. |
| Compte de `src/ui` : 2336 lignes (19 fichiers) | Non vérifié par le contre-audit ; recompté et confirmé ici. |
