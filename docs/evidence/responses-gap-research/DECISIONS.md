# Ce qui échoue, ce qui peut être traduit, et ce qui manque

Recherche du 20 septembre 2026. Sept appels natifs ciblés ont complété la lecture des sources. La [revue initiale](review.md) porte sur cette première recherche. La demande ultérieure sur le cache a ajouté un A/B de quatre appels et une correction dédiée, suivis séparément dans [CACHE.md](CACHE.md).

**Décision : ne pas abandonner la recherche web, la compaction ni la continuité HTTP.** Les deux premières viennent de réussir via le contrat natif ; la troisième dispose d'un modèle de pont HTTP/WebSocket implémenté chez Sub2API. Le stockage et les tâches de fond seraient une extension du proxy ; les contrôles du modèle sans équivalent restent à refuser explicitement.

## Lecture du résultat

Le proxy sait déjà créer des réponses texte JSON/SSE, conserver un historique explicite fourni par le client, faire du JSON structuré et des appels de fonctions. La continuité native sur une connexion WebSocket a été prouvée. Un fichier texte inline et une génération d'image via l'outil Responses ont aussi été observés.

Le banc livré rend les écarts visibles. Il ne contient pas encore une couche complète de traduction ou de stockage de l'API publique. Plusieurs échecs sont des fonctions non implémentées dans le proxy ou des essais insuffisants, pas une impossibilité générale du moteur.

## Concurrents étudiés

| Dépôt | Pourquoi le retenir | Indicateurs relevés le 20 septembre |
| --- | --- | --- |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Traducteurs Codex, transport Responses/WS, nombreux cas particuliers | 52 606 étoiles, push le 20/09, MIT |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | Passerelle OAuth, pont HTTP/WS et adaptations Codex | 42 140 étoiles, push le 20/09, LGPL-3.0 |
| [codex-lb](https://github.com/Soju06/codex-lb) | Projet spécialisé Codex, continuité et récupération des sessions | 3 196 étoiles, push le 19/09, MIT |

Ce choix combine activité, adoption et pertinence du code. Il ne constitue pas un classement universel de qualité. Les sources ont été lues à des commits figés ; leurs suites de tests et leur fonctionnement complet n'ont pas été exécutés chez nous. Métadonnées : [repositories.json](repositories.json).

## Matrice de décision

| Fonction | Preuve locale avant cette recherche | Ce qui manque / possibilité |
| --- | --- | --- |
| Continuer en HTTP avec `previous_response_id` | 400 sur une requête Codex valide ; même principe réussi en WS | Pont HTTP → connexion WS persistante. Piste prioritaire, sans changer le SDK du client. Il faut faire passer le premier tour par ce transport, associer les IDs à leur connexion et gérer expiration/reconnexion. |
| `store:true`, lecture, input items, suppression, conversation | `store:true` refusé localement ; autres routes en 403 HTML distant avec notre session | Aucun stockage natif validé. Le HTML 403 ne permet pas d'attribuer précisément le refus au service Codex plutôt qu'à une passerelle distante. Une API locale de stockage et de conversations pourrait fournir ces comportements ; ce serait une nouvelle responsabilité avec isolation, rétention et suppression explicites. Le pont WS seul ne la remplace pas. |
| `background:true` et annulation | Le proxy bloque la création via sa règle `store:true`, avant l'amont ; cancel n'a pas été essayé | Ce résultat ne prouve pas un refus natif de background. Il faut isoler cette politique locale ; fournir une alternative locale demanderait des tâches asynchrones, statuts, résultats et annulation réelle. Fermer un flux ne certifie pas toute la sémantique de cancel. |
| Compaction | `/responses/compact` renvoie 404 | **Nouveau test natif réussi** : `compaction_trigger` dans le flux normal retourne un véritable item de compaction ; sa réutilisation rappelle exactement le secret. Il reste à traduire l'endpoint public et son enveloppe SDK, avec tests des fenêtres et outils. |
| Recherche web | Rejet du type `web_search_preview` | **Nouveau test natif réussi** : `web_search` retourne un appel de recherche et une citation URL. Il manque la normalisation explicite de l'ancien alias dans les outils et les sélecteurs, puis la régression SDK. |
| Image en entrée | Premier PNG rouge accepté, réponse « beige » | **Retest réussi : « rouge »** pour un PNG RGB 64×64 contrôlé. La vision fonctionne sur ce nouveau cas ; l'origine de la première erreur n'est pas isolée et la robustesse reste à mesurer. |
| Cache de prompt | Ancien test de 20 tokens et absence de mapping `prompt_cache_key` vers `session-id` | **Hit natif observé** : A/B de quatre appels identiques, sans en-tête 0/0 puis avec en-tête 0/1 664 tokens cachés sur 1 822. Le client officiel et CLIProxyAPI appliquent ce mapping. Correction ciblée et nouveau banc vérifiés : un SDK standard obtient ensuite 2 688 tokens cachés sur 2 893, sans en-tête manuel ; [détails et limites](CACHE.md). |
| Reprise du raisonnement chiffré | Réponse valide, item chiffré absent | Le nouvel essai avec effort élevé produit la réponse attendue mais toujours aucun item de raisonnement chiffré. Le replay n'a donc pas pu être exécuté ; il n'a pas été rejeté. Garder le statut non validé. |
| Comptage avant génération (`input_tokens`) | Route refusée 403 | Des concurrents calculent une estimation locale. Une estimation doit être présentée comme telle ; elle ne prouve pas un compte exact identique à Codex, notamment pour outils, images ou contenu opaque. |
| `temperature`, `top_p`, `max_output_tokens` | Rejets individuels 400 | Aucune traduction fidèle démontrée. Supprimer silencieusement ces champs rend la requête acceptable sans respecter le réglage. Conserver un refus explicite tant qu'une équivalence n'est pas prouvée. |
| Code Interpreter | Type d'outil rejeté | Aucun correctif simple démontré. Fournir réellement ce service exigerait un environnement d'exécution et la gestion des fichiers, ou une autre capacité amont ; ce n'est pas un simple renommage d'outil. |
| File search et MCP | Essais empêchés par l'absence de ressources configurées | Statut non testé avec les prérequis, pas « impossible ». Un corpus/vector store et un serveur MCP accessible sont nécessaires ; leur existence côté API payante ne prouve pas leur accès via Codex OAuth. |
| Variantes beta | Non vérifiées | Garder le statut inconnu jusqu'à des essais dédiés ; ne pas généraliser un succès stable. |

## Traduction HTTP vers WebSocket : comportement visé

Chez **Sub2API**, le code [bascule explicitement une entrée HTTP vers l'amont WebSocket](https://github.com/Wei-Shaw/sub2api/blob/7c700729c23187d31ed320f6b19c790e2f194826/backend/internal/service/openai_gateway_forward.go#L789-L805). **codex-lb** apporte des exemples d'[affinité stricte avec le propriétaire d'un ID](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/affinity.py#L490-L508) et de [normalisation des sélecteurs de recherche web](https://github.com/Soju06/codex-lb/blob/9637bdee36744ca65e7cd13ffd47b7e79741f551/app/modules/proxy/api.py#L5387-L5420).

**CLIProxyAPI suit un autre chemin** : son transport HTTP retire `previous_response_id` et attend l'historique fourni ou reconstruit côté client ; cela ne prouve pas un stockage complet des réponses. Son transport WS conserve la continuité pour les clients eux-mêmes en WS. Il ne faut donc pas lui attribuer le pont HTTP/WS de Sub2API. Voir les chemins et commits exacts dans [l'étude CLIProxyAPI](cliproxy.md).

Le client continue à appeler `client.responses.create(...)`. Notre proxy conserve la connexion native Codex et transforme les frames reçues en événements SSE ou en réponse JSON selon `stream`. Le prochain appel HTTP contenant `previous_response_id` retrouve la même connexion.

Le chaînage doit rester lié au bon client et au bon compte. Une connexion expirée ou un ID inconnu ne doit jamais provoquer un nouveau tour sans contexte en prétendant avoir continué. Une reprise par historique complet nécessite de disposer de ce véritable historique ; ce n'est pas un substitut inventé. La persistance durable des réponses reste une décision séparée.

## Ordre proposé

La correction du cache est devenue la priorité à la demande de l’utilisateur. Les propositions suivantes concernent les autres écarts et restent distinctes de cette correction.

1. Corriger le scénario de recherche web et la normalisation de son ancien alias ; intégrer les nouveaux constats de vision, raisonnement et cache dans le banc permanent.
2. Ajouter le pont HTTP/WS en réutilisant le transport natif déjà validé et l'agrégation JSON/SSE existante. Vérifier secret en deux tours, fonctions, annulation, erreur, expiration et isolation.
3. Traduire l'endpoint public de compaction vers le mécanisme natif désormais prouvé ; compléter la couverture des fenêtres complexes et des outils avant de certifier ce nouvel endpoint.
4. Décider séparément si le produit doit fournir stockage/conversations/background. C'est réalisable en construisant ces services locaux, mais non couvert par une simple passerelle native.
5. Laisser les contrôles sans équivalent exact explicitement indisponibles, et les prérequis absents explicitement non testés.

## Sources et preuves

- [Contrat officiel et mécanisme Codex actuel](official-contract.md)
- [Audit exact des échecs locaux](local-failures.md)
- [Code CLIProxyAPI et variante Plus](cliproxy.md)
- [Code Sub2API et codex-lb](sub2api-codexlb.md)
- [Nouveaux essais natifs ciblés](native-probes.md)

Les tests historiques du banc restent conservés. Les nouveaux constats sont ajoutés à cette recherche et ne réécrivent pas rétroactivement les anciens résultats.

## État de livraison

La première recherche et ses sept probes sont terminés. Le correctif du cache et son banc sont implémentés et vérifiés dans [CACHE.md](CACHE.md), avec un véritable hit via le SDK standard et 187 tests réussis. Les propositions de pont HTTP/WS, d'adaptateur public de compaction et de normalisation des outils restent à implémenter dans le produit. Le service existant n'a pas été reconfiguré. Aucun code de concurrent n'a été exécuté et aucun nouveau stockage n'a été ajouté.
