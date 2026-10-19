# oai-codex-server

Un serveur compatible OpenAI devant la session ChatGPT de Codex installée sur ce Mac. Bun sert le proxy, le dashboard et la documentation Scalar. Les sources officielles conservées dans `upstream/` et l'atlas existant restent des références indépendantes.

## Démarrage

Prérequis de construction : Bun 1.4.3, Node.js 18+ avec npm, Python 3.10+ et un accès HTTPS public à `api.github.com` et `raw.githubusercontent.com`. Depuis un clone propre, restaurer les dépendances et le contrat ignoré par Git avant le build ou les tests :

Bun 1.4.3 est épinglé pour le projet, la CI et la base Docker : les diagnostics locaux inchangés terminent réellement l'arrêt WebSocket avec cette version, contre un blocage sous 1.3.13, cohérent avec le [signalement upstream](https://github.com/oven-sh/bun/issues/36223). Cette preuve locale ne détermine pas la première version stable corrigée et ne valide ni Docker ni l'accès backend.

```sh
bun install --frozen-lockfile
(cd codex-contract-atlas && env -u GITHUB_TOKEN -u GH_TOKEN npm run snapshot)
```

Le collecteur existant utilise les révisions épinglées dans [son package.json](codex-contract-atlas/package.json) : Codex `a956835d020762cb2b570053af06f643a11c0ecc`, OpenAPI `ddface9bd361f5fe37943291d23ee2ca72cbcc2b`. Il télécharge uniquement des sources publiques, sans session Codex ni token GitHub. Cette source OpenAPI est JSON : aucune installation PyYAML n'est nécessaire.

Le collecteur termine actuellement avec **2** : seule la source secondaire `compact` (`codex-rs/codex-api/src/endpoint/compact.rs`) est absente au SHA Codex épinglé (HTTP 404). Ce n'est pas un succès du snapshot complet. Examiner `codex-contract-atlas/snapshot/source-manifest.json` : l'entrée `openapi` doit être `fetched` à la révision ci-dessus, sans erreur de résolution des commits. Arrêter en cas d'autre erreur ou source `failed` (réseau, contrat absent/invalide ou empreinte différente), sans recopier un snapshot local ni créer de substitut. Vérifier les deux empreintes OpenAPI du [verrou existant](codex-contract-atlas/research/source-lock.json), source originale puis JSON normalisé :

```sh
echo '9b3fe0902e71ad60004949c1b4bef39b79503c39506466c283a613f9fa65aea9  codex-contract-atlas/snapshot/openai/openai-openapi/openapi.json' | shasum -a 256 -c -
echo '9050474c9217015eea50ed89af179be5cb05496f50ef119836ca4a28a94bc1fd  codex-contract-atlas/snapshot/openapi.json' | shasum -a 256 -c -
```

Ces contrôles restaurent le contrat utilisé par le catalogue et Scalar, pas l'atlas complet : son verrou historique utilise une autre révision Codex et `npm run reproduce` n'est pas validé par cette étape. Voir les [limites de collecte de l'atlas](codex-contract-atlas/README.md#constituer-un-snapshot-réellement-figé). La construction et les tests locaux ne nécessitent pas de session Codex ; **pour servir des requêtes réelles seulement**, une session obtenue avec `codex login` est requise. Les identifiants restent dans le `CODEX_HOME` du serveur.

```sh
bun run build
./oai-codex init --host tailscale --port 8788
./oai-codex serve
```

`init` refuse de remplacer un fichier existant. Sur ce poste, la configuration est déjà créée dans `oai-codex.config.json`, avec l'adresse Tailscale détectée automatiquement et le port 8788.

```sh
./oai-codex start                 # arrière-plan, journal .local/server.log
./oai-codex status
./oai-codex stop
./oai-codex token                 # clé du proxy à coller dans le dashboard
./oai-codex config validate
./oai-codex serve --help
./oai-codex serve --host tailscale --port 8788 --mode raw --timeout 180000
```

Pour utiliser `oai-codex` sans le préfixe `./` dans ce terminal : `export PATH="$PWD/bin:$PATH"`.

Les scripts `scripts/start.sh`, `scripts/status.sh` et `scripts/stop.sh` acceptent les mêmes options. Le processus démarré avec `start` continue après fermeture du terminal ; il ne constitue pas un service de démarrage automatique de macOS.

Avec une adresse Tailscale `100.64.0.1` (exemple) : [dashboard](http://100.64.0.1:8788), [Scalar](http://100.64.0.1:8788/docs), [OpenAPI JSON](http://100.64.0.1:8788/openapi.json). L'accès depuis un autre appareil dépend de sa connexion Tailscale et des ACL du réseau. Le test local sur cette adresse ne remplace pas un test depuis un second appareil.

### Docker

L'image embarque la CLI Codex (rafraîchissement de session) et monte votre `CODEX_HOME` en lecture-écriture. La configuration et la clé locale sont créées au premier démarrage dans le volume `data`.

```sh
docker compose up -d                                  # http://127.0.0.1:8788
OAI_CODEX_BIND=100.64.0.1 docker compose up -d        # exposé sur l'adresse Tailscale
docker compose exec oai-codex bun src/cli/main.ts token --config /data/oai-codex.config.json
```

## Configuration

Le fichier JSON configure `server`, `proxy`, `auth`, `storage`, `limits`, `dashboard` et `docs`. Les options CLI prennent priorité pour le processus courant. Le dashboard peut enregistrer les paramètres publics ; un redémarrage applique ces changements. Les chemins relatifs des identifiants, de la clé et du stockage sont résolus depuis le dossier de configuration. `storage.path` (défaut `.local/durable/store.sqlite`) appartient uniquement à la configuration serveur locale : il n'est ni exposé ni modifiable par le navigateur, et ne doit pas viser le dossier des identifiants Codex.

```json
{
  "server": { "host": "tailscale", "port": 8788 },
  "proxy": {
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "defaultModel": "gpt-6-astra",
    "clientVersion": "0.160.0",
    "translationMode": "minimal",
    "timeoutMs": 120000,
    "maxBodyBytes": 16777216
  },
  "auth": { "codexHome": "/Users/you/.codex", "tokenFile": ".local/server-token" },
  "storage": { "path": ".local/durable/store.sqlite" },
  "limits": { "maxConcurrent": 16, "activityEntries": 100 },
  "dashboard": { "enabled": true },
  "docs": { "enabled": true }
}
```

`host` accepte une IP/hostname ou `tailscale`. L'origine Codex est volontairement fixe : une requête ou un changement de configuration ne peut pas envoyer la session à une autre destination. La clé locale aléatoire, distincte des identifiants Codex, est enregistrée avec des permissions privées. Ne transmettez que cette clé locale à vos clients.

## Compatibilité et transformations

Chaque chemin `/v1/*` est relayé vers `/backend-api/codex/*`, avec la méthode, la query et les champs inconnus préservés. Les codes d'erreur du backend ne deviennent pas de faux succès. Les cookies et en-têtes de transport ne sont pas relayés ; l'authentification est remplacée côté serveur. HTTP peut décompresser le corps au transport. Il n'y a ni retry automatique ni suivi des redirections upstream.

| Mode | Comportement |
| --- | --- |
| `raw` | Corps JSON, SSE, fichiers et frames WebSocket relayés sans traduction. Le client doit envoyer le format attendu par Codex. |
| `minimal` (défaut) | Adaptations décrites ci-dessous ; les autres routes restent en pass-through. |

Pour `POST /v1/responses`, le mode minimal ajoute uniquement les valeurs absentes `model`, `instructions: ""`, `store: false`, transforme un `input` texte en message et demande toujours le streaming à Codex. `store: true` conserve explicitement la réponse et ses input items dans un stockage SQLite privé propre au proxy (JSON et SSE), pendant trente jours à partir de sa conservation, y compris après redémarrage. Les routes de lecture, suppression et input items utilisent ce stockage. Si le client demande `stream: true`, les événements exposés conservent leur ordre ; le proxy complète le `response.output` terminal lorsqu'il est absent ou vide, à partir des `output_item.done` reçus. Le flux HTTP minimal omet uniquement les télémétries natives identifiées `codex.rate_limits`, `codex.response.metadata` et `responsesapi.websocket_timing` (observées dans les [preuves WebSocket historiques](docs/evidence/responses-implementation/websocket-independent.json)). Les extensions inconnues, champs supplémentaires et erreurs restent préservés. En foreground, les séquences reçues ne sont pas renumérotées et peuvent donc comporter des trous ; le background utilise son propre espace de séquences locales, décrit ci-dessous. Ce filtrage n'est pas une validation universelle du schéma public. Sinon, le serveur renvoie l'objet `response` final ; si Codex n'y répète pas les éléments de sortie, il y réunit les `output_item.done` reçus, dans leur ordre d'origine, y compris pour un terminal failed/incomplete (HTTP 502 conservé). Pour `GET /v1/models`, il ajoute `client_version` s'il manque et expose la liste sous `data[].id` en conservant les champs Codex. Le mode raw et le WebSocket directement relayé ne filtrent pas les événements.

Pour bénéficier de l'affinité du cache Codex depuis un SDK OpenAI, fournissez une `prompt_cache_key` stable pour les appels partageant le même préfixe. En mode minimal HTTP, le proxy la recopie dans `session-id` si cet en-tête est absent. Un en-tête explicite reste prioritaire. La dérivation exige une chaîne ASCII imprimable non vide, sans espaces aux extrémités ; les autres valeurs restent transmises dans le corps sans dérivation. Le mode raw n'ajoute rien. Le cache reste décidé par Codex : un hit se constate dans `usage.input_tokens_details.cached_tokens`, qui est conservé tel que reçu. Cette clé ne stocke pas l'historique et ne remplace pas `previous_response_id`.

Le catalogue expose 54 opérations : 52 routes HTTP et les WebSockets Responses et Realtime. « Vérifié sous conditions » sur la création Responses désigne uniquement les observations historiques du texte simple JSON/SSE et de l'historique explicite, datées et délimitées dans la preuve ; cela ne valide pas toutes ses options, sa persistance ni son lifecycle. Les statuts « présent dans les sources » et « à vérifier » ne promettent pas que l'abonnement accepte chaque route. Le stockage Responses, Chat et Conversations et les tâches de fond JSON/SSE sont des adaptations locales. Chat Completions dispose du sous-ensemble JSON/SSE texte et fonctions décrit ci-dessous, testé localement, sans validation backend réelle. La spec publique complète reste une référence, pas une garantie backend.

`GET /api/capabilities` conserve ses champs existants, notamment `supported` (route relayable uniquement), et ajoute par opération :

- `implementation` : `relay` sans adaptation du contrat, `adaptation` ou `local` en mode minimal ; raw reste un relais.
- `evidence` : nature (`runtime`, `source`, `historical-refusal`, `unknown`), date d'observation ou `null` si inconnue, périmètre et sources. Une preuve statique du 16 octobre n'est pas un essai live ; les observations du 20 septembre ne sont pas des résultats actuels.
- `prerequisites` et `limitations` : droits/ressources nécessaires, options non établies et refus bornés. Les champs refusés ne sont pas supprimés silencieusement.

Explorer affiche ces informations avant les contrôles d'exécution, y compris en WebSocket ; Scalar les conserve dans la description et les extensions `x-proxy-*`. Les exemples de corps restent des exemples du contrat, sans modèle ni paramètres garantis pour le compte. Images génération/édition/variantes, Audio REST et Realtime WS/WebRTC restent qualifiés séparément. Seul le sous-contrat d'édition décrit ci-dessous adapte le multipart public en références JSON natives ; aucune équivalence générale des deux contrats n'est promise.

Pour `POST /v1/realtime/calls`, minimal traduit uniquement l'enveloppe multipart `sdp` + `session` JSON vers le JSON Codex `{sdp,session}` ; le même JSON est accepté directement dans Explorer/Scalar. Sans session, le SDP est envoyé en `application/sdp`, chemin également présent dans le client Codex. Les options de session et la query explicite sont conservées : aucun modèle, protocole, `intent`, `architecture`, identifiant ou token n'est ajouté. Le placeholder SDP du catalogue doit être remplacé par une véritable offre locale. Les doublons/champs d'enveloppe inconnus, sessions null/tableau et `session.id` sont refusés avant envoi ; les corps entrants, adaptés et retournés restent bornés par `maxBodyBytes`. Un succès exige un identifiant `rtc_*` ou UUID dans `Location`, réduit à `/v1/realtime/calls/{id}` sans destination ni query native ; une erreur backend garde son statut/corps, sans `Location`. Le SDP n'est ni journalisé ni stocké par l'adaptateur ; `no-store` est imposé. Raw reste inchangé.

Cette adaptation d'enveloppe est **vérifiée localement**, pas une négociation WebRTC/audio vérifiée contre Codex. Le client source rejette RealtimeV2 pour AVAS ; les sessions publiques `type: realtime`, natives `quicksilver` et frameless ne sont pas supposées équivalentes. Les contrôles calls/live, credentials éphémères et transferts restent des relais non vérifiés avec autorisation/prérequis propres ; aucune fermeture d'appel distante n'est simulée par la fermeture HTTP. Voir les [limites et la probe réservée](docs/research/2026-10-16-codex-compatibility-frontier.md#webrtc--adaptation-locale-du-17-octobre).

La génération Images conserve le relais JSON natif : `prompt`, `model`, `background`, `n`, `quality`, `size` sont présents dans le client Codex figé. Aucun modèle ni défaut n'est injecté. Les options publiques supplémentaires (formats/compression, URL/base64, modération, style, streaming, images partielles, utilisateur) et champs inconnus restent transmis, sans garantie d'acceptation. Les fixtures SDK vérifient le transport PNG/JPEG/WebP. L'unique probe du coordinateur (16 octobre 2026, minimal, `gpt-image-2`) a produit un cercle bleu sur blanc, opaque, sans texte, mais **1374×1145 au lieu des 1024×1024 demandés** : génération observée, conformité des dimensions échouée, pas de compatibilité complète. Budget Images **1/1 épuisé**, aucune relance. Le SDK ne valide pas les pixels ; le relais ne redimensionne ni ne recadre l'image. Voir [les qualifications et le résultat borné](docs/evidence/images-generation.md).

En mode minimal, `POST /v1/images/edits` transforme les uploads multipart `image` ou `image[]` PNG/JPEG/WebP en références natives `images:[{image_url:"data:image/…;base64,…"}]`, dans l'ordre et sans changer les octets. Le JSON natif accepte aussi `{file_id:"file-…"}` pour une ressource existante autorisée, sans upload, résolution locale ni vérification des droits du fichier. `model` et `prompt` explicites sont obligatoires ; `background`, `n`, `quality`, `size` ont uniquement une preuve de sérialisation native. Masque, `input_fidelity`, formats de réponse/sortie, streaming, options inconnues et nulls sont refusés (`400 unsupported_image_edit_contract`), jamais supprimés. Les signatures et le base64 sont contrôlés, pas les pixels ; tailles entrante/JSON encodé, délai et annulation restent bornés. Aucun téléchargement d'URL ou accès au disque d'après la requête. Variantes : `501 image_variation_contract_unverified`, sans appel backend. Raw reste inchangé. **Édition et variantes non vérifiées en live, aucune probe autorisée** ; voir [contrats, exemples SDK et limites](docs/evidence/images-edits.md).

Audio REST : la transcription conserve la langue d’origine ; la traduction vise l’anglais. Toutes deux restent des relais **non vérifiés**, sans mécanisme fidèle établi sous `/backend-api/codex`. Dans Explorer, choisir « Multipart avec fichier », conserver les champs de l’exemple et joindre l’audio sous `file`. La limite locale porte sur le multipart entier (16 Mio par défaut), pas seulement le fichier ; aucun texte, timestamp, langue détectée ou locuteur n’est fabriqué. La dictée Desktop hors préfixe et Realtime ne prouvent pas ces opérations. Voir la [matrice Audio REST, les limites et la requête synthétique archivée](docs/research/2026-10-17-audio-rest.md). L’unique tentative transcription du coordinateur, le **2026-10-16T22:31:26.788Z**, en QA loopback minimal (`gpt-4o-transcribe`, WAV synthétique sans indice de phrase), a reçu **403 HTML, 97 632 octets, sans transcript**, après une seule tentative upstream sous le préfixe Codex. Cause/strate inconnue, sans conclusion universelle ni attribution au TTS ; **budget transcription épuisé 1/1, aucune relance autorisée**. La traduction reste non essayée et non autorisée.

### Probes médias à réserver par le coordinateur

Aucun appel n'est lancé par la consultation du catalogue. Pour le lot live explicitement réservé, conserver modèle/version, mode, chemin, date, résultat métier et refus expurgés ; chaque tentative consomme le budget, sans retry automatique :

| Probe préparée | Résultat à observer, pas seulement HTTP 200 |
| --- | --- |
| Une génération Images | Contenu image décodable et conforme à la consigne ; modèle/options et réponse réels. Ni édition ni variantes n'en héritent. |
| Une transcription synthétique Audio REST — budget épuisé 1/1 | 403 HTML observé le 2026-10-16T22:31:26.788Z, aucun transcript ; cause inconnue, aucune relance ni dictée Desktop hors préfixe. |
| Une synthèse vocale Audio REST | Audio décodable, texte/voix/format établis ; aucun fallback API payant. |
| Une session Realtime, dix secondes maximum | Transport WS ou WebRTC identifié, négociation/événements et résultat audio établis ; l'autre transport reste non vérifié. Aucun appel téléphonique. |

Audio speech HTTP : le mode minimal renvoie `501 speech_contract_unverified` après réception bornée du corps, avant accès aux identifiants ou synthèse : aucun contrat TTS Codex fidèle n'est établi dans les sources ciblées. Raw reste un relais non vérifié, sans fallback ni création de voix/consentement. Une interruption binaire raw peut laisser un fichier tronqué avec le statut HTTP initial ; valider le fichier complet, pas seulement 200. La [qualification speech, la requête préparée archivée et le refus observé par le coordinateur](docs/research/2026-10-17-audio-speech.md) distinguent contrat public, tests WAV locaux et synthèse réelle non obtenue.

La probe speech unique du coordinateur a reçu le **16 octobre 2026 à 22:25:55.432 UTC**, en QA temporaire loopback raw sur `/v1/audio/speech` (`gpt-4o-mini-tts-2025-12-15`, `alloy`, `wav`), un **403 HTML de 10611 octets, sans WAV**. Une seule requête upstream sous le préfixe Codex ; service actif inchangé. Cause/strate du refus inconnue, disponibilité backend non validée, aucune impossibilité universelle déduite. **Budget speech épuisé : 1/1, aucune relance autorisée.** La qualification/refus n'est pas une implémentation TTS fonctionnelle.

Le comptage exact `input_tokens` reste non établi (ancien 403 HTML, origine du refus inconnue), jamais remplacé par une estimation ou l'usage après génération. Les contrôles `temperature`, `top_p`, `max_output_tokens` et Code Interpreter gardent leurs refus historiques qualifiés. File Search/MCP exigent des ressources existantes autorisées ; aucune n'est créée pour une probe. Masques/édition/variantes, consentements et effets de contrôle nécessitent leur propre mandat, hors de ce lot. Les pistes Desktop hors préfixe restent interdites pour l'envoi d'identifiants. Voir les [sources et leurs limites](docs/research/2026-10-16-codex-compatibility-frontier.md).

## Client OpenAI

```sh
export OAI_CODEX_TOKEN="$(./oai-codex token)"
curl http://100.64.0.1:8788/v1/responses \
  -H "Authorization: Bearer $OAI_CODEX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6-astra","input":"Dis bonjour","stream":true}'
```

```js
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://100.64.0.1:8788/v1',
  apiKey: process.env.OAI_CODEX_TOKEN,
  maxRetries: 0,
});
const response = await client.responses.create({ model: 'gpt-6-astra', input: 'Bonjour' });
console.log(response.output_text);
```

### Chat Completions JSON et streaming

En mode minimal, `POST /v1/chat/completions` traduit les messages vers le même moteur Responses intégré, sans détour par un endpoint Chat natif. Le mode raw ne fait aucune traduction.

```js
const completion = await client.chat.completions.create({
  model: 'gpt-6-astra',
  messages: [
    { role: 'developer', content: 'Réponds brièvement.' },
    { role: 'user', content: 'Bonjour' },
  ],
  store: false,
  stream: false,
});
console.log(completion.choices[0].message.content);
```

Le sous-ensemble accepté est explicite : `model` (défaut local si omis), `messages` non vide, `stream` et `store` booléens, `metadata` et `n:1`. Les rôles `system`, `developer`, `user` et `assistant` et leur ordre sont conservés ; le contenu est une chaîne ou une liste non vide de parties `{type:"text", text:"…"}`. Le contenu assistant est projeté en `output_text`, les autres rôles en `input_text`. **Omettre `store` conserve `false`**, sans historique Chat durable ; `store:null` est refusé, pas transformé en `false`.

Une réponse terminée expose `chat.completion`, un identifiant `chatcmpl_*`, la date et le modèle reçus, un choix assistant et `finish_reason:"stop"` (ou `"tool_calls"` pour des fonctions). Texte et refus sont séparés dans `message.content` et `message.refusal` ; le raisonnement n'est jamais converti en texte final. L'usage reçu est traduit en `prompt_tokens`, `completion_tokens`, `total_tokens` et leurs détails ; un usage absent n'est pas estimé. Les erreurs natives et les terminaux Responses failed/incomplete gardent le statut HTTP d'erreur du moteur en JSON (502 pour ces terminaux), sans fausse completion ni faux `finish_reason`.

```js
const stream = await client.chat.completions.create({
  model: 'gpt-6-astra',
  messages: [{ role: 'user', content: 'Bonjour' }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
  if (chunk.usage) console.log(chunk.usage);
}
```

Le SSE émet un rôle assistant puis les deltas texte/refus/arguments **avant le terminal**, avec identité stable, indices de fonctions compacts et raison de fin. `stream_options.include_usage:true` ajoute `usage:null` aux chunks ordinaires et un dernier chunk `choices:[]` avec l'usage reçu (ou `null` s'il manque). Sans cette option, le flux n'inclut pas d'usage. Une erreur après du texte reste un événement SSE d'erreur reconnu par le SDK, sans fin de succès ni `[DONE]`. Annulation, délai global, taille d'agrégation et file SSE sont bornés par les mêmes protections Responses. Les extensions de flux sans projection fidèle sont refusées explicitement.

Exception identifiée : l'enveloppe native `response.metadata` (métadonnées de modèle/vérification/modération, pas du contenu généré) n'est pas convertie en chunk Chat et ne remplace ni le modèle de l'objet Response ni son résultat terminal. Elle reste préservée sur Responses et en raw ; les autres extensions inconnues restent refusées en Chat. Le [diagnostic et replay local](docs/evidence/chat-stream-metadata.md) corrigent un refus reproduit depuis un flux Responses observé séparément. L'essai Chat SSE réel initial avait échoué ; il n'a pas été retenté et ce correctif ne constitue pas une nouvelle validation Chat live.

Les `tools` de type `function` acceptent `name`, `description`, `parameters` et `strict`. `tool_choice` accepte `auto`, `none`, `required` ou `{type:"function",function:{name:"…"}}` ; `parallel_tool_calls` est conservé. Les appels retournent `message.tool_calls` en JSON et `delta.tool_calls` en SSE. Pour poursuivre, ajouter le message assistant puis **un résultat fourni par le client** pour chaque appel :

```js
const messages = [{ role: 'user', content: 'Cherche la météo à Paris.' }];
const tools = [{ type: 'function', function: {
  name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } },
} }];
const first = await client.chat.completions.create({ model: 'gpt-6-astra', messages, tools });
messages.push(first.choices[0].message);
for (const call of first.choices[0].message.tool_calls ?? []) {
  // Ici le client obtient lui-même le résultat autorisé ; le proxy n'exécute aucun outil.
  messages.push({ role: 'tool', tool_call_id: call.id, content: 'Résultat fourni par le client' });
}
const next = await client.chat.completions.create({ model: 'gpt-6-astra', messages, tools });
```

Les résultats d'outils sont des chaînes et deviennent des items `function_call_output` structurés, liés aux `function_call` par `call_id`, pas un transcript texte. Un assistant avec appels peut omettre son contenu ou utiliser `null`. Les identifiants dupliqués, résultats orphelins/répétés et appels sans résultat avant une nouvelle génération sont refusés avant envoi upstream.

Multimodal, outils autres que fonctions, messages nommés, `n` différent de 1, query parameters de création et **toute autre option**, notamment réglages de sampling, limites de tokens et `response_format`, renvoient explicitement `400 unsupported_chat_contract`. Une sortie structurée ou annotée non représentable par ce sous-ensemble renvoie `502 unsupported_chat_output` en JSON ou une erreur SSE, plutôt que perdre silencieusement une partie du résultat. Le schéma public Scalar reste une référence plus large que cette adaptation. Les tests SDK utilisent uniquement un upstream WebSocket local contrôlé ; ils ne prouvent pas les droits du compte réel.

### Chat explicitement stocké

`store:true` conserve la vraie completion Chat, les messages originaux ordonnés et le message assistant final (appels/résultats de fonctions structurés, identifiants conservés), pendant **30 jours après conservation**. Les sorties natives avec phases/raisonnement restent internes, sans devenir du texte Chat. La Response intermédiaire n'est pas stockée séparément. Le compte est fixé avant génération et stockage ; les autres comptes ne peuvent ni consulter ni modifier ces objets, même après redémarrage.

```js
const saved = await client.chat.completions.create({
  model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Bonjour' }],
  store: true, metadata: { project: 'example' }, // JSON ou stream:true
});
await client.chat.completions.retrieve(saved.id);
await client.chat.completions.update(saved.id, { metadata: { project: 'updated' } });
const page = await client.chat.completions.list({ limit: 20, order: 'desc', metadata: { project: 'updated' } });
const messagesPage = await client.chat.completions.messages.list(saved.id, { limit: 20 });
await client.chat.completions.delete(saved.id);
```

Liste et messages : `after`, `limit` entier 1–100 (défaut 20), `order:asc|desc` (défaut `asc`). Les completions sont triées par `created`, puis identifiant en cas d'égalité ; les messages suivent leur ordre original puis l'assistant final. La liste accepte aussi `model` et les égalités `metadata[key]=value` combinées par ET. Les paramètres inconnus, doublons, curseurs invalides et limites hors contrat sont refusés. Les pages exposent `object:list`, `first_id`, `last_id`, `has_more` ; le SDK peut utiliser `getNextPage()`.

Seules les métadonnées sont modifiables : au plus 16 paires, clés de 64 caractères maximum, valeurs chaînes de 512 caractères maximum ; `metadata:null` est conservé explicitement. Une mise à jour ne prolonge pas l'expiration. Absent, expiré ou autre compte : `404`. La suppression efface cette completion et ses messages, pas une Response stockée indépendamment.

Le même DurableStore impose le plafond **global de 1 Gio**, tous comptes et genres confondus, et 4 Mio maximum par objet. La réservation précède la génération ; un manque de capacité produit `507` sans éviction. En SSE, aucune fin réussie ni `[DONE]` n'est exposée avant le commit durable. Annulation, erreur partielle ou échec de commit ne produisent pas de faux succès et ne relancent jamais la génération. Raw reste un relais sans stockage local. Ces garanties sont testées localement, pas validées contre le compte réel.

Le dashboard offre un parcours Tests API (Responses en premier, scénarios numérotés, verdicts techniques et de consigne séparés, échanges dépliables), un explorateur de routes (JSON, texte, multipart/fichier et WebSocket), les réponses binaires téléchargeables, le journal des requêtes et la configuration. Le navigateur garde uniquement la clé du proxy dans `sessionStorage`. Scalar est servi localement ; renseignez la même clé dans Bearer. Aucun proxy Scalar externe n'est utilisé.

WebSocket navigateur : `new WebSocket('ws://100.64.0.1:8788/v1/responses', ['oai-codex', 'oai-codex-token.' + token])`. La clé de sous-protocole n'est jamais envoyée à Codex. Les clients natifs peuvent utiliser `Authorization: Bearer`. Les frames ne sont pas traduites ; une déconnexion est relayée sans reconnexion automatique. Les buffers sont bornés et le serveur accepte au maximum 64 WebSockets simultanés.

Realtime WS n’est pas une promesse de compatibilité audio : le [contrat et la matrice consommateurs](docs/research/2026-10-17-realtime-ws-contract.md) distinguent V1, RealtimeV2, Frameless Bidi et RPC thread. En minimal, l’intent natif `quicksilver` est refusé avant connexion (501 `realtime_protocol_not_adapted`) ; raw conserve son relais natif. V2 reste relayable sans adaptation des frames, options ou erreurs, avec `x-session-id` explicite conservé. Le démarrage WS officiel figé exige une clé API distincte ; le mécanisme ChatGPT sous le préfixe Codex reste non établi et aucun fallback payant n’est ajouté. Le SDK Node `openai/realtime/ws` exige WSS (terminaison TLS externe, non fournie ici) ; l’auth du SDK navigateur n’est pas acceptée, contrairement au sous-protocole local de l’Explorer. Les tests SDK/audio sont synthétiques et locaux, pas une validation backend. La probe exacte préparée dans ce document reste réservée au coordinateur, dans l’unique budget WS/WebRTC de dix secondes.

## Authentification et limites

Le serveur relit `auth.json` pour chaque appel. Une session expirée déclenche le mécanisme officiel de rafraîchissement du CLI (`codex app-server`), avec déduplication des rafraîchissements concurrents et délai borné. Le dashboard ne reçoit jamais les tokens Codex. Le CLI ne fournit pas d'option pour ignorer intégralement la configuration utilisateur : son processus temporaire lit le `CODEX_HOME`, avec apps, plugins, hooks, analytics et contrôle distant désactivés pour cet appel.

Le journal HTTP en mémoire contient méthode, chemin sans query, statut, durée et taille ; aucun prompt, fichier ou en-tête d'authentification. Il ne comptabilise pas les sessions WebSocket directement relayées. Les requêtes HTTP sont limitées en taille, durée et concurrence. Pour les créations Responses minimales, `timeoutMs` couvre réception du corps, credentials, connexion native et génération jusqu'à consommation du flux. `maxBodyBytes` borne le corps reçu avant parsing du lifecycle, chaque événement natif, l'agrégation des items terminés et la file SSE du pont ; les étages de transformation et le transport peuvent retenir quelques événements bornés supplémentaires. Un consommateur trop lent reçoit une erreur SSE `slow_consumer` et la session native est fermée, sans reconnexion ni retry. La vérification d'un événement intervient après réception de sa frame par le runtime WebSocket, pas avant son allocation native. Une continuation déjà active renvoie 409, y compris après une attente concurrente des credentials. `/health`, le dashboard, la spec et les assets sont publics sur l'adresse d'écoute ; les appels API et les contrôles exigent la clé. Les requêtes de navigateur provenant d'une autre origine sont refusées.

## Vérification

```sh
bun run check
bun run test
bun run build
bun run lint
bun run test:live             # deux générations courtes sur le serveur actif
```

La suite produit utilise des upstreams locaux et le SDK OpenAI : SSE avant EOF, annulation/délais, erreurs, champs inconnus, fichiers binaires, origine/destination, secrets, rafraîchissement et WebSocket. `test:live` effectue réellement les appels modèles/JSON/SSE avec votre session et enregistre uniquement une synthèse dans `artifacts/qa/live-proxy.json`.

`bun test` à la racine et `bun run test` chargent automatiquement la garde **réservée aux tests** de `bunfig.toml`. Les appels globaux `fetch`, `fetch.preconnect` et les constructions globales `WebSocket` refusent les destinations autres que `127.0.0.1`, `localhost` et `[::1]`, avant transport ; seuls les protocoles HTTP(S)/WS(S) sont admis. Les redirections HTTP automatiques sont refusées, y compris vers une autre URL locale ; `redirect:"manual"` permet d'inspecter leur réponse. Les signatures, options, statiques et `instanceof` WebSocket restent disponibles. Le [test de garde](tests/network-guard.test.ts) charge des stubs de transport **avant** ce preload dans un enfant Bun : les contre-exemples distants sont simulés, sans résolution DNS ni envoi réel, avec zéro effet sur les stubs après refus. Les suites locales existantes vérifient aussi les vrais échanges loopback, sans affaiblir les assertions CLI/lifecycle.

Cette garde couvre ces **API globales dans le processus Bun de test**, pas tous les accès TCP du système, les autres clients réseau ni les programmes enfants lancés séparément sans ce preload. Elle ne s'applique pas à `serve`, aux scripts CLI autonomes ou à `test:live` ; ces derniers ne doivent jamais être lancés implicitement par la suite locale. Elle ne modifie ni les destinations ni le transport du produit. Pour empêcher aussi la résolution de dépendances par les fixtures Python, les vérifications hors ligne peuvent utiliser `UV_OFFLINE=true bun test` et `UV_OFFLINE=true bun run test` ; les dépendances doivent alors être déjà installées.

`compatibility-tests/` conserve les preuves du proxy Rust officiel : son ancien test de petits événements SSE expose toujours la limite de buffering de cette référence. Il est distinct de la nouvelle suite produit `./tests`. `codex-contract-atlas/` conserve son propre build et ses tests.

## Audit Responses

Le banc est une seule famille numérotée : `oai-codex test responses --help` affiche les scénarios 01 à 26 dans leur ordre de preuve. Les scénarios 01 à 03 désignent les captures historiques déjà conservées dans `api-tests/responses/results/`; ils ne sont pas relancés pour les présenter comme de nouvelles observations.

```sh
./oai-codex test responses --scenario previous-response
./oai-codex test responses --scenario websocket
./oai-codex test responses --scenario json-schema
```

Pour tenter chaque scénario individuellement dans le même ordre, utilisez cette liste ; `set -e` conserve le premier refus ou prérequis indisponible comme un résultat visible au lieu de le masquer :

```sh
set -e
for scenario in create-text stream history previous-response conversation retrieve delete \
  background-cancel input-tokens compact websocket node-sdk instructions parameters \
  json-object json-schema function tool-choice parallel-tools reasoning-replay cache image \
  builtins native-media; do
  ./oai-codex test responses --scenario "$scenario"
done
```

Chaque essai écrit un rapport JSON expurgé dans `api-tests/responses/results/`. Un code `0` signifie que la consigne métier et le contrat client du scénario ont été observés. Un code `1` signifie un refus, une réponse non conforme ou une consigne non satisfaite ; un code `2` signale un prérequis ou un backend indisponible. Ces deux derniers résultats restent visibles comme écarts : ils ne valident pas la compatibilité Responses. Les rapports séparent le verdict technique (transport, HTTP, SDK) du verdict de consigne (résultat attendu), avec le modèle, le mode proxy et le chemin testés.

Les scénarios `previous-response`, `retrieve` (stockage SSE), `store-json`, `delete`, `compact` et `web-search` couvrent les adaptations du proxy. Lecture et suppression créent leur propre réponse avec `store:true` ; la compaction rejoue les items chiffrés sans champs optionnels null. La recherche web exige un appel d’outil et une citation. Les capacités refusées et les prérequis manquants restent visibles dans leurs scénarios dédiés. Consultez les rapports horodatés dans `api-tests/responses/results/` pour distinguer les anciennes observations des nouveaux résultats.

La [recherche complémentaire](docs/evidence/responses-gap-research/DECISIONS.md) distingue ces anciens rapports des nouveaux essais natifs. Pour le [cache Codex](docs/evidence/responses-gap-research/CACHE.md), le mapping d’affinité est corrigé et un SDK standard a observé 2 688 tokens cachés sur 2 893 au second appel. Le scénario `cache` exige maintenant un compteur réel positif et cohérent ; une réponse `CACHE_OK` avec zéro token caché ne suffit plus.

## Responses : adaptations intégrées

En mode minimal, les créations HTTP Responses utilisent une connexion native WebSocket conservée pour `previous_response_id`. Les sessions sont limitées à 64, expirent après cinq minutes d’inactivité et conservent au plus 256 identifiants chacune. Un identifiant inconnu ou expiré renvoie une erreur explicite. Le mode raw reste inchangé.

`web_search_preview` est normalisé vers `web_search`. `/v1/responses/compact` utilise la compaction native et retourne un véritable contenu chiffré réutilisable. Pour réinjecter les objets du SDK Python, utiliser `item.model_dump(mode="json", exclude_none=True)` : le champ optionnel de sortie `created_by: null` n’est pas accepté en entrée par Codex.

Le stockage durable est opt-in (`store:true`) ; l'omission et `false` n'enregistrent rien, `null` reste refusé par la validation existante. Les Responses expirent trente jours après leur conservation, sans renouvellement à la lecture. Les données sont isolées par compte : en changer ferme les continuités incompatibles sans supprimer ses Responses durables, retrouvables en revenant au compte initial. Aucune base Codex ni donnée actuelle n'est migrée.

Le budget applicatif est global : 1 Gio, tous comptes et types de contenu retenu réunis, avec 4 Mio maximum par objet (Response et inputs compris) et 65 536 objets/réservations maximum. Une réservation transactionnelle de 4 Mio est prise avant génération ; un refus `507 storage_capacity_exceeded` ne déclenche pas d'appel upstream ni d'éviction arbitraire. Ce choix conservateur peut refuser une petite génération lorsque moins de 4 Mio restent disponibles. La réservation est libérée à la fin/annulation ; après une interruption brutale, elle expire au délai maximal de la requête. Si le résultat dépasse la borne par objet, l'erreur est explicite (JSON 507 ou événement SSE d'erreur sans terminal prétendument stocké).

SQLite utilise un cache de pages de 2 Mio, des objets lus séparément, des transactions immédiates et un journal rollback supprimé à chaque commit, sans WAL cumulatif. Le fichier est plafonné à 1 152 Mio (294 912 pages de 4 Kio) ; avec le journal temporaire, le surcoût physique reste borné à environ 2 320 Mio au total, indépendamment du budget applicatif. Le dossier et le fichier doivent être privés (0700/0600). Expiration et suppression rendent les objets inaccessibles et libèrent le budget, mais ne promettent pas l'effacement physique de toutes leurs copies.

Le stockage n'implémente pas le replay d'une continuité après expiration de socket ni l'intégration Responses–Conversations. Les [tests SDK/runtime locaux](tests/responses-durable.test.ts) vérifient persistance et isolation, sans validation backend réelle ; les [preuves historiques du sprint](docs/evidence/responses-sprint/RESULTAT.md) restent datées.

## Conversations : historique local durable

En mode minimal, les huit opérations publiques Conversations utilisent le **même magasin injecté et le même quota** que Responses, sans TTL de trente jours. Ce ne sont ni des threads Codex ni une intégration à la génération Responses. Le mode raw reste un relais sans stockage local.

```js
const conversation = await client.conversations.create({
  metadata: { purpose: 'example' },
  items: [{ role: 'user', content: 'Bonjour' }],
});
await client.conversations.update(conversation.id, { metadata: { purpose: 'updated' } });
await client.conversations.items.create(conversation.id, {
  items: [{ role: 'user', content: 'Suite' }],
});
const retainedItems = [];
for await (const item of client.conversations.items.list(conversation.id, { order: 'asc', limit: 20 })) {
  console.log(item.id, item.type);
  retainedItems.push(item);
}
// Collecter toutes les pages avant de supprimer leurs curseurs.
for (const item of retainedItems) {
  await client.conversations.items.delete(item.id, { conversation_id: conversation.id });
}
await client.conversations.delete(conversation.id);
```

- Création et ajout : **20 items maximum par requête**, lot entièrement validé puis transactionnel. Les messages texte sont matérialisés avec `id`, `type:"message"`, `status:"completed"` et parties typées. Les identifiants fournis sont conservés ; les collisions entre items d'un même compte sont refusées avec 400, y compris entre Conversations ou avec un item orphelin. Les copies Responses ont leur identité de stockage distincte.
- Sous-ensemble d'entrée validé : messages `user`, `assistant`, `system`, `developer` (texte, références image/fichier, output text sans annotations/logprobs non vides et refus assistant), `function_call`, `function_call_output`, `reasoning`, `compaction`, `program` et `program_output`. Les phases assistant, contenus chiffrés, code, empreintes opaques et résultats de programme sont conservés sans interprétation. Les programmes exigent `id`, `call_id`, `code`, `fingerprint` ; leurs résultats exigent `id`, `call_id`, `result` chaîne et `status:completed|incomplete`, conformément au SDK 7.20.0. Le stockage ne les exécute pas et ne garantit pas leur replay. Les autres variantes de l'union publique, références d'item seules, champs inconnus et formes non couvertes sont **refusés explicitement avec 400**, pas acceptés arbitrairement. Aucune URL média n'est téléchargée et aucun outil n'est exécuté par ces opérations. Scalar conserve le schéma public plus large comme référence, avec cette limitation affichée.
- Variantes d'items du SDK 7.20.0 encore refusées : `file_search_call`, `computer_call`, `computer_call_output`, `web_search_call`, `tool_search_call`, `tool_search_output`, `additional_tools`, `configuration_update`, `image_generation_call`, `code_interpreter_call`, `local_shell_call`, `local_shell_call_output`, `shell_call`, `shell_call_output`, `apply_patch_call`, `apply_patch_call_output`, `mcp_list_tools`, `mcp_approval_request`, `mcp_approval_response`, `mcp_call`, `custom_tool_call`, `custom_tool_call_output`, `compaction_trigger`, `item_reference` (y compris sa forme sans `type`). Pour les messages, les autres rôles, les parties de contenu autres que `input_text`, `input_image`, `input_file`, `output_text` et `refusal`, et les annotations/logprobs non vides sont également refusés. Les validateurs de ces formes ne sont pas implémentés : **la conservation de l'union publique reste incomplète**, pas satisfaite par ce refus documenté. Conserver leurs données inertes ne nécessiterait pas l'exécution des outils ni la création des ressources référencées ; ces effets et le replay demandent leurs contrats et prérequis propres. Cette liste n'affirme aucune impossibilité native de Codex.
- Métadonnées : seize paires maximum, clés de 64 caractères et valeurs texte de 512. Une mise à jour **remplace** le dictionnaire ; `null` le vide. Liste d'items : ordre `desc` par défaut, `asc` chronologique, limite 1–100 (défaut 20), curseur `after` appartenant à la même collection ; le SDK peut parcourir les pages. Un curseur supprimé ou étranger renvoie 400. La pagination est vivante, pas une photographie figée pendant des mutations concurrentes.
- Parent, rattachements, items et copies Responses sont distincts. **DELETE Conversation ne supprime que le parent** et retourne `conversation.deleted`. Les items et rattachements orphelins restent conservés et comptés au quota ; leurs routes, rattachées au parent absent, retournent 404. Il n'existe pas ici de route publique pour les récupérer ou les purger après suppression du parent. Pour enlever ce contenu, supprimer les items **avant** le conteneur. DELETE item retourne l'objet Conversation, pas `item.deleted` ; un second DELETE retourne 404. Aucune copie Response, fichier référencé ou copie physique n'est supprimée en cascade.
- Les mutations concurrentes sont sérialisées par transactions SQLite immédiates sur le handle partagé du propriétaire unique, sans attente réseau dans la transaction : lot complet ou rollback, y compris sur quota. Un second propriétaire est refusé avant récupération avec 409 ; aucune génération ne verrouille encore une Conversation dans cette tranche. Pas de dépendance aux jobs. Le stockage conserve les bornes de 1 Gio, 4 Mio par objet, 65 536 objets/réservations et les bornes physiques décrites plus haut ; les rattachements sont eux aussi comptés. Un remplacement réserve conservativement sa nouvelle taille avant d'écrire et peut donc être refusé près du plafond.

Les [tests SDK/HTTP locaux](tests/conversations.test.ts) couvrent redémarrage, comptes synthétiques, pagination, suppression distincte, quota partagé avec une génération locale contrôlée, lots invalides et collisions concurrentes. Ils ne valident pas l'accès backend réel. Aucun déploiement n'est requis pour lire ces preuves ; le service actif n'est pas modifié.

Un magasin minimal possède un **propriétaire exclusif** : le verrou SQLite `EXCLUSIVE` reste acquis jusqu'à la fermeture du handle, et le noyau le libère au crash. Un second handle/processus sur la même base est refusé avec `409 storage_in_use` avant initialisation ou récupération des jobs. Deux gestionnaires utilisant le même handle injecté sont également refusés. Responses, Chat et les autres consommateurs du propriétaire partagent ce handle et son quota ; plusieurs serveurs doivent utiliser des chemins de stockage distincts. Aucun fichier PID ni lease à expiration ne décide de cette autorité.

Le runtime vérifie l'écoute réseau avant d'ouvrir/récupérer le magasin : un port indisponible ne doit pas interrompre des jobs. À l'arrêt, il ferme les producteurs puis le pont natif avant de fermer son magasin. Un magasin injecté reste la responsabilité de son appelant : fermer le gateway libère son gestionnaire, mais ne ferme pas le handle SQLite ni son verrou ; un nouveau gateway peut réutiliser ce même handle, tandis qu'un autre handle attend sa fermeture explicite. Une récupération de jobs n'est exécutée qu'après acquisition de cette autorité, jamais par un second serveur vivant.

### Responses en arrière-plan

En mode minimal, `background:true` avec `stream:false` ou omis rend rapidement un identifiant local `resp_bg_*` et `status:queued`. Le producteur utilise le même pont Responses natif, sans scheduler Codex prétendu ni nouvelle session inventée. La déconnexion du client n'annule pas le job.

```js
const job = await client.responses.create({
  model: 'gpt-6-astra', input: 'Dis bonjour', background: true, store: false,
});
const snapshot = await client.responses.retrieve(job.id); // queued / in_progress / terminal
const final = await client.responses.cancel(job.id);     // idempotent, jamais de faux cancelled après completed
```

Le polling retourne `queued`, `in_progress`, puis le terminal fidèle `completed`, `failed`, `cancelled` ou `incomplete`, avec ses sorties, erreurs et détails. Cancel est réservé au background et ferme le tour natif localement ; il ne garantit pas l'annulation d'effets d'outils déjà émis. Une suppression pendant l'exécution renvoie 409 : annuler d'abord, puis supprimer.

`store:false` **ou omis conserve temporairement** l'objet et ses inputs pendant l'exécution bornée, puis **dix minutes après le terminal**. `store:true` conserve l'objet trente jours après le terminal. Les lectures ne renouvellent pas ces délais. Le budget SQLite global de 1 Gio est partagé avec les Responses ordinaires ; la réservation reste acquise durant le job. Une marge conservatrice de 1 Kio est réservée aux métadonnées d'échec/interruption ; entrées ou sorties trop grandes produisent une erreur explicite, jamais un faux résultat stocké.

Au plus **16 jobs en attente ou actifs**, chacun limité par `timeoutMs` depuis son acceptation (attentes des credentials comprises). Le compte est persisté avec le job, puis revalidé après la file et juste avant l'émission native ; les credentials restent épinglés à cette requête. Après redémarrage, **tous** les jobs non terminés, y compris `queued`, deviennent `failed` avec `background_interrupted`. Aucun travail n'est réémis, même s'il n'avait pas encore été envoyé.

### Background SSE et reprise

Créer avec `background:true, stream:true` ouvre immédiatement le SSE sur `response.created`, avec l'identifiant local stable `response.id` (`resp_bg_*`). Les enveloppes `response.id` et `response_id` des événements suivants utilisent ce même identifiant, jamais un identifiant upstream contradictoire. **Dans ce seul flux background**, `sequence_number` est canonicalisé à partir de zéro, strictement croissant, après les adaptations minimales existantes. Les autres champs et extensions sont conservés. Les séquences foreground et raw ne changent pas.

```js
const stream = await client.responses.create({
  model: 'gpt-6-astra', input: 'Dis bonjour', background: true, stream: true,
});
let id;
let cursor;
for await (const event of stream) {
  if (event.type === 'response.created') id ??= event.response.id;
  cursor = event.sequence_number;
  // Afficher et conserver le curseur après traitement réussi de l'événement.
}
// Après une déconnexion, avec l'identifiant et le dernier curseur conservés :
const resumed = await client.responses.retrieve(id, { stream: true, starting_after: cursor });
for await (const event of resumed) console.log(event);
```

Le SDK Node **7.20.0** utilise `responses.retrieve(id, {stream:true, starting_after:N})`, soit `GET /v1/responses/{id}?stream=true&starting_after=N`. Seuls les événements exposés **après N** sont repris, à l'identique, sans nouvelle génération ni duplication. Sans `starting_after`, le journal est repris depuis le début. Une création non streaming est refusée (`400 background_not_streamed`), un curseur négatif/non entier/au-delà du dernier événement aussi (`400 invalid_cursor`).

Le journal privé est un objet séparé, **4 Mio maximum**, réservé avant génération dans le **même plafond global de 1 Gio**. Il expire **dix minutes après le terminal**, même si le JSON `store:true` reste disponible trente jours. Journal expiré/manquant : `410 background_journal_unavailable`, jamais un nouveau flux fabriqué. Une suppression de Response efface aussi son journal. Un journal plein fait échouer le job explicitement (`background_journal_full`) ; aucun terminal de succès n'est diffusé avant le commit atomique du résultat et de son événement.

Au plus **64 abonnements** simultanés ; chaque lecteur consomme directement le journal sans file d'événements en mémoire. Un retard de livraison live supérieur à `maxBodyBytes` déconnecte cet abonné (`slow_consumer`), **sans arrêter le producteur** ; il peut reprendre avec son dernier curseur. Le délai de la connexion cliente reste borné et ne vaut pas annulation du job. Après redémarrage, les jobs inachevés sont `failed` ; la reprise restitue uniquement les événements déjà committés puis signale `background_interrupted`, sans inventer l'historique manquant ni relancer le backend.

Les identifiants locaux ne fournissent pas de continuité native ni de replay de contexte durable. Le SSE synchrone, Chat et le mode raw restent inchangés. Les [tests background SDK/runtime](tests/responses-background.test.ts) et [tests de reprise](tests/responses-background-stream.test.ts) utilisent uniquement des upstreams et identifiants synthétiques locaux, sans validation du compte réel. Référence : [guide public background](https://developers.openai.com/api/docs/guides/background), dont les politiques de rétention par projet ne remplacent pas ce profil local explicite.
