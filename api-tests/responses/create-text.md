# Responses 01 — Texte simple

## But et commande

Créer une réponse texte via `POST /v1/responses`, avec le SDK Python officiel.

```bash
oai-codex test responses
```

Ou `oai-codex test` → **Responses** → **01 — Texte simple**.
Le modèle, l’adresse et le fichier de clé viennent de la configuration du projet.
Les options existantes `--config`, `--model`, `--base-url` et `--key-file`
permettent de les remplacer. La clé ne figure pas dans le rapport.

Pour exécuter le script seul :

```bash
uv run api-tests/responses/test_create_text.py \
  --base-url http://100.64.0.1:8788/v1 \
  --model gpt-6-astra \
  --key-file .local/server-token
```

Sans `--key-file`, le script utilise `OPENAI_API_KEY`. `--output-dir` choisit
le dossier des rapports ; par défaut : `api-tests/responses/results/`.

## Requête envoyée

Authentification : `Authorization: Bearer <clé locale du proxy>`.
Corps JSON, avec le modèle configuré à la place de l’exemple :

```json
{
  "model": "gpt-6-astra",
  "input": "Réponds exactement : TEST_OK",
  "stream": false,
  "store": false
}
```

Aucun outil, plafond de tokens ou réglage de raisonnement n’est ajouté.
Le script effectue un seul appel, sans retry ni redirection, avec un timeout
réseau de 300 secondes. Le timeout du proxy reste également applicable.

Le proxy en mode `minimal` transforme la chaîne `input` en message Codex,
ajoute des instructions vides si elles sont absentes et demande un flux à Codex.
Il assemble ensuite ce flux en une réponse JSON pour notre client non streaming.
Le rapport conserve les échanges **client ↔ proxy**, pas le flux interne Codex.

## Contrat technique

La validation stricte utilise directement `Response.model_validate_json(...,
strict=True)` du SDK OpenAI **3.16.2**, en plus du parsing normal du SDK.
Elle contrôle le schéma officiel imbriqué, sans convertir une chaîne en nombre.
Les champs supplémentaires sont acceptés par le SDK et conservés dans le brut.

Champs racine obligatoires du schéma de cette version :

| Champ | Type attendu |
|---|---|
| `id` | chaîne |
| `created_at` | nombre, timestamp Unix en secondes |
| `model` | chaîne identifiant le modèle |
| `object` | exactement `"response"` |
| `output` | tableau d’éléments typés par le schéma officiel |
| `parallel_tool_calls` | booléen |
| `tool_choice` | valeur ou objet défini par le schéma officiel |
| `tools` | tableau d’outils défini par le schéma officiel |

Les champs optionnels présents sont également validés selon ce schéma.
Le scénario ajoute les exigences de réussite suivantes :

| Contrôle | Critère de réussite |
|---|---|
| HTTP | statut 200 |
| Content-Type | `application/json`, charset accepté |
| SDK | réponse lisible par le SDK officiel |
| Contrat JSON | validation stricte du schéma Responses |
| État final | `status: "completed"`, aucune erreur ni détail d’incomplétude |
| Message assistant | au moins un message assistant terminé avec un contenu `output_text` non vide |
| Usage | compteurs présents, entiers non négatifs, total = entrée + sortie |

Pour un message : `id`, `type: "message"`, `role: "assistant"`, `status`
et `content` sont vérifiés par le schéma. Un contenu texte possède notamment
`type: "output_text"`, `text` et `annotations`. On ne suppose pas que le premier
élément de `output` est un message : le modèle peut aussi produire du raisonnement.

L’usage comprend `input_tokens`, `output_tokens`, `total_tokens`,
`input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens`
et `output_tokens_details.reasoning_tokens`. Les tokens en cache ne peuvent pas
dépasser les tokens d’entrée ; les tokens de raisonnement ne peuvent pas dépasser
les tokens de sortie. Aucun compteur manquant n’est inventé.

## Consigne : un verdict distinct

Le texte extrait par **`response.output_text` du SDK** doit être exactement
`TEST_OK` après suppression des espaces extérieurs. Ce contrôle est séparé :
une réponse techniquement conforme disant autre chose échoue sur la consigne,
mais ne prouve pas un défaut de transport ou d’adaptation.

Si la réponse ne peut pas être validée et exploitée, la consigne est `SKIP`
(non évaluée), jamais considérée réussie par défaut.

## Affichage et preuves

Le CLI affiche le texte reçu, les contrôles PASS/FAIL/SKIP en couleur, deux
verdicts distincts (technique et consigne), puis le chemin du rapport JSON daté.
Le rapport contient la version du SDK, la requête réellement envoyée (corps
et en-têtes expurgés), le statut HTTP, le type de contenu, la réponse brute,
le texte extrait, la durée, les contrôles et les verdicts séparés.

Codes de sortie : **0** = technique et consigne réussies ; **1** = au moins un
échec ; **2** = configuration, connexion ou écriture impossible.
Les erreurs réseau génèrent aussi un rapport, avec réponse nulle. Une configuration
invalide peut arrêter le script avant l’appel et avant la création du rapport.

Vérifications contrôlées : réponse conforme, champ requis de mauvais type,
texte différent, total d’usage incohérent, compteur booléen et réponse HTML inattendue.

Ce scénario ne valide pas tout Responses : stockage, streaming côté client,
outils, historique, sorties structurées et autres routes restent à traiter.

## Sources officielles et version

Référence consultée le **20 septembre 2026**, paquet officiel `openai==3.16.2`
épinglé dans le script. Le schéma effectivement utilisé est celui de ce paquet ;
les liens vers `main` peuvent évoluer.

- [Créer une réponse — référence OpenAI](https://platform.openai.com/docs/api-reference/responses/create).
- [Schéma officiel Response](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response.py).
- [Schéma officiel ResponseUsage](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py).
- [Schéma officiel du message produit](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_message.py).
