# Responses Core — contrat d'acceptation proposé

Ces critères préparent le premier relais HTTP/SSE. Ils ne sont pas des résultats de tests de transport. Le relais n'est pas encore implémenté et aucun backend authentifié n'a été appelé.

## Périmètre du premier lot

`POST /v1/responses`, requête JSON, réponse JSON ou SSE suivant les capacités réellement vérifiées du backend. L'authentification et le routage restent des adaptations explicites. Outils locaux, WebSocket, catalogue Models, autres routes et control plane sont des lots distincts.

Le schéma public au SHA figé et `ResponsesApiRequest` dans `codex-rs/codex-api/src/common.rs` sont les points de départ. Les preuves et empreintes sont dans `source-lock.json`. La compatibilité doit être établie champ par champ ; l'occurrence d'un nom dans les deux sources ne suffit pas.

## Scénarios à exécuter sur le futur relais

| ID | Déclencheur | Résultat observable attendu | Niveau | État |
|---|---|---|---|---|
| RC01 | JSON avec champs inconnus imbriqués, outils et items opaques | Le backend de test reçoit exactement les bytes d'origine ; aucun allowlist ne supprime de champ. | Local via vrai serveur HTTP | NOT_RUN |
| RC02 | Variantes `null`, champ omis, `false`, tableau vide et objets d'outils | Les distinctions sont conservées. Une contrainte backend connue donne une erreur explicite, jamais une transformation silencieuse. | Local puis backend autorisé | NOT_RUN |
| RC03 | SSE découpé au milieu d'un caractère UTF-8 et d'un événement ; événement inconnu et commentaire SSE | L'ordre et les bytes sont conservés, la transmission commence avant la fin du flux, aucune reconstruction par un parseur restrictif. | Local via vrai serveur HTTP | NOT_RUN |
| RC04 | Backend HTTP 400, 401, 429 ou 500 | Le statut et le corps sont conservés ; les headers autorisés, dont `Retry-After`, sont transmis. | Local puis backend autorisé | NOT_RUN |
| RC05 | Headers `Connection`, header nommé par `Connection`, autorisation et secret | Headers hop-by-hop retirés ; auth remplacée uniquement selon la configuration. Aucun secret dans logs/fixtures. | Local | NOT_RUN |
| RC06 | Deux comptes, IDs de réponse et état opaque différents | Aucune fuite d'état entre identités ; le replay reste dans le périmètre confirmé. | Local puis backend autorisé | NOT_RUN |
| RC07 | Client lent puis déconnexion en cours de génération | Mémoire bornée, backpressure et annulation propagée ; aucune génération laissée active sans raison. | Local puis backend autorisé | NOT_RUN |
| RC08 | Même requête autorisée, directe puis via relais | Diff des requêtes et enveloppes ; variantes de contenu généré tolérées selon protocole. Headers, erreurs, événements et état comparés. | Backend autorisé | NOT_RUN |
| RC09 | `stream: false` sur le backend choisi | Support démontré, ou erreur explicite documentée ; aucune réponse finale synthétisée annoncée comme pass-through. | Backend autorisé | NOT_RUN |

## Prochain travail sur l'atlas

1. Revalider sémantiquement les champs racine de CreateResponse contre `ResponsesApiRequest`, y compris les attributs serde (omission, valeurs nulles, types et unions).
2. Revoir les trois pointeurs publics absents et les deux symboles Codex non localisés dans `generated/report.json`. Absence de référence ne signifie pas absence de fonctionnalité.
3. Rechercher et documenter le mécanisme actuel de compaction ; ne pas remplacer automatiquement l'ancien `CompactClient` par une autre source.
4. Résoudre ou documenter les quatre références/ancres récursives du graphe. Les inconnues d'accès compte/modèle restent ouvertes jusqu'aux expériences autorisées.

Le rapport structurel et les critères de transport ont des niveaux de preuve distincts. Aucun test de sérialisation JSON isolé ne sera présenté comme un test réussi du relais.
