# Responses 04–10 : continuité et cycle de vie natifs

```sh
uv run api-tests/responses/test_lifecycle.py \
  --scenario previous-response \
  --base-url http://localhost:8788/v1 \
  --model gpt-6-astra \
  --key-file /chemin/vers/cle \
  --output-dir api-tests/responses/results
```

Les scénarios disponibles sont `previous-response`, `conversation`, `retrieve`,
`delete`, `background-cancel`, `input-tokens`, `compact` et `store-json`. Chaque exécution
utilise le SDK Python OpenAI 3.16.2, désactive les retries et écrit un rapport
JSON horodaté sans clé. Chaque opération contient la requête et la réponse
redacted, le statut HTTP, la durée, la version SDK et deux verdicts séparés :
`technical_passed` pour le transport/schéma et `functional_passed` pour l'effet
observé. `passed` exige les deux ; `rejected` signifie qu'au moins une route a
répondu mais que l'effet attendu n'est pas démontré ; `unavailable` signifie
qu'aucune route utile n'a été acceptée. Le script ne crée aucune mémoire locale.
Les suppressions et annulations ne ciblent que les identifiants créés pendant le
run actuel.

## Stockage et compaction

`oai-codex test responses --scenario retrieve` vérifie la création SSE avec
`store:true`, le texte terminal, la relecture, les input items puis le nettoyage.
`--scenario store-json` vérifie le même parcours en JSON.
`--scenario delete` exige une relecture HTTP 404 après suppression.
`--scenario compact` exige un item de compaction chiffré puis un rappel exact
après replay ; les champs SDK optionnels null sont omis lors du replay.

Le stockage du proxy est éphémère. Conversation, background/cancel et comptage
restent des sondes de compatibilité, pas des capacités promises.
