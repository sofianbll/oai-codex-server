# Périmètre utile du proxy Responses

Décision après clarification utilisateur : privilégier les fonctions requises par les clients et les traductions simples, sans recréer inutilement le backend d’une application de chat.

- Chat ordinaire : le client peut conserver son historique et le transmettre. Conversations API et stockage durable dans le proxy ne sont pas obligatoires. La continuité HTTP/WS implémentée reste temporaire, pas une persistance.
- Arrêter une génération en streaming : annuler la requête/couper le flux est déjà pris en charge. POST /responses/{id}/cancel concerne des jobs background et constitue un autre service.
- Background/polling/cancel : utile pour agents ou traitements longs détachés. Aucun équivalent complet n’a été démontré dans les chemins Codex OAuth des trois dépôts inspectés. Réalisable localement, mais demande un gestionnaire de jobs ; reporté.
- Conversations persistantes : utile seulement si le client veut déléguer au serveur la gestion des conversations. Nécessiterait état, CRUD, isolation et restauration du contexte ; reporté faute de besoin client identifié.
- Stockage durable : possible avec une base locale. Sauvegarder des réponses ne rend pas leurs IDs WebSocket réutilisables après redémarrage ; cette continuité demanderait une stratégie distincte. Le stockage en mémoire existant suffit aux essais actuels ; persistance reportée.
- Paramètres refusés et Code Interpreter : refus observés sur notre backend, pas preuve d’impossibilité universelle. Aucune traduction fidèle simple démontrée. Documenter les refus, sans supprimer silencieusement les réglages ni déclarer une compatibilité fictive.
- File Search/MCP : prérequis manquants, pas impossibilité démontrée.

Les mécanismes simples déjà identifiés dans les sources ont été implémentés : affinité cache, alias web, compaction, pont HTTP/WS. Rien ne justifie ici un nouveau chantier de stockage ou de jobs uniquement pour cocher des routes de la référence OpenAI.

Sources déjà inspectées : ../responses-gap-research/cliproxy.md (incluant rafraîchissement du commit courant), ../responses-gap-research/sub2api-codexlb.md. L’absence de preuve dans les routes étudiées ne prouve pas l’absence de toute fonction interne dans chaque dépôt.
