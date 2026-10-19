# Frontière de compatibilité Codex CLI / Desktop et API OpenAI

Recherche documentaire du **2026-10-16**, sources primaires uniquement. Périmètre : dépôt officiel `openai/codex`, documentation OpenAI et quelques issues/PR ciblées. Aucun lancement de Codex ou de Desktop, aucune lecture d'identifiants, aucun appel d'inférence ou changement système. Cette note ne constitue pas une nouvelle validation du proxy.

## Conclusion

**Desktop expose effectivement davantage qu'une simple interface texte, mais ses fonctions ne constituent pas un serveur compatible avec toute l'API OpenAI.** Il faut distinguer :

1. le protocole local d'agent **app-server** (`thread/*`, `turn/*`, notifications, permissions, historique) ;
2. le transport d'inférence **Responses**, HTTP/SSE ou WebSocket ;
3. les services spécialisés (images, voix, transcription), avec leurs propres formats, authentification et conditions d'accès.

Le code confirme des chemins natifs images et realtime. En revanche, les recherches bornées ne démontrent pas une implémentation Codex des contrats publics `background`, Conversations, comptage préalable des tokens ou stockage Responses. Un historique Desktop, une tâche longue ou une compaction en arrière-plan ne sont pas ces contrats.

## Référence de version

L'[API de dernière release stable](https://api.github.com/repos/openai/codex/releases/latest) renvoyait **`rust-v0.163.0`**, publiée le **2026-10-15 à 21:30:38 UTC** ([release](https://github.com/openai/codex/releases/tag/rust-v0.163.0)). Le [commit résolu depuis ce tag](https://api.github.com/repos/openai/codex/commits/rust-v0.163.0) est **`83086188ae0614bd882818ff1aa23f3194962012`**. Les liens de code ci-dessous sont figés sur ce commit ; la documentation web est celle consultée le 16 octobre, sans garantie qu'elle corresponde exactement au binaire Desktop distribué.

La release mentionne notamment les interruptions immédiates, la restauration des permissions, la voix realtime v3 et l'infrastructure de compaction asynchrone. Cela ne promet pas des routes API supplémentaires. La version de la CLI autonome ne prouve pas la version embarquée dans Desktop.

## Ce qui est établi, et ce qui ne l'est pas

| Surface | Preuve consultée | Conclusion pour un proxy compatible OpenAI |
|---|---|---|
| Création Responses | [`ResponsesApiRequest`, `ResponseCreateWsRequest`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/common.rs), [construction de requête](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/client.rs#L956-L1080) | Natif côté client Codex ; construction avec `store: false`, `stream: true`. Ce sous-ensemble n'est pas toute la spécification publique. |
| Continuation | Même schéma WebSocket : `previous_response_id` ; [cycle de vie du client](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/client.rs#L1-L28) | Continuation et réutilisation de socket existent ; ne pas les assimiler à une persistance durable récupérable après reconnexion. |
| Stockage Responses | `store: false` dans la construction ; aucun client de retrieve/delete/input-items dans le [module des endpoints inspecté](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/mod.rs) | Pas de preuve de stockage Responses natif dans ce périmètre. Un stockage du proxy reste une émulation dont il faut annoncer durée, pertes au redémarrage et limites. |
| Conversations API | La [documentation publique](https://developers.openai.com/api/docs/guides/conversation-state) décrit `conversation` et un objet durable ; les structures Codex inspectées ne portent pas ce champ | `thread/start`, `thread/list`, `thread/resume` sont une autre API. Une adaptation serait un développement explicite, pas un alias de route prouvé. |
| `background: true`, polling, cancel, reprise SSE | [Contrat public background](https://developers.openai.com/api/docs/guides/background) ; champ absent des deux structures de création inspectées | Pas de preuve Codex de ce lifecycle public. Un objectif `/goal`, un daemon ou une tâche agent longue ne suffisent pas. |
| `POST /responses/input_tokens` | [SDK officiel OpenAI Python](https://github.com/openai/openai-python/blob/main/src/openai/resources/responses/input_tokens.py) : route et objet `response.input_tokens` | Endpoint public réel ; aucun endpoint correspondant trouvé dans le module Codex inspecté, et aucune issue/PR pertinente dans les recherches exactes bornées. Les compteurs `usage.input_tokens` après génération ne prouvent pas ce comptage préalable. |
| Chat Completions | [`WireApi`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider-info/src/lib.rs#L100-L132) ne conserve que Responses et refuse explicitement `wire_api = "chat"` | Pas de transport natif Chat Completions dans cette version. Une traduction vers Responses serait une couche du proxy à spécifier et tester. Cela ne prouve pas l'inexistence de toute route privée côté serveur. |
| Images | [`ImagesClient`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/images.rs), [schémas](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/images.rs), [guide produit](https://developers.openai.com/codex/image-generation.md) | Génération et édition natives documentées dans Desktop **et CLI**. Chemins relatifs `images/generations`, `images/edits`. Édition JSON avec `images` contenant des références, pas preuve de compatibilité multipart publique. Accès du compte non testé. |
| Realtime / voix conversationnelle | [client de création d'appel](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_call.rs), [protocole app-server](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs) | Natif dans le code : audio, texte, WebRTC, appel existant, notifications ; nombreux éléments marqués expérimentaux. Ne prouve pas une API générique `/v1/audio/*` ou `/v1/realtime` interchangeable. |
| Dictée Desktop | [Issue #20668 et commentaire du 23 septembre](https://github.com/openai/codex/issues/20668#issuecomment-5802046099) | Signal d'un chemin distinct `/backend-api/transcribe`, hors `/backend-api/codex`. C'est un diagnostic utilisateur sur des versions indiquées, pas une observation de cette recherche ni une preuve de code Desktop actuel. |

### Images : ne pas confondre natif et fallback API payant

Le [guide actuel](https://developers.openai.com/codex/image-generation.md) annonce la génération intégrée `gpt-image-2`, imputée aux limites générales Codex, dans l'app, la CLI et l'IDE. Il propose aussi une clé API pour les gros lots. La [documentation du skill embarqué](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/skills/src/assets/samples/imagegen/references/codex-network.md) précise que son script CLI de fallback utilise l'API Images publique. Ce sont deux chemins distincts : la présence d'un script exigeant une clé API n'invalide pas le client natif ; inversement, le natif ne rend pas tous les paramètres publics utilisables.

Les tests source d'`ImagesClient` vérifient le JSON envoyé et la lecture de `b64_json` sur un transport simulé. Ils n'établissent ni la disponibilité serveur, ni les droits d'un abonnement, ni une génération réussie à cette date.

### Realtime : différence de format concrète

Dans [`create_with_session_and_headers`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_call.rs), un fournisseur contenant `/backend-api` reçoit **du JSON `{sdp, session}`** vers `realtime/calls`. Le chemin API public reçoit un multipart `sdp` + `session` ; le mode Frameless Bidi peut viser `live` au lieu de `realtime/calls`. Le code ajoute parfois `intent=quicksilver&architecture=avas`.

Le [client realtime WebSocket](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs) distingue connexion standalone et sideband d'un appel WebRTC ; sa base sideband par défaut est `https://api.openai.com/v1`. Les [adaptateurs](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_common.rs) distinguent V1, RealtimeV2 et FramelessBidi. Un simple remplacement de préfixe URL et relais de frames ne suffit donc pas à démontrer la compatibilité de toutes ces variantes.

Le [guide voix produit](https://developers.openai.com/codex/features/voice.md) distingue voix conversationnelle et dictée, et conditionne la disponibilité au plan, au rollout et aux réglages de l'espace de travail. Aucune preuve d'implémentation native des endpoints publics de traduction audio ou TTS HTTP n'a été identifiée dans les fichiers ciblés ; cela n'est pas un inventaire exhaustif de tous les services Desktop privés.

### WebRTC : adaptation locale du 17 octobre

Le ticket #26 ajoute une adaptation **d'enveloppe seulement**, testée avec OpenAI Node 7.20.0 et un upstream HTTP local via le gateway intégré. Le [SDK public](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/realtime/calls.ts) émet un multipart avec `sdp` (`application/sdp`) et `session` (`application/json`), session optionnelle. Le client Codex figé ci-dessus contient les deux mécanismes correspondants : SDP brut dans `create_with_headers`, JSON `{sdp,session}` dans la branche backend de `create_with_session_and_headers`. Le proxy préserve la session entière et les queries explicites, sans supprimer silencieusement d'options ni ajouter de routage.

**Limite vérifiée par source :** ce client refuse `RealtimeV2` pour les appels AVAS. [`methods_v1.rs`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v1.rs) construit `type: quicksilver`, PCM 24 kHz, voix native ; le chemin frameless a encore un autre schéma. Il n'existe donc pas ici de preuve d'équivalence sémantique de toutes les options de session publiques `type: realtime`. L'adaptation ne change pas ce type, ne fabrique pas de token et ne contourne pas une attestation. Les pistes multipart Desktop `/realtime/wm`, `/realtime/vp`, `/realtime/vps` restent hors préfixe autorisé, pas des fallbacks.

La réponse doit contenir un identifiant natif valide `rtc_*` ou UUID dans `Location` ; le proxy conserve cet identifiant, mais ne retourne que le chemin local sans query/destination native. Une réponse sans identité valide produit une erreur générique sans SDP/Location privée. L'appel upstream a alors peut-être été créé : pas de retry ni hangup automatique d'un effet incertain. Le SDP et la session ne sont pas persistés par l'adaptateur. La réponse SDP est reçue intégralement sous la borne de taille et doit être UTF-8 avant de retourner un succès, pour éviter un SDP tronqué présenté comme valide. Les contrôles `accept`, `reject`, `refer`, `hangup`, les credentials éphémères et la famille `live` restent des relais distincts, **non testés live** ; création-client n'est pas preuve de ces opérations. La fermeture HTTP ne prouve pas la fermeture du peer ou de l'appel distant.

Validation locale du 17 octobre : 11 tests SDK/HTTP de cette tranche, suite produit 229/229, TypeScript/build/lint réussis (infos lint préexistantes conservées). Navigateur Edge réel contre app/gateway et upstream exclusivement locaux : FormData, authentification locale et refus 401, identité retournée, absence de SDP/query/secrets dans l'activité ; qualification et exemple visibles à 1280 et 390 pixels, sans débordement horizontal ni erreur JavaScript. Il ne s'agit pas d'une connexion à un peer WebRTC réel. Aucun credential réel, micro, appel backend ni quota n'a été utilisé.

**Probe utile réservée au coordinateur, non exécutée :** si le coordinateur choisit WebRTC plutôt que WS pour l'unique budget partagé, préparer un `RTCPeerConnection` navigateur sans `getUserMedia`, avec audio `recvonly` et canal de données, puis son SDP `createOffer`/`setLocalDescription`. Envoyer exactement `POST /v1/realtime/calls`, Bearer **local**, multipart `sdp=<offre locale>` et `session={"type":"realtime","model":"gpt-realtime","instructions":"Say WEBRTC_OK once, then remain silent."}`. Cette tentative teste le contrat public sans forcer la query AVAS. Arrêter après **10 secondes maximum depuis le début de la tentative**, sans retry ; fermer canal/peer dans `finally`, sans lecture micro ni playback. Observer le statut/refus expurgé et, uniquement en cas de succès, identité locale, `setRemoteDescription`, établissement du transport et un résultat audio reçu décodable/transcription correspondant à `WEBRTC_OK` (aucun simple HTTP 200 ne suffit). Conserver uniquement une synthèse, pas les SDP/candidats ICE, tokens ou trames privées. Ne pas exécuter un hangup distant non autorisé ; si une garantie de fermeture serveur est exigée avant l'essai, établir son mécanisme autorisé d'abord. À défaut de session publique acceptée, le refus reste qualifié ; aucune conversion automatique vers quicksilver, route Desktop ou jeton inventé. Une session WS réussie n'établit aucun de ces résultats WebRTC, et n'est pas un prérequis à cette adaptation.

Après ouverture du canal de données public, la probe peut demander explicitement le résultat avec ces deux événements (pas d'hypothèse que les seules instructions déclenchent une réponse) :

```json
{"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"Say WEBRTC_OK once."}]}}
{"type":"response.create","response":{"output_modalities":["audio"]}}
```

Un refus de ces événements/protocole doit rester visible. La réception RTP seule ne prouve ni un audio décodable ni la consigne ; le coordinateur doit disposer avant l'essai d'un récepteur/décodeur local sans playback et d'une observation du résultat, sinon qualifier la probe comme transport seulement ou choisir WS pour ce budget partagé.

## Desktop et CLI : trois connexions à ne pas mélanger

La [documentation app-server actuelle](https://developers.openai.com/codex/app-server) expose :

- **Clients → app-server** : JSON-RPC bidirectionnel, sans propriété `jsonrpc` sur le fil. Transports JSONL sur stdio, une requête par frame texte WebSocket, et WebSocket sur socket Unix. Initialisation `initialize` puis notification `initialized` ; certains champs/méthodes exigent `experimentalApi`.
- **App-server → modèle** : Responses HTTP/SSE ou WebSocket. Le [client source](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/client.rs) conserve la connexion et gère le fallback HTTP ; ce ne sont pas les messages JSON-RPC `thread/*`.
- **Voix / autres services** : transports et routages spécialisés décrits ci-dessus. La doc d'initialisation mentionne aussi `requestAttestation`, pour qu'un hôte Desktop fournisse un token opaque d'attestation upstream. Ce n'est pas un champ de la requête Responses ni une capacité à fabriquer côté proxy.

La CLI peut elle-même se connecter à un app-server distant via `--remote` ; le protocole n'est donc pas réservé à Desktop. Le [README source app-server](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/README.md#L197-L202) mentionne explicitement les sessions Desktop locales stdio. Cela ne prouve pas que toutes les builds Desktop n'utilisent que ce transport.

La documentation avertit que l'app-server/WebSocket est expérimental et non supporté pour des workloads de production. Elle décrit l'authentification WebSocket et demande TLS hors local ; elle signale aussi que des listeners non-loopback restent sans authentification par défaut pendant le rollout. Ne pas exposer un listener brut pour obtenir une pseudo-API OpenAI.

## Issues et PR réellement approfondies

Métadonnées, description et commentaires des quatre issues ci-dessous ont été lus via GitHub ; pour les deux PR, description et liste des fichiers modifiés ont été examinées, puis rapprochées des sources de la release. Les commentaires d'utilisateurs ne sont pas traités comme une validation OpenAI. Les liens seulement cités dans ces commentaires n'ont pas été suivis.

| Référence | État / dates UTC | Ce qu'elle démontre ou ne démontre pas |
|---|---|---|
| [Issue #51081 — Codex Cloud doesn't work with the OpenAI Responses API](https://github.com/openai/codex/issues/51081) | Ouverte ; créée 2026-10-05, mise à jour 2026-10-09 | Rapport d'injection de secrets réseau : appel **à `api.openai.com` avec une clé API** depuis un environnement Cloud. Commentaire utilisateur du 8 octobre : Completions 200, Responses 401. **Pas une preuve que le backend Codex supporte Chat Completions**, ni que le client Codex n'utilise pas Responses. |
| [Issue #43212 — Desktop image generation repeatedly fails with 502](https://github.com/openai/codex/issues/43212) | Ouverte ; créée 2026-09-06, mise à jour 2026-09-25 | Utilisateurs rapportant `Failed to forward Codex image request`, puis un 404 distinct. Confirme un sujet de fiabilité/accessibilité à investiguer, pas l'absence de génération intégrée ni un succès actuel. |
| [Issue #21076 — Desktop history hidden/stale despite local DB](https://github.com/openai/codex/issues/21076) | Ouverte ; créée 2026-05-04, mise à jour 2026-05-25 | Plusieurs utilisateurs distinguent données locales, réponse `thread/list` et sidebar Desktop. Signal cohérent avec le modèle thread documenté ; **ne prouve pas Conversations API ni stockage Responses**. Les recettes de réparation de bases figurant dans les commentaires ne sont pas recommandées ici. |
| [Issue #20668 — Desktop dictation fails in API-key auth mode](https://github.com/openai/codex/issues/20668) | Ouverte ; créée 2026-05-01, mise à jour 2026-10-15 | Rapport et commentaire détaillé du 23 septembre : dictée liée à l'auth ChatGPT et service transcription séparé du fournisseur d'inférence. La suggestion d'utiliser `/audio/transcriptions` est une **demande**, pas une correction fusionnée. Le dernier commentaire est une proposition d'outil tiers, pas une résolution officielle. |
| [PR #52363 — Expand realtime v3 voice support](https://github.com/openai/codex/pull/52363) | Fusionnée 2026-10-09 à 02:04:49 ; citée dans 0.163.0 | Ajoute une liste de voix v3, schémas/types et tests. Preuve de code pour realtime v3 ; pas une annonce de prise en charge générique des endpoints Audio publics. |
| [PR #53614 — Infrastructure for speculative remote V2 compaction](https://github.com/openai/codex/pull/53614) | Fusionnée 2026-10-13 à 08:44:37 ; citée dans 0.163.0 | Décrit captures d'historique, routage, propriété auth et requêtes HTTP en arrière-plan ; dit que son helper n'est pas encore branché à la boucle au stade de cette PR. Le [code de tentative de compaction](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/compact_remote_v2_attempt.rs) porte ce travail. **Ce background interne n'est pas le paramètre Responses `background: true`.** Ne pas généraliser la phrase de la PR à toutes les évolutions ultérieures. |

### Bornes de recherche

Recherches GitHub limitées à 5–6 résultats par requête, dans `openai/codex` : `"input_tokens"`, `"input_tokens" "endpoint"` (issues et PR), `"background" "responses"`, `"background=true"`, `"store" "false" "responses"`, `"chat completions"`, `"conversations" "API"`, `"image generation"`, `"audio/transcriptions"`, et PR `"realtime"` / `"background" "compaction"`. Les requêtes exactes sur un endpoint input-tokens n'ont pas produit de résultat pertinent ; les autres résultats ont servi à sélectionner les six éléments approfondis, pas à inventorier des milliers d'issues.

Inspection source ciblée au tag : arbre des fichiers, modules d'endpoints `codex-api`, structures de requêtes Responses, construction du client, types fournisseur, images, realtime HTTP/WebSocket, protocole realtime app-server, README app-server et documentation du fallback imagegen. **Pas de recherche exhaustive dans chaque fichier du dépôt, ni de rétro-ingénierie du binaire Desktop.** Deux URLs supposées de la référence input-tokens ont renvoyé 404 ; le contrat a été vérifié dans le SDK officiel à la place.

## Décisions de cette session et questions restantes

L’utilisateur a déjà retenu la compatibilité OpenAI étendue : Chat Completions, cycle Responses complet, Conversations persistantes, Images, Audio et Realtime. Les traductions et implémentations locales fidèles sont autorisées, à condition de les distinguer explicitement du natif et de refuser les fonctions sans équivalence fidèle. Ces choix ne sont pas à redemander.

La CLI installée et Desktop sont toutes deux sélectionnées comme références. Le téléchargement et l’inspection statique de la distribution macOS officielle sont autorisés, sans installation ni lancement. Cette mission documentaire n’a pas effectué cette inspection : voir les notes statiques séparées et leurs limites.

Restent à préciser avant les développements concernés :

1. **État local** : rétention, quotas, isolation des données et comportement des jobs après interruption. Les capacités thread d’app-server ne règlent pas automatiquement ces contrats publics.
2. **Médias** : disponibilité réelle des chemins natifs et éventuels prérequis. Aucun recours à une API payante distincte ni ajout de moteur local n’est autorisé implicitement.
3. **Sécurité des destinations** : un chemin Desktop hors du préfixe Codex est une question à instruire, pas une autorisation d’élargir les destinations recevant les identifiants.

Les sources suffisent à corriger une affirmation « Codex ne fait ni images ni voix ». Elles ne suffisent pas à annoncer « tous les endpoints OpenAI fonctionnent avec l'abonnement ». Les droits du compte, le comportement serveur actuel et la parité du proxy restent non testés dans cette recherche.
