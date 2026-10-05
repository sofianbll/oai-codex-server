# Cache Codex : diagnostic et correction

## Écarts locaux confirmés

Le client OpenAI envoyait une clé JSON stable, mais notre mode minimal ne construisait pas `session-id`. Le client Codex officiel explique que ChatGPT utilise cet en-tête pour l’affinité du cache. CLIProxyAPI applique également cette correspondance.

Le banc permanent comportait une seconde erreur : son prompt ne mesurait que 20 tokens et il déclarait la sémantique réussie dès que le modèle répondait `CACHE_OK`, même avec zéro token caché.

## Comparaison avant modification

Quatre appels au service existant, avec un corps et une clé identiques, le même modèle et la même configuration d’authentification :

| Condition | Premier appel | Deuxième appel | Input tokens par appel |
| --- | ---: | ---: | ---: |
| Sans `session-id` | 0 caché | 0 caché | 1 822 |
| Avec `session-id` égal à la clé | 0 caché | 1 664 cachés | 1 822 |

Un cache hit a été observé dans la condition corrigée. La séquence n’inclut pas un retour à la condition initiale : la clé est restée en mémoire puis le processus s’est terminé. Le warm-up ou le timing ne sont pas exclus comme facteurs du hit ; la causalité exclusive n’est pas établie. La correction s’appuie sur l’écart au protocole officiel, sa présence chez CLIProxyAPI et ce résultat positif, sans garantir un hit systématique pour tous les comptes et modèles.

## Correction retenue

- Seulement pour `POST /v1/responses` en mode minimal HTTP : recopier une clé explicite représentable sans modification dans `session-id` lorsque cet en-tête est absent.
- Conserver la priorité d’un en-tête fourni par le client et tous les champs JSON. Une clé absente, vide, non textuelle, contenant des contrôles ou non ASCII ne provoque aucune nouvelle erreur : elle reste dans le corps, sans dérivation d’en-tête.
- Ne pas inventer de clé globale, aléatoire par requête ou dérivée du prompt. Ne pas ajouter les anciens alias underscore ni d’en-têtes d’identité supplémentaires.
- Conserver le mode raw, les autres routes et les compteurs amont. Aucun cache local de réponses n’est ajouté.
- Corriger le scénario permanent : préfixe stable suffisamment long à mesurer, deux requêtes identiques, lecture des vrais compteurs et séparation entre acceptation technique et hit observé.

La conservation de l’historique, la compaction et le raisonnement chiffré restent des capacités distinctes de l’affinité du cache.

## Sources inspectées

1. [Client officiel Codex, dérivation de l’affinité](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/src/client.rs#L561-L582) et [nom exact des en-têtes](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/codex-api/src/requests/headers.rs#L5-L14).
2. [Analyse CLIProxyAPI](cache-cliproxy.md) : correspondance du champ JSON vers `Session-Id` ; ne pas confondre une issue fermée avec l’implémentation de tous ses contournements.
3. [Analyse Sub2API et codex-lb](cache-competitors.md) : stabilité de session et de compte, distinction affinité/continuité, cache parfois intermittent ; aucune preuve justifiant l’ajout de contrôles publics GPT-6 au contrat OAuth.

## Vérification réelle après correction

Depuis un serveur temporaire chargé avec les sources corrigées, le SDK OpenAI Python 3.16.2 a effectué deux appels JSON standard, sans `session-id` ajouté par le script :

| Appel | HTTP | Input tokens | Cached tokens | Réponse attendue |
| --- | ---: | ---: | ---: | --- |
| Premier | 200 | 2 893 | 0 | Oui |
| Répété | 200 | 2 893 | 2 688 | Oui |

La clé retournée par Codex correspondait à la clé demandée sur les deux appels. Le verdict technique et le hit observé sont positifs. [Preuve expurgée](cache-postfix-qa.json). Le cas d’erreur JSON invalide renvoie bien 400 et le serveur répond 200 à son health check.

Le banc est aussi renforcé pour interdire un compteur caché supérieur au nombre d’input tokens. Cette vérification a été ajoutée après les appels ci-dessus ; le résultat natif respecte déjà cette contrainte (0 < 2 688 <= 2 893). Son évaluation avec le prédicat final réussit sans nouvel appel réseau. Les empreintes du code évalué sont conservées dans la preuve JSON.

Les sources corrigées ne sont pas encore chargées dans le service existant sur8788 : il est resté actif pendant la vérification sur un serveur temporaire.

## Contrôles finaux

- 187 tests passent, aucun échec ; TypeScript, build et lint réussissent.
- Le prédicat cache rejette aussi les valeurs absentes, nulles, malformées ou supérieures au nombre d’input tokens.
- Les tests de régression ont échoué avant les corrections puis réussi après, pour le mapping et pour le faux positif du banc.
- [Contrôles et empreintes des fichiers](cache-final-checks.md), [régression gateway](cache-fix.md), [régression du banc](cache-bench-measurement-fix.md).
- Le serveur temporaire, sa clé, sa configuration et les captures brutes ont été supprimés. Seules les preuves expurgées sont conservées.

[Revue finale indépendante : PASS](cache-review.md), liée aux empreintes des huit fichiers concernés. La comparaison générale des autres capacités est conservée dans [DECISIONS.md](DECISIONS.md).
