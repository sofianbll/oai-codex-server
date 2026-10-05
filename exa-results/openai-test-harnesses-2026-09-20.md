# Bancs publics de test OpenAI : recherche vérifiée
Date de consultation : 20 septembre 2026.

## Conclusion

OpenAI publie bien des tests d’API. Deux éléments directement réutilisables ont été identifiés dans ses dépôts : les tests de ressources des SDK officiels, dont Models, et le banc de compatibilité gpt-oss pour Responses / Chat Completions. Le projet Open Responses propose également un banc de conformité avec interface web et CLI.

Ces trois éléments ont des objectifs différents. Aucun des documents inspectés ne promet une certification exhaustive de toute l’API OpenAI pour un proxy tiers. L’existence des tests officiels est confirmée ; leur exécution sur notre proxy et sa compatibilité restent non vérifiées.

## Méthode et actualité

- Exa Search : 9 recherches, 3 axes, 70 résultats retournés, 55 URL distinctes. Plusieurs URL désignent le même fichier à des versions différentes ; ce ne sont pas 55 sources indépendantes.
- Axes : bancs officiels publics ; tests internes aux SDK ; spécifications et réutilisation.
- Lecture intégrale des sources décisives, puis vérification directe sur GitHub à des commits précis.
- La fenêtre du 20 mars au 20 septembre 2026 a servi à chercher les évolutions récentes. Les sources plus anciennes restent incluses lorsqu’elles définissent le périmètre d’un outil.
- Les pages indexées sur les branches mobiles donnaient des versions différentes du lanceur Python. Les conclusions ci-dessous utilisent le commit exact vérifié, avec Steady et uv.
- Aucune installation, aucun test ni appel au proxy. Le résultat est une analyse documentaire et du code public.

| Dépôt | Commit de référence consulté | Date du commit |
|---|---|---|
| openai/openai-python | [69a2c1db](https://github.com/openai/openai-python/commit/69a2c1db6feacf32be6693809e7cab1c3b49cad7) | 19 septembre 2026 |
| openai/openai-node | [5de23604](https://github.com/openai/openai-node/commit/5de2360474aba30a3176ba2dde9ac5e55783efb5) | 19 septembre 2026 |
| openai/gpt-oss | [7b583341](https://github.com/openai/gpt-oss/commit/7b583341fe16729127f6d5b94a7b09ccae97e1a1) | 24 juillet 2026 |
| openresponses/openresponses | [92c12d96](https://github.com/openresponses/openresponses/commit/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c) | 14 juillet 2026 |

Ces dates sont celles des commits de référence des dépôts, pas nécessairement des dernières modifications de chaque test.

## 1. Models : tests officiels du SDK Python

Le fichier couvre les méthodes Models list, retrieve et delete. Il contient des variantes synchrones, asynchrones, des modes de validation des réponses, et des vérifications des interfaces de lecture HTTP du SDK. Les appels vérifient les objets Model, ModelDeleted et les pages de modèles. [Tests Models](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/tests/api_resources/test_models.py).

Le lanceur accepte TEST_API_BASE_URL pour cibler un autre serveur. Sans cette variable, il utilise normalement un serveur simulé Steady. Le workflow CI public lance ce script. Cela constitue une preuve d’intégration à l’outillage officiel du SDK, pas une preuve de succès contre notre proxy. [Lanceur](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/scripts/test), [workflow CI](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/.github/workflows/ci.yml).

### Adaptations nécessaires pour un serveur réel

1. L’URL est configurable, mais les fixtures transmettent explicitement une clé factice. Définir seulement OPENAI_API_KEY ne remplace donc pas cette clé. [Fixtures](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/tests/conftest.py).
2. Les identifiants des modèles sont prédéfinis. Les tests delete utilisent un identifiant factice de modèle fine-tuné et répètent la suppression. Une exécution réelle exige une gestion appropriée des ressources de test et du périmètre pris en charge. [Tests Models](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/tests/api_resources/test_models.py).
3. Le fichier Models n’inclut pas de scénarios dédiés aux clés invalides ou absentes, à un identifiant inexistant, ni à la cohérence entre la liste et la fiche retournée. Ses tests d’identifiant vide attendent une erreur locale du SDK, avant requête HTTP. C’est une limite constatée par lecture de ce fichier, pas une affirmation sur toutes les autres suites du dépôt. [Tests Models](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/tests/api_resources/test_models.py).
4. La validation porte sur les objets interprétés par le SDK. Elle n’équivaut pas à une validation exhaustive du JSON brut et de toute la sémantique HTTP. Les variantes with_streaming_response concernent la lecture du corps HTTP, pas un protocole SSE de Models. [Assertions](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/tests/utils.py), [tests Models](https://github.com/openai/openai-python/blob/69a2c1db6feacf32be6693809e7cab1c3b49cad7/tests/api_resources/test_models.py).

Le SDK Node contient aussi les trois opérations, mais ses assertions de ce fichier portent surtout sur les objets Response et les différentes interfaces du client. Il ne fournit pas ici une validation détaillée de chaque champ du modèle. Pour notre besoin, le fichier Python offre davantage de vérifications exploitables. C’est une appréciation issue de la comparaison du code. [Tests Node](https://github.com/openai/openai-node/blob/5de2360474aba30a3176ba2dde9ac5e55783efb5/tests/api-resources/models.test.ts).

## 2. Responses et Chat Completions : banc officiel gpt-oss

Le répertoire compatibility-test utilise le SDK Agents TypeScript et le client OpenAI. Il permet de configurer un fournisseur et de lancer des scénarios d’appels d’outils en mode Responses ou Chat Completions, avec répétitions et traces. [README officiel](https://github.com/openai/gpt-oss/blob/7b583341fe16729127f6d5b94a7b09ccae97e1a1/compatibility-test/README.md).

OpenAI le présente comme un contrôle de fonctionnement initial et précise qu’il ne garantit pas une compatibilité complète avec ses API. Il ne couvre pas Models. Le guide a été publié le 11 août 2025. [Guide OpenAI](https://developers.openai.com/cookbook/articles/gpt-oss/verifying-implementations).

Certaines assertions demandent du raisonnement brut propre au fonctionnement attendu de gpt-oss. Les appliquer sans distinction à un fournisseur Codex pourrait produire un verdict inadapté. Cette limite découle du code et du périmètre décrit dans le guide. [Assertions du banc](https://github.com/openai/gpt-oss/blob/7b583341fe16729127f6d5b94a7b09ccae97e1a1/compatibility-test/runCase.ts).

## 3. Responses : Open Responses Acceptance Tests

Le projet offre une interface interactive et un lanceur CLI configurable avec URL, modèle et clé. Il vérifie le protocole Open Responses. C’est particulièrement pertinent pour le besoin d’inspecter des essais visibles et leurs résultats. Il ne couvre pas Models ni Chat Completions. [Interface](https://www.openresponses.org/compliance), [README](https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/README.md).

La page expose 17 scénarios : 10 proposés dans le navigateur et 7 WebSocket réservés à la CLI. Attention : le scénario de schéma des phases de sortie utilise une fixture locale sans requête HTTP. Il ne faut donc pas annoncer 17 essais réseau réels sur le proxy. [Code des scénarios](https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/lib/compliance-tests.ts).

## Choix proposé pour la prochaine étape

Pour Models, partir des tests officiels Python comme référence réutilisable, puis établir la liste exacte des exigences couvertes et manquantes. Adapter uniquement la configuration de connexion et les ressources de test nécessaires ; ne pas affaiblir les assertions pour obtenir du vert.

Pour déclarer une compatibilité, séparer les résultats observés, les fonctionnalités volontairement hors périmètre et les cas pas encore vérifiés. Un test réussi du SDK ne démontre ni l’exhaustivité du contrat ni la stabilité du serveur.

Les outils génériques de validation OpenAPI et les testeurs tiers restent des compléments possibles. Cette recherche ne justifie pas de choisir un moteur définitif avant la comparaison des exigences Models et des assertions existantes.

## Journal des recherches Exa

1. **official_harnesses** — OpenAI published API compatibility conformance testing suite for third party providers Responses Chat Completions models endpoints gpt-oss openresponses (10 résultats demandés.)

2. **sdk_internal_tests** — GitHub openai openai-python openai-node official SDK tests resources models test_models.py Prism mock server TEST_API_BASE_URL running test suite against real endpoint (10 résultats demandés.)

3. **standards_and_reuse** — OpenAI API provider conformance validation official test harness Stainless SDK contract tests Prism openapi specification openresponses compliance 2026 (10 résultats demandés.)

4. **sdk_internal_tests** — Stainless Steady @stdy/cli OpenAPI validation proxy forward upstream server verify real API requests responses GitHub (10 résultats demandés.)

5. **official_harnesses** — OpenAI official API integration conformance test harness endpoint models list retrieve delete github openai tests e2e SDK real server (10 résultats demandés.)

6. **standards_and_reuse** — Open Responses OpenAI launched acceptance tests conformance January 2026 official OpenAI providers schema test suite limitations (5 résultats demandés.)

7. **sdk_internal_tests** — Official openai-python SDK tests assert_matches_type strict_response_validation test_models.py TEST_API_BASE_URL tests utils conftest (5 résultats demandés.)

8. **official_harnesses** — OpenAI public test suite compatibility endpoint Models API SDK integration tests GitHub Actions test workflow (5 résultats demandés.)

9. **standards_and_reuse** — OpenAI openai-python tests Steady Prism mock TEST_API_BASE_URL compatibility testing 2026 (5 résultats demandés.)

