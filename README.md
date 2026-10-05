# oai-codex-server

Un serveur compatible OpenAI devant la session ChatGPT de Codex installée sur ce Mac. Bun sert le proxy, le dashboard et la documentation Scalar. Les sources officielles conservées dans `upstream/` et l'atlas existant restent des références indépendantes.

## Démarrage

Prérequis : Bun et une session obtenue avec `codex login`. Les identifiants restent dans le `CODEX_HOME` du serveur.

```sh
bun install --frozen-lockfile
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

Le fichier JSON configure `server`, `proxy`, `auth`, `limits`, `dashboard` et `docs`. Les options CLI prennent priorité pour le processus courant. Le dashboard peut enregistrer les paramètres publics ; un redémarrage applique ces changements. Les chemins relatifs des identifiants et de la clé sont résolus depuis le dossier de configuration.

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

Pour `POST /v1/responses`, le mode minimal ajoute uniquement les valeurs absentes `model`, `instructions: ""`, `store: false`, transforme un `input` texte en message et demande toujours le streaming à Codex. `store: true` conserve la réponse dans le stockage local en mémoire (JSON et SSE), pendant une heure au maximum, avec des limites de taille et de nombre ; le stockage disparaît au redémarrage. Les routes de lecture, suppression et input items utilisent ce stockage. Si le client demande `stream: true`, les frames sont relayées dans leur ordre ; le proxy complète seulement le `response.output` terminal lorsqu'il est absent ou vide, à partir des `output_item.done` reçus. Sinon, le serveur renvoie l'objet `response` final ; si Codex n'y répète pas les éléments de sortie, il y réunit les `output_item.done` reçus, dans leur ordre d'origine. L'en-tête SSE est rétabli lorsque Codex l'omet. Pour `GET /v1/models`, il ajoute `client_version` s'il manque et expose la liste sous `data[].id` en conservant les champs Codex.

Pour bénéficier de l'affinité du cache Codex depuis un SDK OpenAI, fournissez une `prompt_cache_key` stable pour les appels partageant le même préfixe. En mode minimal HTTP, le proxy la recopie dans `session-id` si cet en-tête est absent. Un en-tête explicite reste prioritaire. La dérivation exige une chaîne ASCII imprimable non vide, sans espaces aux extrémités ; les autres valeurs restent transmises dans le corps sans dérivation. Le mode raw n'ajoute rien. Le cache reste décidé par Codex : un hit se constate dans `usage.input_tokens_details.cached_tokens`, qui est conservé tel que reçu. Cette clé ne stocke pas l'historique et ne remplace pas `previous_response_id`.

Le catalogue expose 39 opérations : 38 routes HTTP et le WebSocket Responses. « Vérifié » sur la création Responses signifie uniquement que le texte simple JSON/SSE et l'historique explicite ont été observés ; cela ne valide pas toutes ses options, sa persistance ni son lifecycle. Les statuts « présent dans le code Codex » et « à vérifier » indiquent aussi un niveau de preuve, jamais une promesse que l'abonnement accepte chaque route. Images, audio, realtime et autres routes peuvent être refusés par Codex. Le stockage Responses est émulé localement ; les conversations persistantes, tâches de fond et Chat Completions ne sont pas implémentés. La spec publique complète sert de référence et les endpoints non vérifiés le signalent.

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

Le dashboard offre un parcours Tests API (Responses en premier, scénarios numérotés, verdicts techniques et de consigne séparés, échanges dépliables), un explorateur de routes (JSON, texte, multipart/fichier et WebSocket), les réponses binaires téléchargeables, le journal des requêtes et la configuration. Le navigateur garde uniquement la clé du proxy dans `sessionStorage`. Scalar est servi localement ; renseignez la même clé dans Bearer. Aucun proxy Scalar externe n'est utilisé.

WebSocket navigateur : `new WebSocket('ws://100.64.0.1:8788/v1/responses', ['oai-codex', 'oai-codex-token.' + token])`. La clé de sous-protocole n'est jamais envoyée à Codex. Les clients natifs peuvent utiliser `Authorization: Bearer`. Les frames ne sont pas traduites ; une déconnexion est relayée sans reconnexion automatique. Les buffers sont bornés et le serveur accepte au maximum 64 WebSockets simultanés.

## Authentification et limites

Le serveur relit `auth.json` pour chaque appel. Une session expirée déclenche le mécanisme officiel de rafraîchissement du CLI (`codex app-server`), avec déduplication des rafraîchissements concurrents et délai borné. Le dashboard ne reçoit jamais les tokens Codex. Le CLI ne fournit pas d'option pour ignorer intégralement la configuration utilisateur : son processus temporaire lit le `CODEX_HOME`, avec apps, plugins, hooks, analytics et contrôle distant désactivés pour cet appel.

Le journal en mémoire contient méthode, chemin sans query, statut, durée et taille ; aucun prompt, fichier ou en-tête d'authentification. Les requêtes HTTP sont limitées en taille, durée et concurrence. `/health`, le dashboard, la spec et les assets sont publics sur l'adresse d'écoute ; les appels API et les contrôles exigent la clé. Les requêtes de navigateur provenant d'une autre origine sont refusées.

## Vérification

```sh
bun run check
bun run test
bun run build
bun run lint
bun run test:live             # deux générations courtes sur le serveur actif
```

La suite produit utilise des upstreams locaux et le SDK OpenAI : SSE avant EOF, annulation/délais, erreurs, champs inconnus, fichiers binaires, origine/destination, secrets, rafraîchissement et WebSocket. `test:live` effectue réellement les appels modèles/JSON/SSE avec votre session et enregistre uniquement une synthèse dans `artifacts/qa/live-proxy.json`.

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

Le stockage local est borné à 256 réponses et 32 Mio (4 Mio par réponse). Il est effacé au changement de compte et au redémarrage. `background:true` avec stockage renvoie explicitement 501 ; les tâches de fond, conversations persistantes, paramètres du modèle refusés et outils sans prérequis ne sont pas déclarés compatibles. Voir [les preuves du sprint](docs/evidence/responses-sprint/RESULTAT.md).
