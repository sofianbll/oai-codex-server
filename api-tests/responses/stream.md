# Responses 02 — Streaming

## Lancer

```bash
oai-codex test responses --scenario stream
```

Ou `oai-codex test` → **Responses** → **02 — Streaming**.
`oai-codex test responses` continue à lancer le scénario 01.
Le modèle, l’adresse et la clé proviennent de la configuration, avec les mêmes
options de remplacement que le scénario texte simple.

Le script autonome est `test_stream.py` : options `--base-url`, `--model`,
`--key-file` (sinon `OPENAI_API_KEY`) et `--output-dir` (sinon `results/`).
Il utilise le SDK OpenAI Python **3.16.2**, sans retry ni suivi de redirection,
avec un timeout réseau de 300 secondes et le timeout du proxy en parallèle.

## Requête

`POST /v1/responses`, authentifié par la clé locale du proxy :

```json
{
  "model": "gpt-6-astra",
  "input": "Réponds exactement : TEST_OK",
  "store": false,
  "stream": true
}
```

Le modèle de cet exemple est remplacé par celui configuré. Aucun outil ni
paramètre de raisonnement n’est ajouté. Le résultat est un flux SSE
(`text/event-stream`) : des événements JSON arrivent progressivement.

Séquence simplifiée pour le texte :

```text
response.created
… événements de progression et de contenu …
response.output_text.delta   → fragment
response.output_text.delta   → fragment suivant
response.output_text.done    → texte complet du contenu
response.output_item.done    → message terminé
response.completed          → réponse finale avec output et usage
```

## Ce qui est contrôlé

| Contrôle | Critère |
|---|---|
| Transport et SDK | HTTP 200, type `text/event-stream`, itérateur officiel consommé sans erreur |
| Schéma des événements | JSON original validé strictement avec le schéma `ResponseStreamEvent` du SDK épinglé |
| Cycle du flux | une création en premier, une fin `completed` en dernier, aucun événement `error`, `failed` ou `incomplete` |
| Ordre | `sequence_number` strictement croissants ; fragments avant leur `done` ; aucun événement JSON après la fin |
| Fragments texte | au moins un fragment ; concaténation identique à `output_text.done` pour chaque contenu |
| Cohérence finale | mêmes IDs de réponse/message, mêmes index de contenu et même texte dans la réponse finale |
| Réponse finale | mêmes contrôles de schéma, état, message assistant et usage que le scénario 01 |
| Consigne, séparément | texte final extrait par le SDK égal à `TEST_OK` après suppression des espaces extérieurs |

Le marqueur `[DONE]` est accepté après la réponse finale mais n’est pas requis.
Il ne remplace pas `response.completed`. Un événement JSON inconnu du schéma
épinglé est signalé comme non conforme à cette référence et reste dans le brut.
Les événements intermédiaires autres que le texte sont conservés et validés,
sans tester ici les fonctionnalités outils, images ou raisonnement.

Un texte court peut tenir dans un seul fragment : deux fragments ne sont pas
une condition de conformité. Les horodatages sont des observations côté client,
pas une preuve de latence serveur ni un benchmark de performance.

## Ce que le terminal et le rapport montrent

Le terminal affiche chaque arrivée de fragment avec son délai depuis le départ,
puis le texte final expurgé, le tableau coloré et les verdicts technique/consigne.
Les fragments eux-mêmes ne sont pas affichés séparément afin de ne pas divulguer
une clé qui serait renvoyée en plusieurs morceaux par un serveur défectueux.

Chaque rapport JSON daté conserve :

- la requête réellement envoyée et ses en-têtes expurgés ;
- le statut HTTP, le type de contenu et le flux SSE reçu, dans `response_body` ;
- les types d’événements consommés par le SDK et leurs délais de réception ;
- les délais du premier fragment et de la fin, le texte final et les verdicts.

Le corps conserve le SSE au niveau HTTP après décodage du transport, pas les
paquets réseau ni la compression. En cas de coupure, les données reçues jusque-là
sont conservées. Un UTF-8 invalide échoue au contrôle ; le rapport le représente
avec des caractères de remplacement. La clé est expurgée du rapport.

Codes : **0** = tous les contrôles réussis ; **1** = échec de contrat/lecture ou
consigne ; **2** = essai impossible (configuration, connexion initiale, écriture).

## Adaptation Codex observée et corrigée

L’essai initial a reçu les fragments et le message `response.output_item.done`,
mais `response.completed.response.output` était vide. En mode `minimal`, le proxy
reconstruit désormais cet `output` absent ou vide à partir des éléments complets
`output_item.done`, triés par `output_index`, comme pour le scénario non streaming.
Il ne fabrique ni texte ni usage. Un `output` final déjà rempli reste prioritaire.
Les autres événements passent au fil de leur réception ; les éléments retenus
pour reconstruction sont bornés par la limite mémoire du proxy. Le mode `raw`
conserve le flux amont sans cette adaptation.

## Vérifications du banc

Fixtures : flux conforme, fin absente, texte incohérent, JSON invalide et numéros
hors ordre. Une fixture supplémentaire ne libère la fin du flux qu’après avoir
observé un affichage de fragment par le CLI : elle vérifie la lecture progressive.
Les tests du proxy vérifient la reconstruction d’un output absent ou vide,
la diffusion avant la fin, les annulations et la conservation des événements inconnus.

## Sources officielles

Consultées le 20 septembre 2026 ; schémas effectifs du paquet `openai==3.16.2`.
Les liens vers `main` peuvent évoluer. Le lecteur de trames SSE interne du SDK
est également utilisé pour valider les données originales capturées, sans
substituer un client maison à l’appel officiel.

- [Guide du streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses).
- [Schéma officiel des événements](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_stream_event.py).
- [Schéma officiel de réponse](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response.py).
- [Scénario 01 et contrôles d’usage](create-text.md).
