# Responses : banc livré et compatibilité observée

20 septembre 2026 — proxy Codex, modèle `gpt-6-astra`, SDK Python OpenAI 3.16.2 et SDK Node 7.20.0.

## Utilisation

```sh
oai-codex test
oai-codex test responses --help
oai-codex test responses --scenario previous-response
oai-codex test responses --scenario websocket
oai-codex test responses --scenario json-schema
oai-codex test responses --scenario function
```

Le sélecteur conserve les tests 01–03 et propose 24 scénarios. `--base-url`, `--model`, `--key-file` et `--output-dir` permettent de choisir la cible et le dossier de rapports. Chaque scénario conserve ses preuves JSON ; un rejet, une erreur ou un prérequis manquant produit un code de sortie non nul. Le succès du banc de test ne signifie pas que toutes les fonctions de Codex sont disponibles.

## Résultats

| Capacité | Résultat observé |
| --- | --- |
| Texte JSON, SSE, historique explicite | Acquis historiques conservés ; clients et chemins communs couverts par les régressions. |
| Instructions, JSON object et JSON Schema | Réussite des scénarios réels. |
| Fonction, choix d'outil, appels parallèles | Aller-retour avec résultat réel 42 observé ; mauvais résultats rejetés par les tests contrôlés. |
| Continuité WebSocket | Deux tours réels et rappel exact d'un secret sans le répéter au second tour ; vérification indépendante. |
| SDK Node | JSON, SSE et JSON Schema réussis ; continuité HTTP enregistrée séparément comme échec. |
| Fichier texte en entrée | Fichier data URL réellement exploité. |
| Génération d'image via outil Responses | Item image_generation_call et charge utile à signature PNG observés ; contenu binaire masqué dans le rapport. |
| Cache de prompt | Répétition acceptée, compteurs à zéro : aucun cache hit démontré. |
| Image en entrée | PNG rouge 64×64 accepté, réponse « beige » : échec fonctionnel conservé. |
| Raisonnement chiffré | Réponse techniquement valide, item chiffré non fourni malgré include ; replay non validé. |
| Certains paramètres, recherche web, exécution de code | Rejets enregistrés pour cette session et ces requêtes ; aucune indisponibilité universelle déduite. |
| File search, MCP | Prérequis manquants explicitement signalés. |

## Limite structurante : HTTP et WebSocket

Un appel HTTP Codex valide (`input` tableau, `instructions`, `store:false`, `stream:true`) réussit. Le même chemin HTTP refuse ensuite `previous_response_id` avec **400, Unsupported parameter**. Le mode minimal refuse séparément `store:true`. La continuité WebSocket native fonctionne : ces résultats ne sont pas interchangeables.

Les essais de conversation, lecture/input items, suppression, arrière-plan/annulation, comptage et compaction ont reçu des 400/403/404 documentés. Ces écarts restent ouverts. Les variantes `?beta=true` ne sont pas validées. Aucun stockage de réponses, fournisseur supplémentaire ou résultat simulé n'a été ajouté pour fabriquer une compatibilité.

## Vérifications

- `bun run check`, `bun run test`, `bun run build`, `bun run lint` : succès, voir [contrôles finaux](final-checks.md).
- Tests HTTP indépendants du banc d'options : 6 tests, 54 assertions.
- Tests HTTP de cycle de vie : 2 tests, 64 assertions, avec vrais appels SDK vers des serveurs contrôlés, parcours corrects et incorrects.
- Vérification indépendante WebSocket et SDK Node : [WS](websocket-independent.json), [Node](node-independent.json).
- Revue indépendante du banc : [verdict](adversarial-review.md). Ce verdict ne certifie pas une compatibilité Responses complète.
- Vérifications Python : zéro erreur ; cinq avertissements non bloquants restent dans la capture et le CLI lifecycle. Le module de scénarios lifecycle et les options ont zéro erreur/avertissement. Voir [options](features-typing.md), [cycle de vie](lifecycle-typing.md).
- Serveurs de QA arrêtés ; service existant conservé : [nettoyage](qa-runtime.md).
- Contrôle final du CLI : aide avec 24 scénarios, entrée invalide rejetée avec code 1 ; `git diff --check` propre.

## Preuves détaillées

[Options et outils](features.md) · [Cycle de vie](lifecycle.md) · [WebSocket et Node](websocket.md) · [Relais HTTP](relay.md) · [Intégration CLI](integration.md).

Les rapports réels sont dans `api-tests/responses/results/`. Pour l'arrière-plan et la compaction, retenir les captures corrigées `lifecycle-background-cancel-20260920T160720819536Z.json` et `lifecycle-compact-20260920T160532134371Z.json` ; les captures antérieures sont historiques.
