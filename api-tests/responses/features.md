# Scénarios Responses 13–24

Le pilote unique est `features.py`. Il utilise le SDK Python OpenAI 3.16.2 contre
le proxy choisi; il ne lit jamais une clé dans le rapport.

```sh
uv run api-tests/responses/features.py \
  --scenario instructions \
  --base-url http://127.0.0.1:8788/v1 \
  --model gpt-6-astra \
  --key-file .local/server-token
```

Les scénarios sont `instructions`, `parameters`, `json-object`, `json-schema`,
`function`, `tool-choice`, `parallel-tools`, `reasoning-replay`, `cache`,
`image`, `builtins` et `native-media`. Chaque lancement écrit
`results/features-<scenario>-<UTC>.json` avec le modèle, la version SDK, chaque
requête/réponse redacted et deux verdicts: transport/contrat puis comportement.

Le scénario `cache` envoie deux fois le même préfixe immuable, les mêmes octets
et la même `prompt_cache_key`. Il conserve, par tentative, `usage` brut observé:
présence de `usage`, `input_tokens`, puis lecture et écriture cache distinguant
champ absent, `null`, valeur numérique ou forme malformée. Le transport peut
être valide alors que le comportement reste en échec: `CACHE_OK` avec une
lecture cache absente ou égale à zéro n'est jamais un cache hit démontré. Le
rapport ne traite pas un seuil de taille comme un contrat Codex OAuth; seul un
compteur de lecture cache positif observé valide ce comportement.

`upstream_rejected` conserve le statut et le corps sans le présenter comme une
indisponibilité générale. `transport_unavailable` est un échec de connexion;
`prerequisite_missing` est réservé à une ressource explicitement absente, ici un
vector store pour file search ou une configuration MCP. Une réponse 200 seule ne
valide jamais une sémantique: JSON doit être `{"answer":42}`, la fonction doit
faire l’aller-retour `function_call` puis `function_call_output:42`, et l’image
doit être reconnue rouge.

Les rapports actuels sont redacted de façon structurée, y compris
`encrypted_content`, puis restent des JSON parseables. Les captures remplacées
après une correction de redaction ne doivent pas être utilisées comme preuve.
Le scénario `native-media` ne prouve actuellement que l’entrée fichier inline;
aucune sortie image ou audio n’est déclarée observée.

L’input image contrôlé utilise maintenant un PNG RGB rouge 64x64. Le scénario
`builtins` vérifie une signature PNG pour l’output de image generation et masque
le binaire dans le rapport; web search et code interpreter restent des résultats
amont documentés séparément.
Le scénario `native-media` ne prouve actuellement que l’entrée fichier inline;
aucune sortie image ou audio n’est déclarée observée.
