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

Ces pilotes effectuent de vrais appels sur la cible choisie : ils ne font pas
partie de la suite locale hors ligne et exigent un mandat live distinct.
Les anciennes observations natives restent datées, sans valider les adaptations
actuelles. En mode minimal, le proxy fournit maintenant un stockage SQLite local
opt-in, des Conversations durables et background/cancel/reprise SSE, testés avec
des upstreams synthétiques ; raw reste un relais. Le comptage exact demeure non
établi, jamais estimé. Voir le [contrat courant et le bilan de livraison](../../README.md#bilan-de-livraison-local--20-octobre-2026)
pour rétention, quotas, suppressions distinctes et limites backend.
