# Responses features evidence

Date: 2026-09-20. Proxy frais initial `127.0.0.1:8788`, puis QA minimal
`127.0.0.1:54820`, issu de la configuration du dépôt en mode `minimal`, modèle
`gpt-6-astra`, SDK Python OpenAI 3.16.2. Chaque rapport est expurgé de la clé locale et de
`encrypted_content`.

Observés: instructions (omission, null et valeur), JSON object, JSON Schema, function call
avec résultat réel 42, tool choice, deux function calls parallèles, répétition de
cache (compteurs `cached_tokens:0` sur cette courte entrée), et fichier data URL
inline. Rapports: `api-tests/responses/results/features-{instructions,json-object,json-schema,function,tool-choice,parallel-tools,cache,native-media}-*.json`.

Écarts ouverts: temperature/top_p/max_output_tokens ont reçu 400 séparés;
web search et code interpreter ont été tentés et refusés; MCP/file
search manquent de configuration; encrypted reasoning n’a pas été exposé malgré
`include`, donc aucun replay n’a été inventé. Le cache répété est accepté mais
les deux compteurs sont à zéro: ce n’est pas une preuve de cache hit. Les sorties
image/audio natives restent non observées; seul l’input_file inline est testé.

Après le remplacement du PNG 1x1 par un PNG RGB rouge contrôlé 64x64, l’input
image a été accepté mais a répondu « beige »: l’input multimodal est donc un écart
sémantique ouvert. Image generation a produit un `image_generation_call` terminé
dont le résultat base64 commence par la signature PNG; le binaire est redacted du rapport.

Les rapports Features créés avant 15:51Z ont été retirés: leur masque regex pouvait
produire un JSON non parseable. Ils ne sont pas utilisés comme preuve. Les deux
rapports de remplacement `features-native-media-20260920T155140716832Z.json` et
`features-function-20260920T155147091405Z.json` sont parseables et ont été vérifiés
sans valeur `encrypted_content` chiffrée. Les autres constats précédents restent
des tentatives historiques à refaire avant d’être cités comme captures actuelles.
