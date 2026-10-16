# Desktop officiel — inspection statique et frontière de compatibilité

Observation du 16 octobre 2026 avec REA CLI 6.5.0. Mandat : télécharger et inspecter la distribution macOS officielle, sans installer ni lancer l’application. Aucun accès aux comptes, profils, identifiants ou backend. Aucun changement du proxy ou de sa configuration.

## Conclusion bornée

**Desktop contient des chemins supplémentaires concrets pour les conversations ChatGPT, les automatisations, les images et la voix. Cela ne démontre pas que le proxy Codex peut les exposer.** Les appels observés utilisent plusieurs familles de protocoles : RPC `thread/*` de l’app-server, services HTTP internes de Desktop, conversations ChatGPT avec reprise SSE et négociation vocale WebRTC. Ils ne constituent pas un serveur OpenAI public interchangeable avec `/backend-api/codex`.

- **Chat Completions : non établi.** Aucun littéral `chat/completions` dans la recherche bornée des JavaScript applicatifs ; une conversation ChatGPT n’est pas une preuve du contrat `/v1/chat/completions`.
- **Conversations : chemins concrets présents**, avec historique serveur, préparation, streaming, reprise et annulation. Leur équivalence avec l’API publique Conversations n’est pas établie.
- **Background : automatisations et travail durable présents dans le code**, mais aucune preuve du paramètre public Responses `background: true`, de son polling ou de son annulation.
- **Images : appel POST de génération et d’édition effectivement relié à un consommateur UI**, sous `/wham/images/*`, pas sous un contrat Codex démontré.
- **Audio/realtime : négociation vocale SDP/WebRTC et RPC realtime de threads présents**. Aucun appel public Audio transcription/speech démontré, ni équivalence avec l’API publique Realtime.

« Présent » signifie ici code statique inspecté, jamais activation pour un compte ni réussite réseau.

## Origine et identité

La [page officielle `/codex/app/`](https://developers.openai.com/codex/app/) est intitulée **ChatGPT desktop app**, tout en proposant [le fichier `Codex.dmg`](https://persistent.oaistatic.com/codex-app-prod/Codex.dmg). Le téléchargement sélectionné n’a pas été remplacé par un autre produit. La page HTML et les en-têtes du téléchargement sont conservés dans les preuves locales (`DESKTOP-SOURCE-01`, `DESKTOP-DMG-01`).

| Artefact | Observation |
|---|---|
| `Codex.dmg` | 787 927 533 octets ; SHA-256 `1bc4b5fa0c1010ec043e8e815d6ee23a5f84aa3c1248aa4ae0624c7d6f1de864` |
| Application dans le DMG | `ChatGPT.app` ; identifiant `com.openai.codex` ; version `26.1013.31256` ; build `20586` ; nom alternatif `Codex` |
| Manifeste `app.asar/package.json` | `openai-codex-electron`, `productName: Codex`, version `26.1013.31256`, entrée `.vite/build/early-bootstrap.js` |
| `Contents/Resources/app.asar` | SHA-256 `bf9c41fa9770fbfacfba93042ff71c24cb65c82935819377275faac08103383f` ; 21 171 fichiers dans l’en-tête ASAR |
| Signature déclarée | `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)` ; identifiant `com.openai.codex` ; arm64 ; hardened runtime. Inspection des métadonnées de signature, pas vérification complète de notarisation ni garantie de tous les contenus |

Sources : Evidence **P**, **S**, **I** ci-dessous et enregistrement `DESKTOP-IDENTITY-01`.

### CLI embarquée : comparer le vrai Mach-O, pas le wrapper

`Contents/Resources/codex-cli/bin/codex` est un **script shell**, qui résout ses liens puis exécuterait `../CodexCLI.app/Contents/MacOS/codex`. Aucun des deux n’a été exécuté.

Le manifeste `codex-cli/codex-package.json` déclare `0.163.0-alpha.10.2`, cible `aarch64-apple-darwin`, variante `codex`. Le Mach-O embarqué fait 249 954 368 octets, avec SHA-256 **`1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe`**. Le wrapper a un digest distinct, `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` ; il ne doit pas servir à comparer les exécutables natifs.

La [CLI locale inspectée séparément](2026-10-16-codex-cli-static.md), rangée sous `0.163.0`, a le SHA-256 `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`. **Les octets ne sont donc pas identiques.** Les versions sont des métadonnées de packaging, non des sorties `--version`. Le comportement de la CLI embarquée ne peut pas être déduit par simple transfert de l’analyse de la CLI locale. Source : `DESKTOP-CLI-01`.

## Chemins inspectés : entrées, consommateurs et état

Les noms minifiés et suffixes des fichiers sont propres à ce build. Les offsets conservés dans les enregistrements de contexte sont des positions de texte décodé, pas des adresses natives. Les extraits sont reliés aux digests de `selected-source-manifest.json` et vérifiés contre les octets ASAR (`DESKTOP-VERIFY-01`).

### 1. Deux transports internes, pas un endpoint HTTP public unique

**RPC app-server :** `preload.js` expose `electronBridge.sendMessageFromView`, qui invoque `codex_desktop:message-from-view`. Le handler principal vérifie l’origine IPC et remet le message au contexte de fenêtre. Le cas `mcp-request` remet la requête à `getAppServerConnection(hostId).handleClientRequest(...)` ; réponses et erreurs repartent vers la vue. C’est un chemin concret d’acheminement de requêtes `thread/*`, pas une preuve de route REST.

**HTTP actuel :** dans `app-shared-01b9f268c4a3.js`, le service exporté `urt` (`D1` dans ce build) fait `sendRequest → fetchJson → fetch → Sxt → httpFetch.fetch`. Le main fournit ce service dans l’app-host et l’adapte à `fetchWrapper.fetchHttp → performDesktopFetch`. Ce dernier vérifie notamment l’origine autorisée pour l’authentification et l’identité attendue. Le vieux message IPC `fetch` est réservé à des chemins particuliers ; `handleRequest` rejette les autres requêtes avec « HTTP requests must use the HTTP fetch service ». Il serait incorrect d’attribuer tous les appels HTTP au vieux canal IPC.

Sources : **J**, `DESKTOP-TRANSPORT-01`, `DESKTOP-HTTP-RPC-01`, `DESKTOP-SERVICE-01`. Points d’entrée utiles : `preload.js` offset 3430 ; main offset 2150326 (`mcp-request`) ; app-shared offset 1972514 (`httpFetch`) ; main offset 3582069 (service fourni).

### 2. Conversations ChatGPT et reprise

Dans `app-initial-3ccf4886957f.js` :

1. Le consommateur de soumission appelle `startCompletionStream` avec identité attendue, signaux d’annulation et callbacks de transport/décodage.
2. La préparation utilise `POST /f/conversation/prepare`, puis l’envoi utilise `streamPost('/f/conversation', ...)`. Des en-têtes d’intégrité et de conduit sont calculés ; un chemin de retry peut les rafraîchir.
3. `createCompletionStreamHandlers` décode les événements avec `jNr`, puis transmet `event.update` à `onUpdate`, et les événements décodés au consommateur. Le consommateur enregistre le stream, gère la clôture, les états terminal/interrompu/échec et la restauration d’une soumission refusée.
4. `POST /f/conversation/resume` reprend avec `conversation_id`, offset et token de conduit ; le code contient aussi une reprise par topic WebSocket. `POST /stop_conversation` annule une génération.
5. L’historique est chargé via `GET /conversation/{conversation_id}` et, selon le chemin, `/conversations/{conversation_id}/messages`, avec vérification de l’identité avant/après chargement. La sélection d’un nœud utilise PATCH puis met à jour le nœud courant dans l’état client.

Sources : `DESKTOP-CONTEXTS-01`, `DESKTOP-CONVERSATION-01`, `DESKTOP-CONSUMER-01`. Offsets : 4346317 (envoi), 4351500 (préparation), 4356808 (reprise), 4357639 (handlers), 6976740 (consommateur).

**Inférence :** le bundle contient un client de conversations ChatGPT distinct du client de threads Codex. **Inconnues :** chemin complet de chaque variante de conversation, contrat serveur courant, activation, droits, compatibilité avec les objets publics OpenAI et fonctionnement avec la seule session Codex du proxy. Les noms relatifs `/f/*` ne suffisent pas à déterminer une URL finale pour chaque variante.

### 3. Automatisations et arrière-plan

Le bundle appelle `/automations`, `/automation/{automation_id}` et `POST /automation/{automation_id}/run`. Le consommateur de lancement reçoit une clé d’idempotence, affiche l’état de départ et invalide les requêtes de catalogue à la fin. Le changement de statut via `/automations/set_status` met à jour les caches de liste et de détail après succès. Dans le main, une automatisation heartbeat lance un turn app-server et attend les notifications `turn/started` et de complétion, avec arrêt sur erreur ou délai dépassé.

Sources : `DESKTOP-CALLS-01`, `DESKTOP-TRACES-01`. Ce sont des automatisations et cycles de vie de threads, **pas une implémentation établie de Responses `background: true`**. Aucun littéral `background:true` ou `background:!0` trouvé dans la recherche bornée décrite plus bas ; cela n’exclut pas une construction dynamique ni un autre encodage.

### 4. Images : appel et consommateur établis statiquement

`image-generation-prompt-1c5e4fca9e63.js` importe la fonction de `image-generation-ce8f154044b0.js`. À la soumission d’un prompt non vide, le composant crée un AbortController, passe en chargement, appelle cette fonction, puis transmet le fichier à `onInsert`; les erreurs mettent l’UI en état d’échec.

La fonction exige un compte et un utilisateur connectés, mémorise leur identité et la revérifie après l’attente. Elle envoie **POST `/wham/images/generations`** ou, si une image est fournie, **POST `/wham/images/edits`**, avec `{prompt, images?}`, identité attendue et `ChatGPT-Account-ID`. Elle exige `data[].b64_json`, accepte `png/jpeg/webp`, transforme le premier résultat en fichier et le rend au consommateur.

Sources : **M**, **T**, `DESKTOP-TRACES-01`, `DESKTOP-SERVICE-01`, `DESKTOP-HTTP-RPC-01`. La trace REA par module établit des relations statiques import/containment ; le détail de l’appel, de ses gardes et de la mutation UI provient de la lecture des fichiers hashés. La première recherche REA par chaîne n’a pas trouvé de nœud : ce résultat négatif du graphe n’invalide pas les octets inspectés.

**Inconnues :** origine finale applicable à ce chemin dans chaque configuration, modèles/quotas autorisés, réponse effective, acceptation de la session Codex, équivalence des paramètres publics Images. Cette observation justifie une piste de recherche, **pas l’activation d’une route Images dans le proxy**.

### 5. Voix, WebRTC et realtime de threads

Deux chemins ont été distingués :

- **Voix ChatGPT :** `voice-configuration-manager-9acc72f2148f.js` choisit `/realtime/wm`, `/realtime/vp` ou `/realtime/vps`. `voice-session-parameters-887df4fa50e0.js` construit l’origine `https://chatgpt.com` (ou staging explicitement), envoie un POST multipart contenant `sdp` et `session`, traite la réponse et applique le SDP distant à `RTCPeerConnection`. Le préchauffage retient une session/answer en cache et invalide les candidats périmés. Le module `voice-session-3ffded08f6e3.js` initialise l’état vocal, l’identité de conversation/session et l’état de connexion ; ses erreurs mettent fin au démarrage. Des contrôles d’activation, permissions et identité entourent ces chemins. Le code appelle aussi `/realtime/status` et `/conversation/voice/status`.
- **Realtime Codex :** le renderer appelle `manager.sendRequest('thread/realtime/start', ...)` avec transport `{type: 'existingCall', callId}`, version `v3`, puis expose stop/appendText. Des consommateurs de notifications `thread/realtime/started`, `closed`, transcript et items mettent à jour l’état actif et l’historique de conversation ; le main contient également un enregistreur conditionnel de ces événements. L’acheminement app-server est celui du premier paragraphe, non un `/v1/realtime` automatiquement réutilisable.

Sources : **M**, `DESKTOP-FIRSTPARTY-01`, `DESKTOP-SERVICE-01`, `DESKTOP-TRANSPORT-01`, `DESKTOP-TRACES-01`. Point utile : app-initial offset 12430348 pour `thread/realtime/start`.

**Inconnues :** activation réelle, transport réseau complet après SDP, authentification serveur exacte pour chaque variante et contrat public Realtime. La recherche de littéraux `audio/transcriptions` et `audio/speech` n’a rien trouvé dans le périmètre ci-dessous ; les fonctionnalités de dictée ne prouvent pas ces routes publiques.

## Evidence et reproductibilité

Les Evidence JSON complètes, les entrées de commandes, le DMG, l’ASAR, le Mach-O embarqué et les extraits hashés sont conservés localement **hors du dépôt** dans le dossier d’acquisition `desktop/acquisition-01`. Les chemins privés du poste ne sont pas publiés ici. Les identifiants `DESKTOP-*` désignent des enregistrements locaux auxiliaires, **pas** des Evidence REA ni des observations runtime.

| Repère | Opération / fichier complet | Evidence REA |
|---|---|---|
| P | `inspect_plist` / `plist-evidence.json` | `ev_48a10387473cc5d8138404b2ee0ddbe8f5c9c9c01d08e7672a23e45f50e61e85` |
| S | `inspect_signature` / `signature-evidence.json` | `ev_8ae938cc7a32c9a97af79d045647221381f2879ce49257f7c1d3e08e25134802` |
| I | `inspect_artifact` / `inventory-record-continue-evidence.json` | `ev_f43ecd69838e6b61265d0447744fe9a835d9975842d726195a58e35e354efe43` |
| I, sous-étape | Inventaire canonique / `inventory-canonical-evidence.json` | `ev_27a787b9f8cbf2eeeec3bed66a7a9c420743eea1ac21be0c888c23bffaef969c` ; manifeste `agm_1dc9d90faff4b58014018c3c461fee2afe8313955add0b75868c2b0818e4505f` |
| J | Analyse ciblée main/preload / `javascript-evidence.json` | `ev_dcb67cae1b5cc0b170fb274b4f4983a0a4474eedb64254ed17679d9fc6b49afe` |
| J, vue | Résumé retenu / `javascript-summary-evidence.json` | `ev_61636598c33660513234bf7a5a31d526764f2f8519585613fcda58dc3186d1a7` |
| M | Analyse ciblée médias / `media-javascript-evidence.json` | `ev_54fc8de965d01362d6a4be890986be6e8dc9c670721a92b406f2cf7eefb3a649` |
| M, vue | Résumé retenu / `media-summary-corrected-evidence.json` | `ev_be6842ddf1f00a3f6f01da1499515b4015058c8cf382697224858b7d2036978a` |
| T | Trace entrante du module images / `image-module-trace-evidence.json` | `ev_521ddc329f96f585e8be265336bf03fe1db40d3d92745628cf3e46d8ca2a8520` |
| T, négatif borné | Recherche du seed chaîne / `image-trace-evidence.json` | `ev_3c8dd11422eae78ae752b9a0fe6a0cc520ea9e04a5199330e97768678d15a6d1` ; aucun match, graphe partiel |

### Couverture et limites importantes

- Inventaire de bundle : 24 162 nœuds, 26 630 occurrences, 26 604 arêtes. Ce n’est pas une couverture fonctionnelle.
- L’inventaire initial a échoué sur une contradiction d’intégrité ASAR d’un natif dépaqueté. Une seconde exécution, avec politique explicite `record-and-continue`, a conservé **sept contradictions**, concernant des modules natifs/helpers de Worklouder, better-sqlite3, node-pty et objc-js. Leurs octets restent **observed-untrusted**. Une signature ou une étape de packaging après ASAR peut expliquer ces écarts, mais cette cause n’a pas été démontrée. Aucun correctif des artefacts n’a été appliqué.
- J analyse six chemins sélectionnés (cinq JS et un manifeste), 4 411 482 octets de texte, sans échec de parsing ; M analyse quatre JS, 194 530 octets, sans échec de parsing. Les graphes restent partiels, en particulier les relations dynamiques et les sources non sélectionnées. Les plafonds sémantiques de 500 nœuds/fichier et 2 000 au total entraînent une troncature explicite : aucun graphe de flux complet n’est revendiqué.
- Une recherche textuelle indépendante a parcouru **14 896 fichiers `.js`/`.mjs` empaquetés**, hors `node_modules` et fichiers unpacked (`DESKTOP-FIRSTPARTY-01`). Les non-matches sont bornés aux littéraux déclarés, pas une preuve d’absence de fonctionnalité. Des fichiers inclus peuvent contenir des bibliothèques fusionnées ou des locales.
- 131 fichiers sélectionnés ont été conservés et vérifiés contre les octets ASAR et les SHA-256 déclarés lorsqu’ils étaient présents (`DESKTOP-VERIFY-01`). Le gros renderer principal a été lu par extraits ciblés, pas revendiqué comme analysé sémantiquement en entier par REA.
- Aucun moteur de décompilation native n’était disponible d’après le diagnostic préalable transmis à cette mission ; aucun nouveau diagnostic, installation ou réparation de configuration. Aucun pseudocode de la CLI ou des helpers natifs n’a été produit.
- Aucun test comportemental, login, trafic backend ou lecture d’un profil utilisateur. Les contrôles vus dans le code sont des observations statiques, pas une validation de leur efficacité runtime.

## Nettoyage et prérequis restants

Le DMG a été monté uniquement en lecture seule, `nobrowse`, dans un point de montage propre à l’acquisition. **Ce montage a été démonté avec succès** ; le dossier de montage est vide (`DESKTOP-CLEANUP-01`, `unmount.txt`). Les preuves reproductibles sont conservées. Aucune application installée/lancée, aucun xattr modifié, aucune production touchée.

Avant toute extension du proxy : établir séparément l’authentification et l’origine permises pour chaque famille, vérifier les droits et le contrat de réponse par une expérience expressément autorisée, puis décider si une adaptation est légitime. L’inspection native de l’embarqué nécessiterait un moteur disponible et un mandat distinct si son installation est requise. **Ne pas déplacer les identifiants Codex vers les nouveaux chemins sur la seule base de ces observations.**
