# Codex après DevDay 2026 : releases, contrat réseau et authentification en CI

Recherche documentaire du 2026-10-01, complétée le 2026-10-05, pour le proxy `oai-codex-server`, qui relaie `/v1/*` vers `https://chatgpt.com/backend-api/codex/*`. Sources primaires uniquement : openai.com, developers.openai.com (dont les pages Codex redirigent en HTTP 308 vers `learn.chatgpt.com/docs/*`, domaine OpenAI), docs.github.com, et le dépôt `github.com/openai/codex` lu au niveau des tags. Les permaliens de code pointent sur le commit de la release 0.158.0, `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`, abrégé **`@0.158.0`** ci-dessous. Les pages openai.com refusent curl (403) ; elles ont été lues dans un navigateur.

## Résumé

1. Pour suivre les releases automatiquement, interrogez `GET https://api.github.com/repos/openai/codex/releases/latest`. Il renvoie la dernière release stable : au 2026-10-05, c'est `rust-v0.160.0` (publiée le 1er octobre, commit `a956835d…`), qui a remplacé `rust-v0.159.3`. La 0.158.0 correspond au tag `rust-v0.158.0`, commit `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`. Pour Linux, les binaires s'appellent `codex-<arch>-unknown-linux-musl.tar.gz`.
2. Entre 0.155.0 et 0.158.0, et encore en 0.160.0, ni les chemins utilisés par le proxy ni ses en-têtes ne changent : `/responses`, `/models?client_version=`, `session-id`, `x-codex-turn-state`, `originator`. Le schéma de `auth.json` ne change pas non plus. Les nouveautés concernent les erreurs (`flex_unavailable`, `slow_down`, `Retry-After`) et le routage par espace de travail (`x-openai-account-routing-override`).
3. Le snapshot local `132c2be…` se situe sur `main`, entre `rust-v0.156.0-alpha.8` et `alpha.9`. C'est la 0.156.0 qui lui ressemble le plus.
4. Pour la CI, OpenAI recommande une clé API. Les « Codex access tokens » ne sont proposés qu'aux espaces Business et Enterprise. Copier `auth.json` n'est admis que sur un runner privé de confiance, avec une copie par machine.
5. Les refresh tokens tournent à chaque refresh. Si la CI et le Mac partagent le même `auth.json`, l'un des deux finira tôt ou tard en `refresh_token_reused` et devra se reconnecter.
6. La page app-server affirme que cette authentification n'a jamais été autorisée pour un service commercial ou hébergé, et oriente vers « Sign in with ChatGPT ». Un proxy réservé à son propre usage reste dans une zone grise.
7. Le modèle `gpt-6-astra` existe bien (API depuis le 3 septembre). Depuis Codex 0.159.1, le modèle par défaut est `gpt-6.1-sol`, environ cinq fois moins cher. `gpt-5.5` disparaît de Codex le 14 octobre 2026.
8. Du 1er au 5 octobre, OpenAI n'a publié que trois choses : Codex 0.160.0, sans impact réseau ; des dépréciations dans l'API, effectives au 1er avril 2027 ; et un guide sur GPT-6. Le changelog de l'API n'a aucune entrée en octobre.

---

## 1. DevDay 2026 et annonces depuis août 2026

DevDay 2026 a eu lieu le **29 septembre 2026** à Fort Mason, San Francisco ([devday.openai.com](https://devday.openai.com/)). Le récapitulatif officiel, daté du même jour, annonce plus de vingt nouveautés ([DevDay 2026 Recap](https://openai.com/index/devday-2026-recap/)).

| Date | Annonce | Ce qui change | Impact probable sur le proxy |
|---|---|---|---|
| 29 sept. 2026 | Codex : cloud, CLI rafraîchie, Code Review, Codex Security Cloud ([recap, section Codex & API](https://openai.com/index/devday-2026-recap/#new-tools-for-developers-in-codex-api)) | Codex s'exécute désormais aussi dans le cloud (plans Plus à Enterprise). La CLI gagne la voix et une vue `/agents`. | Aucun changement de contrat annoncé. Les nouveautés passent par les releases de la CLI (voir section 2). |
| 29 sept. 2026 | Sign in with ChatGPT (SIWC) ([recap, section abonnement](https://openai.com/index/devday-2026-recap/#do-more-with-your-chatgpt-subscription)) | L'allocation d'un plan ChatGPT devient utilisable dans 16 outils partenaires. Seuls Plus et Pro y ont droit. | C'est désormais la voie officielle pour qu'une application tierce consomme un plan ChatGPT. La doc SIWC demande d'appeler `https://api.openai.com/v1/responses` et de ne pas viser les endpoints `backend-api` de ChatGPT ([SIWC, models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)). |
| 29 sept. 2026 | SIWC Terms ([Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)) | Les tokens restent stockés localement, sous le contrôle de l'utilisateur. Les requêtes partent de son runtime. Il est interdit d'offrir un accès API généraliste à d'autres outils ou de partager les tokens. | Ces conditions décrivent presque mot pour mot ce que fait un proxy « compatible OpenAI ». Voir section 3.4. |
| non datée | Page App Server de Codex ([Auth endpoints](https://learn.chatgpt.com/docs/app-server#auth-endpoints)) | « App-server authentication has never been permitted for commercial or hosted services. » La page recommande de migrer vers SIWC. Un usage local ou open source reste toléré. Ailleurs, l'app-server et son transport WebSocket sont dits expérimentaux et non supportés en production ([Protocol](https://learn.chatgpt.com/docs/app-server#protocol)). | Le proxy dépend de `codex app-server` pour rafraîchir la session et relaie `backend-api`. Il ne doit donc être ni hébergé pour des tiers ni commercial. |
| 3 sept. 2026 | GPT-6 Astra (`gpt-6-astra`) ([changelog API, 3 sept.](https://developers.openai.com/api/docs/changelog), [page modèle](https://developers.openai.com/api/docs/models/gpt-6-astra)) | Disponible sur `v1/responses` et `v1/chat/completions`. Côté API : 1 050 000 tokens de contexte, 128 000 en sortie, efforts low à max, un seul snapshot `gpt-6-astra`. | Le nom par défaut du proxy est valide. Le catalogue embarqué de Codex donne toutefois 272 000 tokens de contexte (`max_context_window` 872 000) et `minimal_client_version` 0.153.0 ([models.json @0.159.3](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/models-manager/models.json)). Il ne faut donc pas reprendre les limites de l'API. |
| 4 sept. 2026 | Codex 0.153.4 ([release](https://github.com/openai/codex/releases/tag/rust-v0.153.4)) | Astra devient le modèle par défaut du catalogue embarqué quand aucun modèle n'est configuré. | Confirme le choix actuel du proxy, mais voir la ligne du 29 sept. sur GPT-6.1 Sol. |
| 3 sept. 2026 | Async tool calling et mid-turn steering ([changelog API, 3 sept.](https://developers.openai.com/api/docs/changelog), [guide WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)) | De nouveaux contrôles pour GPT-6 Astra. Le steering passe uniquement par WebSocket. | Le relais SSE ne permet pas le steering. Le pont WebSocket doit faire passer tels quels les nouveaux types d'événements. |
| 23 févr. 2026, guide mis à jour depuis | Mode WebSocket de l'API Responses ([changelog, 23 févr.](https://developers.openai.com/api/docs/changelog), [guide](https://developers.openai.com/api/docs/guides/websocket-mode)) | Connexion persistante vers `/v1/responses`, messages `response.create`, multiplexage par `stream_id`, connexions de 60 minutes au plus. Avec `store=false`, une réponse précédente absente du cache renvoie `previous_response_not_found`. | Codex envoie toujours `OpenAI-Beta: responses_websockets=2026-02-06`, identique en 0.155.0 et 0.158.0 ([client.rs L175 @0.158.0](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/client.rs#L175)). Je n'ai trouvé aucune date pour l'ajout de `stream_id`. |
| 2 sept. 2026 | Nouveaux codes d'erreur ([changelog API, 2 sept.](https://developers.openai.com/api/docs/changelog)) | Une montée de trafic trop rapide donne `429 slow_down`, une surcharge `503 server_is_overloaded`, avec un éventuel `Retry-After` à respecter. | Le proxy doit renvoyer `Retry-After` et ces codes sans les modifier. Codex 0.158.0 les gère déjà (section 2.3). |
| 22 sept. 2026 | GPT-6 Sol et GPT-6 Luna ([changelog API, 22 sept.](https://developers.openai.com/api/docs/changelog)) | Deux nouveaux modèles. Dans Codex, `minimal_client_version` vaut 0.155.0 ([models.json @0.158.0](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/models-manager/models.json)). | Avec `client_version` 0.155.0, le proxy est exactement au seuil. Je déduis, sans confirmation, que le serveur filtre `/models` selon ce champ. |
| 29 sept. 2026 | GPT-6.1 Sol ([changelog API, 29 sept.](https://developers.openai.com/api/docs/changelog), [recap](https://openai.com/index/devday-2026-recap/#a-whole-new-way-to-work-with-ai)) et Codex 0.159.1 ([release](https://github.com/openai/codex/releases/tag/rust-v0.159.1)) | `gpt-6.1-sol` devient le modèle par défaut du catalogue embarqué. Ses tarifs sont environ cinq fois plus bas que ceux d'Astra. | Il vaut la peine de reconsidérer `defaultModel: gpt-6-astra`. La CLI installée (0.158.0) ne contient pas encore ce modèle. |
| 29 sept. 2026 | Ultrafast ([changelog API, 29 sept.](https://developers.openai.com/api/docs/changelog), [recap](https://openai.com/index/devday-2026-recap/#a-whole-new-way-to-work-with-ai)) | `service_tier: "ultrafast"` pour `gpt-6-astra`, via Responses uniquement. Dans Codex, il est réservé à Pro 500 et Enterprise. | Le proxy doit transmettre `service_tier` tel quel. Pas d'action si le compte n'y a pas droit. |
| 14 oct. 2026 (annoncé) | Retrait de GPT-5.5 de ChatGPT et Codex ([Models, encadré GPT-5.5 retirement](https://learn.chatgpt.com/docs/models)) | Tous les plans perdent GPT-5.5 dans Codex. L'API n'est pas concernée. | Tout alias du proxy qui pointe vers `gpt-5.5` doit être migré avant cette date. |
| 1er oct. 2026 | Codex CLI 0.160.0 ([release](https://github.com/openai/codex/releases/tag/rust-v0.160.0), [changelog Codex, 2026-10-01](https://learn.chatgpt.com/docs/changelog)) | Améliorations de l'interface, sessions hors projet, options Guardian. Le catalogue d'un fournisseur explicite n'embarque plus les modèles non supportés. | Aucun changement de chemin, d'en-tête ni de schéma `auth.json` par rapport à 0.158.0 (section 2.3). |
| 1er oct. 2026 | Dépréciations API ([deprecations, 2026-10-01](https://developers.openai.com/api/docs/deprecations#2026-10-01-gpt-53-codex-gpt-51-gpt-54-nano)) | `gpt-5.3-codex`, `gpt-5.1` et `gpt-5.4-nano` quittent l'API le 1er avril 2027. Les modèles TTS (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts-*`) la quittent le 6 janvier 2027 ([entrée TTS](https://developers.openai.com/api/docs/deprecations#2026-10-01-text-to-speech-models)). | Ces dépréciations concernent l'API publique, pas le backend Codex. À surveiller seulement si le proxy expose ces noms en alias. |
| 2 oct. 2026 | Guide « A model guide for the GPT-6 family » ([openai.com](https://openai.com/index/practical-guide-building-gpt-6/)) | Conseils d'usage : choix du modèle, effort de raisonnement, Fast mode. Le guide renvoie au steering et à l'async tool calling via l'API Responses WebSocket. | Aucun changement de contrat. |
| 1er–5 oct. 2026 | Rien d'autre | Le changelog de l'API n'a aucune entrée en octobre. Le changelog Codex n'a que la 0.160.0. Le fil openai.com/news ajoute deux articles sans rapport : un essai et un témoignage client. Aucun nouveau dépôt `openai/*` n'a été créé depuis le 29 sept. | Néant. |
| 29 sept. 2026 (UTC) | Nouveau dépôt `openai/sign-in-with-chatgpt-devkit` ([dépôt](https://github.com/openai/sign-in-with-chatgpt-devkit)) | SDK local et composants pour SIWC. GitHub ne reconnaît pas sa licence (`NOASSERTION`). | C'est le seul code source publié récemment qui touche ce sujet. |

Codex ne publie pas de CHANGELOG détaillé dans le dépôt. Le fichier `CHANGELOG.md` renvoie aux releases GitHub ([CHANGELOG.md](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/CHANGELOG.md)).

---

## 2. Codex 0.155.0 → 0.158.0 : ce qui touche le contrat réseau

### 2.1 Tags et commits

Les tags ont la forme `rust-vX.Y.Z` ; les préversions ajoutent `-alpha.N`, parfois `-alpha.N.M`. Ce sont des tags annotés, d'où deux SHA par tag : celui de l'objet tag et celui du commit visé. Les SHA ci-dessous ont été obtenus avec `git ls-remote` et l'[API GitHub](https://api.github.com/repos/openai/codex/commits/rust-v0.158.0).

| Tag | Publiée (UTC) | Commit | Objet tag |
|---|---|---|---|
| [`rust-v0.155.0`](https://github.com/openai/codex/releases/tag/rust-v0.155.0) | 2026-09-17 23:14 | `f0a1b8f0849d90960bc406b848f32e5a129b0457` | `799f378e…` |
| [`rust-v0.156.0`](https://github.com/openai/codex/releases/tag/rust-v0.156.0) | 2026-09-22 19:51 | `fe74a774532af67b5a4a3dec03ce9469e17f89af` | `476ac1aa…` |
| [`rust-v0.156.1`](https://github.com/openai/codex/releases/tag/rust-v0.156.1) | 2026-09-23 02:41 | `b412ff32c417f855c2b2d1581b77058eed87c84b` | `81e8e29b…` |
| [`rust-v0.157.0`](https://github.com/openai/codex/releases/tag/rust-v0.157.0) | 2026-09-25 02:31 | `00c972ed5d6ff6499317fd41b7f23605b8e6850d` | `ac21625d…` |
| [`rust-v0.157.1`](https://github.com/openai/codex/releases/tag/rust-v0.157.1) | 2026-09-26 01:02 | `36650394c5b38c2990ccf2a3457165ca3e9d9726` | `ac0e23e5…` |
| [`rust-v0.158.0`](https://github.com/openai/codex/releases/tag/rust-v0.158.0) | 2026-09-28 05:07 | **`064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`** | `54e1bd264b4122fe9471ee7d54c4d021a76bb8ff` |
| [`rust-v0.159.3`](https://github.com/openai/codex/releases/tag/rust-v0.159.3) | 2026-09-30 22:57 | `01fc69f4026735edfdf6789820549727a4867b11` | `8e46774a…` |
| [`rust-v0.160.0`](https://github.com/openai/codex/releases/tag/rust-v0.160.0) (dernière stable au 2026-10-05) | 2026-10-01 20:19 | `a956835d020762cb2b570053af06f643a11c0ecc` | `79b1b666…` |

Les commits de release ne sont pas sur `main`. Ils sont coupés sur une branche de release qui part de `main`, puis reçoivent quelques commits propres (7 pour la 0.155.0, 17 pour la 0.158.0). Le champ `target_commitish` de l'API vaut pourtant `"main"` : il ne faut pas s'en servir pour retrouver le commit.

### 2.2 Détecter automatiquement une nouvelle release stable

**Endpoint.** `GET https://api.github.com/repos/openai/codex/releases/latest`. La doc GitHub précise qu'il renvoie la release la plus récente qui n'est ni une prerelease ni un brouillon. Le tri se fait sur `created_at`, c'est-à-dire la date du commit de la release et non sa date de publication ([Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)). Les alpha d'openai/codex sont marquées `prerelease: true` et sont donc écartées.

**Forme de la réponse** (extrait réel du 2026-10-05) :

```json
{
  "tag_name": "rust-v0.160.0",
  "name": "0.160.0",
  "draft": false,
  "prerelease": false,
  "created_at": "2026-10-01T17:13:38Z",
  "published_at": "2026-10-01T20:19:13Z",
  "target_commitish": "main",
  "html_url": "https://github.com/openai/codex/releases/tag/rust-v0.160.0",
  "body": "## New Features\n...",
  "assets": [{ "name": "codex-x86_64-unknown-linux-musl.tar.gz", "browser_download_url": "...", "digest": "sha256:..." }]
}
```

Le 2026-10-01 au matin, le même appel renvoyait `rust-v0.159.3` : un suivi automatique aurait donc détecté la 0.160.0 le jour même.

**Binaires Linux.** Chaque release publie `codex-x86_64-unknown-linux-musl.tar.gz` et `codex-aarch64-unknown-linux-musl.tar.gz`, accompagnés de variantes `.zst` et `.sigstore` du même nom. Le champ `digest` de chaque asset donne son SHA-256.

Les clés présentes sont : `assets`, `assets_url`, `author`, `body`, `created_at`, `draft`, `html_url`, `id`, `immutable`, `mentions_count`, `name`, `node_id`, `prerelease`, `published_at`, `reactions`, `tag_name`, `tarball_url`, `target_commitish`, `updated_at`, `upload_url`, `url`, `zipball_url`.

**Obtenir le commit.** `GET /repos/openai/codex/commits/{tag_name}` renvoie directement `sha`. Pour la 0.158.0, c'est `064c6b8c…`.

**Bonnes pratiques.**
- Gardez l'`ETag` et renvoyez-le dans `If-None-Match`. Une réponse `304` ne compte pas dans le quota primaire si la requête est authentifiée ([conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)).
- Sans authentification, le quota est de 60 requêtes par heure. Avec le `GITHUB_TOKEN` d'Actions, il est de 1 000 par heure et par dépôt ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-unauthenticated-users)).
- Par précaution, filtrez aussi sur `^rust-v\d+\.\d+\.\d+$`.

**Limite du tri.** Comme `/latest` trie par date de commit, un correctif publié après coup sur une ancienne branche pourrait en théorie passer devant. Sur les 169 releases stables `rust-v*` de l'historique, aucun cas de ce genre n'existe (mesure faite le 2026-10-01).

### 2.3 Changements entre 0.155.0 et 0.158.0

Comparaison complète : [rust-v0.155.0…rust-v0.158.0](https://github.com/openai/codex/compare/rust-v0.155.0...rust-v0.158.0).

**Endpoints sous `/backend-api/codex`.** La base reste `https://chatgpt.com/backend-api/codex` ([model-provider-info L77](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/model-provider-info/src/lib.rs#L77)). Les chemins appelés par `codex-api` sont : `/responses` en HTTP SSE ([responses.rs L139](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/endpoint/responses.rs#L139)) et en WSS ([responses_websocket.rs L400](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L400)), `/models`, `/memories/trace_summarize`, `/images/generations`, `/images/edits` et `/alpha/search`.
- Le seul changement de chemin est une suppression. La 0.155.0 avait des routes `/guardian` et `/guardian-classifier`, ajoutées par la [PR #40892](https://github.com/openai/codex/pull/40892). La [PR #45736](https://github.com/openai/codex/pull/45736), du 15 sept., les remplace par `/responses` accompagné de l'en-tête `x-codex-guardian: reviewer|classifier` ([client.rs L2302](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/client.rs#L2302)).
- Il n'existe pas d'endpoint `/responses/compact` dans ces versions. La compaction passe par `/responses`, comme le proxy le fait déjà.

**`/models` et `client_version`.** Codex ajoute toujours `client_version` en paramètre de requête ([models.rs L64](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/endpoint/models.rs#L64)). Une option `model_catalog_url` permet désormais de pointer vers un autre catalogue ([PR #46561](https://github.com/openai/codex/pull/46561)).

**En-têtes de requête.** Plusieurs en-têtes ne changent pas :
- `session-id` et `thread-id` ([requests/headers.rs L8](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/requests/headers.rs#L8)) ;
- `x-codex-turn-state` ([client.rs L163](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/client.rs#L163)) ;
- `originator: codex_cli_rs` ([default_client.rs L42](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/default_client.rs#L42)) ;
- `Authorization: Bearer` et `ChatGPT-Account-ID` ([bearer_auth_provider.rs](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/model-provider/src/bearer_auth_provider.rs)).

Trois nouveautés :
- `x-codex-guardian`, décrit plus haut, réservé aux revues internes.
- `x-openai-account-routing-override: us | us_cr` ([workspace_routing.rs L12-L74](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/model-provider/src/workspace_routing.rs#L12-L74), PR [#45812](https://github.com/openai/codex/pull/45812) et [#46281](https://github.com/openai/codex/pull/46281)). Pour un espace de travail soumis à une contrainte de résidence, Codex remplace l'origine `chatgpt.com` par celle que renvoie `/wham/accounts/check` (champ `workspace_backend_origin`) et ajoute cet en-tête. Sans contrainte (`NO_CONSTRAINT`), rien ne change. L'app-server expose ce routage dans `account/read`, sous le champ expérimental `workspaceRouting` ([account.rs L557-L582](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L557-L582)).
- `x-gateway-auth`, qui ne concerne que les passerelles tierces en OAuth ([PR #46318](https://github.com/openai/codex/pull/46318)), pas le backend ChatGPT.

**Événements SSE et WebSocket.** Codex lit plusieurs nouveaux codes ou les classe autrement :
- Un événement de premier niveau `error` portant le code `flex_unavailable`, aussi possible dans `response.failed`, devient une erreur terminale distincte ([sse/responses.rs L360](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/sse/responses.rs#L360), [error.rs L60](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/error.rs#L60), [PR #47967](https://github.com/openai/codex/pull/47967)).
- `slow_down` est désormais traité comme une limite de débit et non plus comme une surcharge ([L477](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/sse/responses.rs#L477)).
- `bio_policy` et `invalid_prompt` deviennent deux erreurs distinctes ([L443](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/sse/responses.rs#L443), PR [#46306](https://github.com/openai/codex/pull/46306) et [#47353](https://github.com/openai/codex/pull/47353)).
- `credit_balance_exhausted`, `organization_spend_limit_exceeded` et `project_spend_limit_exceeded` sont rangés avec les quotas épuisés ([L759](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/sse/responses.rs#L759)).
- `Retry-After` est maintenant respecté, qu'il arrive en en-tête HTTP ou dans une erreur diffusée en flux ([retry_after.rs](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/http-client/src/retry_after.rs), [PR #47641](https://github.com/openai/codex/pull/47641)).

Côté requête, deux changements de format :
- Un effort de raisonnement numérique personnalisé est envoyé comme nombre JSON, et non plus comme chaîne ([PR #47590](https://github.com/openai/codex/pull/47590)).
- Les images d'entrée peuvent être référencées par `file_id` au lieu de `image_url` ([PR #45794](https://github.com/openai/codex/pull/45794)).

**Auth, refresh et `auth.json`.**
- Le schéma ne change pas : `storage.rs` et `token_data.rs` sont identiques entre les deux tags. Les champs sont : `auth_mode`, `OPENAI_API_KEY`, `tokens { id_token, access_token, refresh_token, account_id }`, `last_refresh`, `agent_identity`, `personal_access_token`, `bedrock_api_key`, `bedrock_access_keys` ([storage.rs L41-L65](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/storage.rs#L41-L65)).
- La seule nouveauté visible est une nouvelle valeur de plan, `promax` ([PR #47971](https://github.com/openai/codex/pull/47971)). Le proxy ne lit que `tokens.access_token` et `tokens.account_id`, il n'est donc pas concerné.
- Le refresh a été réorganisé ([PR #46300](https://github.com/openai/codex/pull/46300)) sans changer de comportement : même endpoint, même client OAuth, mêmes règles (détails en 3.2).
- Les redirections de login local passent sur `127.0.0.1` ([PR #47927](https://github.com/openai/codex/pull/47927)).

**Catalogue embarqué.**
- En 0.158.0, `gpt-6-sol` et `gpt-6-luna` apparaissent et `gpt-5.4` disparaît ([PR #47932](https://github.com/openai/codex/pull/47932)).
- `gpt-6.1-sol` arrive seulement en 0.159.1.

**Et après 0.158.0 ?** Entre 0.158.0 et 0.159.3, les commits qui touchent `codex-api`, `login` et `model-provider` sont surtout des refactorisations et des améliorations des continuations WebSocket, par exemple les PR [#48508](https://github.com/openai/codex/pull/48508) et [#48812](https://github.com/openai/codex/pull/48812).

La comparaison des tags 0.158.0 et 0.160.0 ne montre aucun changement pour le proxy :
- Les en-têtes cités dans `codex-api`, `core/src/client.rs`, `model-provider`, `login/src/auth` et `http-client` sont exactement les mêmes.
- Les chemins d'endpoints restent identiques.
- `storage.rs` et `token_data.rs` n'ont pas bougé.
- Le paramètre `client_version` de `/models` est inchangé.

Deux nouveautés côté erreurs seulement :
- Un `response.incomplete` portant la raison `content_filter` devient une erreur dédiée ([sse/responses.rs L428 @0.160.0](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/codex-api/src/sse/responses.rs#L428)).
- Les erreurs de limite d'usage peuvent porter un champ `limit_window_minutes`.

Dans le catalogue embarqué de la 0.160.0, `gpt-6.1-sol` arrive en tête (priorité 1, `minimal_client_version` 0.153.0) et `gpt-6-astra` vient juste après.

### 2.4 Où se situe le snapshot local `132c2be…`

Le commit `132c2be239ecbc1f2a9bb22d9210fefe887986a5`, du 2026-09-19, est sur `main`. Il est postérieur de 435 commits au point où la branche 0.155.0 s'est séparée de `main` (le 2026-09-10). Il précède de 90 commits celui de la 0.156.0, et de 406 celui de la 0.158.0. Il se place exactement 2 commits après la base de `rust-v0.156.0-alpha.8` et 16 commits avant celle de `alpha.9`.

Sur les trois chemins demandés, la 0.156.0 est de loin la plus proche :

| Chemin | snapshot ↔ 0.155.0 | snapshot ↔ 0.156.0 | snapshot ↔ 0.158.0 |
|---|---|---|---|
| `codex-api/src` | 13 fichiers, +116/−367 | 2 fichiers, +185/−14 (temps réel uniquement) | 16 fichiers, +1139/−385 |
| `config/src/types.rs` | +5/−62 | +14/−4 (options TUI) | +84/−4 |
| `login/` | 34 fichiers, +687/−3609 | 2 fichiers, +69/−1 (user-agent) | 22 fichiers, +1861/−191 |

Le snapshot contient déjà le passage de Guardian par `/responses`, le routage par espace de travail, `bio_policy` et `ImageReference`. Il lui manque `flex_unavailable`, `Retry-After`, la reclassification de `slow_down` et `invalid_prompt`, ainsi que l'effort numérique. Sa logique de refresh est la même qu'en 0.158.0, à une nuance près : la 0.158.0 ajoute un type d'erreur pour les refus liés à la politique réseau.

---

## 3. Authentification Codex en CI ou sans interface

### 3.1 Méthodes officielles

| Méthode | Ce que dit OpenAI | Utilisable en CI ? |
|---|---|---|
| Clé API (`codex login --with-api-key`, `CODEX_API_KEY`) | C'est la méthode recommandée pour les workflows programmatiques comme la CI/CD. Il ne faut pas exposer l'exécution de Codex dans un environnement public ou non fiable ([Auth, clé API](https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key)). Il faut aussi éviter de placer `CODEX_API_KEY` ou `OPENAI_API_KEY` au niveau du job quand celui-ci exécute du code du dépôt ([Non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode#use-api-key-auth)). | Oui. La facturation se fait au tarif API, pas sur le plan ChatGPT. |
| `openai/codex-action` | La seule entrée d'authentification est `openai-api-key`, plus `responses-api-endpoint` pour Azure ([action.yml @v1.12](https://github.com/openai/codex-action/blob/86365089eb2b84e0a8fb0717b304f8bdcb13b20e/action.yml#L17-L24)). Rien n'est prévu pour ChatGPT ou `auth.json`. Une entrée `codex-home` existe, mais elle n'est pas documentée pour l'authentification. | Avec une clé API seulement. |
| Codex access tokens (`CODEX_ACCESS_TOKEN`, `codex login --with-access-token`) | Ce sont des identifiants d'espace de travail ChatGPT, limités à Codex, prévus pour les scripts, les tâches planifiées et les runners CI. Ils ne sont disponibles que pour les espaces **Business et Enterprise**, expirent selon un plafond fixé par l'admin (par exemple 90 jours) et se révoquent ([Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens#how-access-tokens-work)). Dans le code, un token `at-…` est validé par `https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami` et n'est jamais rafraîchi ([personal_access_token.rs L11-L13](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/personal_access_token.rs#L11-L13), [manager.rs L1488](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/manager.rs#L1488)). L'option figure bien dans la CLI installée (`codex login --help`, [main.rs L509](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/cli/src/main.rs#L509)). | Oui, et c'est la bonne voie pour un plan Business ou Enterprise. Pas pour Plus ou Pro. |
| Device code (`codex login --device-auth`) | C'est la méthode préférée sur une machine sans interface. Elle est en bêta et doit être activée dans les paramètres de sécurité ChatGPT ([Auth, headless](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta)). | Non. Elle demande une validation humaine. |
| Copie de `auth.json` | Solution de repli : se connecter sur une machine équipée d'un navigateur, puis copier le fichier, à traiter comme un mot de passe ([Auth, copie du cache](https://learn.chatgpt.com/docs/auth#fallback-authenticate-locally-and-copy-your-auth-cache)). Un guide dédié encadre son usage en CI ([CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)). | Oui, mais seulement sous les conditions ci-dessous. |
| Workload identity federation | Un token OIDC, par exemple celui de GitHub, est échangé contre un token OpenAI de courte durée, rattaché à un espace ChatGPT géré. La fonction est en bêta et doit être activée sur demande ([WIF avec Codex](https://developers.openai.com/api/docs/guides/workload-identity-federation#use-workload-identity-with-codex)). | Pour les espaces gérés seulement. |

Le guide « Maintain Codex account auth in CI/CD » ([ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)) pose cinq règles :
- Une clé API reste la bonne méthode. Le guide ne sert que si l'on doit vraiment agir avec son compte Codex ([#when-to-use-this](https://learn.chatgpt.com/docs/auth/ci-cd-auth#when-to-use-this)).
- Il est exclu pour les dépôts publics ou open source.
- Il faut une copie de `auth.json` par runner ou par flux de jobs sérialisés. Ne partagez jamais une même copie entre jobs concurrents ou entre machines ([#operational-rules-that-matter](https://learn.chatgpt.com/docs/auth/ci-cd-auth#operational-rules-that-matter)).
- Laissez Codex rafraîchir le fichier, puis conservez la version réécrite ; n'appelez pas vous-même l'endpoint de refresh ([#why-this-works](https://learn.chatgpt.com/docs/auth/ci-cd-auth#why-this-works)).
- Si une autre machine ou un autre job a fait tourner le token en premier, il faut refaire `codex login` sur une machine de confiance et remplacer la copie ([#what-to-do-when-refresh-stops-working](https://learn.chatgpt.com/docs/auth/ci-cd-auth#what-to-do-when-refresh-stops-working)).

### 3.2 Rotation des refresh tokens et risque pour la session du Mac

**Ce que dit la documentation.**
- Pour SIWC, un access token dure une heure et un refresh token 30 jours. Chaque refresh réussi renvoie un nouveau refresh token, valable à nouveau 30 jours ([token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference#token-lifetimes)).
- `refresh_token_reused`, `refresh_token_expired` et `refresh_token_invalidated` sont des erreurs définitives : il faut effacer les tokens et refaire l'OAuth ([errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery#refresh-errors)).
- Ces pages visent les intégrations SIWC, pas nommément le client Codex CLI.

**Ce que fait le code de Codex.** Le comportement est identique en 0.155.0, dans le snapshot local (`login/src/auth/manager.rs` lignes 203-216, 1584-1602, 1668, 2799, 2955) et en 0.158.0 :
- Le refresh appelle `POST https://auth.openai.com/oauth/token` avec le client `app_EMoamEEZ73f0CkXaXp7hrann` ([manager.rs L203-L216](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/manager.rs#L203-L216), [L1717](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/manager.rs#L1717)).
- Le refresh token renvoyé par le serveur remplace l'ancien dans `auth.json` et met à jour `last_refresh` ([persist_tokens, L1599](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/manager.rs#L1599)). C'est donc bien une rotation.
- `refresh_token_reused` est classé comme échec permanent. Le message affiché indique que le token a déjà servi et demande de se reconnecter ([classify_refresh_token_failure, L1679](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/manager.rs#L1679)).
- Codex rafraîchit de lui-même quand l'access token expire dans moins de 5 minutes, ou quand `last_refresh` date de plus de 8 jours ([should_refresh_proactively, L3004](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/manager.rs#L3004)).
- Avant chaque refresh, Codex relit `auth.json` sur le disque et réutilise le fichier si un autre processus l'a déjà rafraîchi ([refresh_token, L2848](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/login/src/auth/manager.rs#L2848)). Cette protection ne vaut que pour des processus qui partagent le même fichier, donc sur une seule machine.
- `account/read` avec `refreshToken: true`, l'appel qu'utilise le proxy, déclenche ce refresh à chaque fois ([account_processor.rs L1026-L1030](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/app-server/src/request_processors/account_processor.rs#L1026-L1030)). Le proxy ne l'appelle qu'une fois l'access token expiré (`src/server/credentials.ts`), ce qui limite les rotations.

**Ce qu'en dit un mainteneur.**
- Selon Eric Traut (`etraut-openai`), le serveur accepte qu'un refresh token serve plusieurs fois pendant une fenêtre limitée, de l'ordre d'une heure, avant de l'invalider définitivement ([commentaire du 2026-02-01, issue #10332](https://github.com/openai/codex/issues/10332#issuecomment-3831635259)).
- Sa [PR #11802](https://github.com/openai/codex/pull/11802) décrit le cas d'une instance dont le refresh token en cache devient invalide après qu'une autre instance a rafraîchi.
- GitHub affiche son rôle comme `CONTRIBUTOR`. Son appartenance à l'organisation est déduite de son identifiant et de ses PR fusionnées.

**Conséquence pour un même `auth.json` partagé entre la CI et le Mac** (déduction tirée des sources ci-dessus) :
1. Le premier qui rafraîchit, par exemple la CI, reçoit un nouveau refresh token.
2. L'autre conserve l'ancien.
3. Passé la fenêtre de tolérance, cet ancien token est rejeté avec `refresh_token_reused`, et la session concernée doit refaire `codex login`.

Rien ne dit, en revanche, si une réutilisation tardive invalide aussi le nouveau token, ce qui révoquerait toute la famille de tokens. Le guide CI/CD se contente d'interdire ce partage.

### 3.3 Stocker `auth.json` ou un token dans les secrets GitHub Actions

**Côté OpenAI.** Il faut traiter `auth.json` comme un mot de passe et ne jamais le stocker dans le dépôt, les logs ou des artefacts publics ([Auth, credential storage](https://learn.chatgpt.com/docs/auth#credential-storage), [CI/CD rules](https://learn.chatgpt.com/docs/auth/ci-cd-auth#operational-rules-that-matter)). Pour la réécriture après un run, l'exemple « runner éphémère » utilise un outil fictif et ne décrit aucun mécanisme GitHub ([#ephemeral-runners…](https://learn.chatgpt.com/docs/auth/ci-cd-auth#ephemeral-runners-restore-run-codex-persist-the-updated-file)).

**Côté GitHub.**
- **Limites.** Un secret pèse 48 Ko au plus. On peut en stocker 1 000 par organisation, 100 par dépôt et 100 par environnement ([limits for secrets](https://docs.github.com/en/actions/reference/security/secrets#limits-for-secrets)).
- **Moment de lecture.** Les secrets de dépôt sont lus quand le run entre dans la file d'attente, ceux d'environnement au démarrage du job ([when GitHub Actions reads secrets](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets)). Un run déjà en attente peut donc recevoir un `auth.json` périmé ; un secret d'environnement réduit ce risque.
- **Données structurées.** GitHub déconseille de stocker du JSON dans un secret, parce que le masquage dans les logs peut alors échouer. Il recommande un secret par valeur sensible et une rotation régulière ([never use structured data](https://docs.github.com/en/actions/reference/security/secure-use#never-use-structured-data-as-a-secret), [audit and rotate](https://docs.github.com/en/actions/reference/security/secure-use#audit-and-rotate-registered-secrets)). `auth.json` est justement du JSON.
- **Écriture par l'API.** Récupérez d'abord la clé publique avec `GET /repos/{owner}/{repo}/actions/secrets/public-key`. Envoyez ensuite `PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}` avec `encrypted_value`, chiffré avec libsodium, et `key_id`. La réponse est 201 à la création, 204 à la mise à jour ([create or update a repository secret](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret)).
- **Permissions.** Il faut le scope `repo` pour un PAT classique, ou la permission « Secrets » en écriture pour un token fine-grained ([permissions fine-grained, Secrets](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-secrets)).
- **`GITHUB_TOKEN`.** Sa liste de permissions ne contient aucune permission « secrets » ([workflow syntax, permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)). Il faut donc un PAT ou un token de GitHub App présent dans le même job que Codex, ce qui élargit la surface d'exposition.
- **Sérialisation.** La clé `concurrency` garantit au plus un job actif par groupe ([workflow syntax, concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)). C'est la condition « flux sérialisé » demandée par OpenAI.

### 3.4 Conditions d'utilisation pertinentes

- **Terms of Use, hors EEE** (« Effective: January 1, 2026 »), [row-terms-of-use](https://openai.com/policies/row-terms-of-use/) :
  - Section *Registration and access* : il est interdit de partager ses identifiants ou de rendre son compte accessible à quelqu'un d'autre, et l'utilisateur répond de toute activité sur le compte.
  - Section *What you cannot do* : il est interdit d'extraire automatiquement ou par programme des données ou de l'Output, et de contourner les rate limits ou les protections.
- **Europe Terms of Use** (« Updated: January 16, 2026 »), applicables en France, [eu-terms-of-use](https://openai.com/policies/eu-terms-of-use/) : les mêmes clauses figurent dans les mêmes sections.
- **Sign in with ChatGPT Terms** (29 septembre 2026), [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) :
  - §1 : un stockage persistant des tokens doit rester local, jamais dans un environnement distant ou géré.
  - §2 : les requêtes doivent partir du runtime de l'utilisateur, et l'application ne doit pas offrir d'accès API généraliste à d'autres outils.
  - §4 : pas de partage ni de mutualisation des tokens ou de l'usage.
  - Ces conditions régissent les applications qui intègrent SIWC. Leur application à un proxy construit sur le client Codex n'est pas établie, mais elles montrent la ligne d'OpenAI.
- **Page App Server** ([#auth-endpoints](https://learn.chatgpt.com/docs/app-server#auth-endpoints)) : l'authentification app-server n'a jamais été autorisée pour un service commercial ou hébergé.

**Lecture pour ce projet** (déduction) :
- Un proxy personnel, local ou joignable seulement sur son propre Tailscale, utilisé par son titulaire, reste proche de l'usage que la page app-server tolère pour une application locale.
- L'ouvrir à d'autres personnes, l'héberger ou s'en servir comme API générale pour d'autres outils heurte les ToU (partage d'identifiants, extraction programmatique) et l'esprit des SIWC Terms.
- En CI, la voie conforme est une clé API, ou un access token si le compte est Business ou Enterprise. Le guide CI/CD n'admet la copie d'`auth.json` que sur un runner privé.

---

## Non confirmé / à vérifier

1. **Fenêtre de tolérance d'environ une heure** pour réutiliser un refresh token. Elle ne repose que sur un commentaire de mainteneur, et rien ne dit si une réutilisation tardive révoque aussi le token le plus récent.
2. **Durées de vie SIWC** (1 h et 30 jours). Elles ne sont pas confirmées pour le client Codex CLI `app_EMoamEEZ73f0CkXaXp7hrann`.
3. **Filtrage de `/models` selon `client_version`.** Que le serveur filtre en fonction de `minimal_client_version` est une déduction : aucun document public ne décrit `chatgpt.com/backend-api/codex`. Il faut vérifier qu'un `client_version` 0.155.0 affiche bien `gpt-6.1-sol` (`minimal_client_version` 0.153.0 dans le catalogue embarqué).
4. **Routage par espace de travail.** La doc ne dit pas quels comptes reçoivent une `workspace_backend_origin` différente de `chatgpt.com`. Le proxy n'est concerné que si l'espace a une contrainte de résidence `us` ou `us_cr`.
5. **Page App Server non datée.** On ne sait pas depuis quand elle contient la phrase sur les services commerciaux ou hébergés. La date d'ajout du multiplexage `stream_id` est également inconnue.
6. **Plans éligibles aux access tokens.** La page Auth parle d'Enterprise seulement, la page Access tokens de Business et Enterprise.
7. **Entrée `codex-home` de `openai/codex-action`.** Rien n'indique qu'y déposer un `auth.json` soit supporté.
8. **Ordre de `/releases/latest`.** Le risque qu'un correctif sur une ancienne branche passe devant une version plus récente est théorique : il découle de la règle de tri documentée et n'a jamais été observé.
9. **Changements de 0.158.0 à 0.160.0.** Ils ont été vérifiés en comparant les en-têtes, les chemins et le schéma, mais pas en lisant chaque ligne de diff. Une modification de comportement qui ne toucherait aucun de ces éléments a pu échapper à la comparaison.
10. **Pages d'aide help.openai.com.** Elles n'affichent qu'une date relative (« Updated … ago »). Elles n'ont pas servi de preuve et n'ont pas été relues pour la période du 1er au 5 octobre.
11. **Fil openai.com/news.** Il a été lu dans un navigateur le 2026-10-05, en se limitant aux articles affichés en tête. Une annonce publiée ailleurs, sur un blog produit ou dans les notes de version de ChatGPT, a pu échapper à ce relevé.
12. **Sources indirectes non confirmées.** Les affirmations qui ne figurent dans aucune source primaire ont été écartées. Aucune n'a été utilisée comme preuve dans ce document.
