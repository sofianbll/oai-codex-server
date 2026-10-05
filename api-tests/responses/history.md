# Responses 03 — Historique explicite

## Lancer

```bash
oai-codex test responses --scenario history
```

Ou `oai-codex test` → **Responses** → **03 — Historique explicite**.
Le modèle, l’adresse et la clé viennent de la configuration du projet. Les options
`--model`, `--config`, `--base-url` et `--key-file` conservent leur fonctionnement.

Le script autonome `test_history.py` accepte `--base-url`, `--model`,
`--key-file` (sinon `OPENAI_API_KEY`) et `--output-dir` (sinon `results/`).
Il utilise le SDK officiel `openai==3.16.2`.

## Ce que l’on veut démontrer

Une application peut poursuivre une conversation en renvoyant elle-même les
messages précédents. Ce scénario ne dépend pas d’une mémoire conservée par le
serveur : il n’envoie ni `previous_response_id` ni `conversation`.
Il ne vérifie pas la reprise d’éléments de raisonnement ou d’outils : l’historique
est ici une liste de messages texte `user` et `assistant`.

## Déroulement

Deux appels à **`POST /v1/responses`**, avec la même clé et le même modèle,
`stream: false` et `store: false`, sans outil ni option supplémentaire.

1. Générer un code différent à chaque exécution, de forme `CONTEXT_<8 chiffres hexadécimaux>`.
2. Premier tour : envoyer « Le code de cette conversation est CONTEXT_…. Réponds exactement : ACK ».
3. Vérifier la réponse et sa consigne. Si le premier tour échoue, arrêter et marquer le second tour `SKIP`.
4. Second tour : renvoyer le message initial, **le vrai texte assistant du premier tour**, puis demander le code sans le répéter dans la nouvelle question.
5. Vérifier que le second texte est exactement le code initial, après suppression des espaces extérieurs.

Corps du second appel, exemple illustratif :

```json
{
  "model": "modele-configure",
  "store": false,
  "stream": false,
  "input": [
    {"role": "user", "content": "Le code de cette conversation est CONTEXT_a1b2c3d4. Réponds exactement : ACK"},
    {"role": "assistant", "content": "ACK"},
    {"role": "user", "content": "Quel est le code de cette conversation ? Réponds uniquement avec le code, sans autre texte."}
  ]
}
```

`ACK` dans l’exemple représente la réponse reçue ; le script ne fabrique pas
le message assistant. Les espaces éventuellement reçus sont conservés lors du
renvoi, même si la comparaison de la consigne les ignore aux extrémités.

Le code variable évite une réponse attendue constante. Ce test montre l’usage
du contexte fourni ; il ne prétend pas prouver une mémoire persistante ou
l’absence de tout état interne côté fournisseur.

## Contrôles et verdicts

Chaque tour réutilise les contrôles du [scénario 01](create-text.md) :
HTTP 200, JSON, parsing SDK, schéma Responses strict, état terminé sans erreur,
message assistant non vide et usage présent/cohérent. La consigne est distincte :
**ACK au premier tour**, **code retrouvé au second**.

Un code incorrect avec deux réponses conformes signifie « technique conforme,
contexte non retrouvé ». Si le second tour n’a pas pu être exécuté, le rapport
explique pourquoi. Un échec de consigne au premier tour ne devient pas un faux
échec de schéma : le verdict technique global reste incomplet si aucun défaut
technique n’a été observé mais que la conversation n’a pas été terminée.

Le terminal affiche les réponses puis le tableau coloré, groupé par tour.
Les codes de sortie restent : **0** = réussite complète, **1** = échec ou scénario
incomplet, **2** = configuration/connexion/écriture impossible.

## Rapport

Un JSON daté `history-….json` contient le code d’essai, les verdicts globaux
séparés et une entrée par tour avec la requête réelle expurgée, la réponse brute,
le texte SDK, l’usage dans le brut, la durée et les contrôles. Il est sauvegardé
après le premier tour puis complété après le second, pour conserver le premier
échange si l’exécution est interrompue ensuite.

La clé du proxy et les en-têtes sensibles sont expurgés. Le code `CONTEXT_…`
est une donnée de test, pas une clé d’authentification, et reste visible.
Aucun retry ni redirection. Timeout réseau de 300 secondes par appel, en plus
du timeout du proxy. Deux appels au maximum par exécution.

## Vérifications contrôlées

- Deux réponses conformes et code retrouvé : PASS.
- Deux réponses conformes mais mauvais code : échec de consigne seulement.
- Première réponse invalide : échec technique et aucun second appel.
- Les requêtes enregistrées confirment les rôles et l’ordre, le renvoi du vrai
  message assistant et l’absence d’identifiant de conversation serveur.

## Sources officielles

Consultées le **20 septembre 2026**, version du client épinglée à **3.16.2**.

- [OpenAI : gestion de l’état d’une conversation](https://developers.openai.com/api/docs/guides/conversation-state).
- [OpenAI : création d’une réponse](https://platform.openai.com/docs/api-reference/responses/create).
- [Contrat et sources du scénario texte simple](create-text.md).

La continuité par `previous_response_id` sera un scénario distinct.
