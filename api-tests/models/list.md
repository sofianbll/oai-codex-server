# Models : lister les modèles

`GET /v1/models` retourne le catalogue des modèles accessibles. Il ne génère
aucun contenu. Un modèle présent dans ce catalogue n’est pas une preuve que
Responses ou Chat Completions fonctionne avec lui.

## Requête

```http
GET /v1/models HTTP/1.1
Authorization: Bearer <clé du proxy>
Accept: application/json
```

Aucun corps ni paramètre de requête n’est défini pour cette opération.
La clé est celle du proxy testé. Elle vient de `OPENAI_API_KEY` ou de
`--key-file` (prioritaire). Elle n’est pas enregistrée dans le rapport.

## Contrat de réponse

Statut attendu : **200**, contenu **application/json** (un charset est accepté).

| Emplacement | Champ | Type / valeur requis |
|---|---|---|
| Racine | `object` | chaîne exactement `"list"` |
| Racine | `data` | tableau de modèles, éventuellement vide |
| Chaque modèle | `id` | chaîne |
| Chaque modèle | `object` | chaîne exactement `"model"` |
| Chaque modèle | `created` | entier, timestamp Unix en secondes |
| Chaque modèle | `owned_by` | chaîne, organisation propriétaire |

Les champs supplémentaires sont acceptés. Aucun ordre, nombre de modèles ou
identifiant particulier n’est imposé. Les types ne sont pas convertis :
`"123"`, `123.5`, `true` et `null` ne sont pas des entiers conformes.

Exemple conforme :

```json
{
  "object": "list",
  "data": [
    {
      "id": "modele-exemple",
      "object": "model",
      "created": 1686935002,
      "owned_by": "organisation-exemple"
    }
  ]
}
```

## Convention du proxy Codex

En mode `minimal`, le proxy adapte le catalogue natif Codex (`models`, `slug`)
vers la liste OpenAI (`data`, `id`, `object`). Il ajoute à chaque modèle :

- `owned_by: "openai"` : fournisseur des modèles de ce catalogue Codex.
- `created: 0` : valeur de remplacement, car Codex ne fournit pas la date de création.

**`0` n’est pas une date de création réelle.** Numériquement, ce timestamp désigne
le 1er janvier 1970 UTC ; son sens « date indisponible » est une convention de
notre proxy, pas de la spécification OpenAI. Les clients doivent éviter de
l’interpréter comme l’âge réel du modèle. `null` et l’absence du champ ne sont
pas conformes au contrat. Le banc conserve donc sa validation stricte d’entier.
Le mode `raw` conserve la réponse amont sans cette adaptation.

## Lancer le contrôle

Prérequis : `uv`, qui installe les dépendances déclarées dans le script.
Depuis la racine du projet, avec la clé locale existante :

```bash
uv run api-tests/models/test_list.py \
  --base-url http://100.64.0.1:8788/v1 \
  --key-file .local/server-token
```

Si `OPENAI_API_KEY` est déjà défini, omettre `--key-file`.
`--help` décrit les options ; `--output-dir` permet de choisir le dossier des rapports.

## Contrôles et verdicts

| Contrôle | Réussite |
|---|---|
| HTTP | réponse 200 |
| Content-Type | `application/json` |
| SDK | le SDK Python officiel arrive à lire la réponse Models |
| Contrat JSON | structure et tous les champs requis respectent les types ci-dessus |

Un parsing réussi par le SDK ne suffit pas : la validation stricte est séparée.
Une erreur indique le chemin du champ concerné. Le script effectue un seul
appel, sans retry ni suivi de redirection, avec un timeout réseau de 30 secondes.

Codes de sortie : **0** = tous les contrôles passent ; **1** = réponse reçue mais
non conforme ; **2** = essai impossible (configuration, connexion ou écriture).

Chaque essai réseau conserve un JSON daté dans `results/` : version du SDK,
requête réellement envoyée (en-têtes sensibles expurgés), statut, type de contenu,
corps de réponse brut, durée et verdicts. Si le serveur renvoie la clé, elle est
également expurgée du corps. Sans réponse réseau, le corps et le statut sont `null`.
Une configuration invalide peut arrêter le programme avant création du rapport.

Ce test couvre seulement la **liste avec une clé fournie**. Il ne vérifie pas
l’authentification avec une mauvaise clé, la récupération/suppression d’un modèle,
les champs optionnels ni le fonctionnement des modèles annoncés.

## Référence officielle

Référence consultée le **20 septembre 2026**, SDK Python épinglé à **3.16.2**.
La documentation web évolue ; le schéma SDK ci-dessous est fixé à un commit.

- [OpenAI : List models](https://platform.openai.com/docs/api-reference/models/list).
- [Schéma Model officiel, commit 69a2c1d](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/src/openai/types/model.py).
- [Tests Models du SDK officiel au même commit](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/tests/api_resources/test_models.py).

Le script utilise le SDK officiel comme client ; il ne prétend pas exécuter
l’intégralité des tests OpenAI ni certifier la compatibilité de tout le proxy.

## Depuis la commande principale

```bash
oai-codex test
```

Choisir **Models** avec les flèches puis Entrée. **Quitter** ou Ctrl+C annule
sans lancer de requête. Le tableau affiche les PASS en vert et les FAIL en rouge,
avec un bilan et le chemin du rapport. Les couleurs sont adaptées au terminal.

Pour lancer directement : `oai-codex test models`.
L’adresse et le fichier de clé viennent de la configuration du projet ;
`--config`, `--base-url` et `--key-file` permettent de les choisir explicitement.
Les autres groupes seront ajoutés au sélecteur quand leurs tests seront disponibles.
