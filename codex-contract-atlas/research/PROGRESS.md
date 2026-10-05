# Lot 0 — sources et inventaire reproductibles

- Terminé : collecte des deux dépôts à des SHA complets, 24 fichiers récupérés ; une référence de compaction absente et sept sources web non figées restent explicites.
- Terminé : inventaire structurel sous forme de graphe (45 opérations, 6 228 nœuds, 2 948 déclarations de propriétés), contrôle des empreintes et des références des 366 fiches, génération déterministe hors ligne.
- Terminé : 27 tests réussis (19 existants + 8 tests CLI), aide et mauvais argument exercés, contrôle syntaxique des quatre fichiers JavaScript ajoutés, build réussi.
- Terminé : deux générations identiques octet pour octet, puis nouvelle collecte dans un dossier vide aux deux SHA verrouillés ; quatre artefacts strictement identiques aux précédents. Voir `reproduction-check.json` et `test-results.txt`.
- Terminé : rapport dans `generated/REPORT.md`, inconnues dans `generated/unknowns.json` et critères Responses Core dans `RESPONSES-CORE.md`.

Le HTML reconstruit conserve l'empreinte de la livraison initiale : `d47c3be7912ea993848ed2aeafd433f61f628f8f359fb7c810a0644aea6ddf46`. Aucun changement visuel n'a été introduit. Les serveurs LSP TypeScript et Biome ne sont pas installés ; les diagnostics LSP n'ont donc pas été exécutés. Leurs outils de décision d'installation ne sont pas exposés dans cette session ; aucune installation globale n'a été effectuée.

Les deux collectes ont retourné le code 2 avec le même unique fichier absent (`compact.rs`). Les 24 fichiers attendus et le JSON normalisé ont tous passé la vérification des empreintes. Le code 0 du générateur signifie que le rapport a été produit à partir d'entrées intactes, pas que toutes les sources ou compatibilités sont résolues.

## Suite identifiée, hors de ce lot

Revalidation sémantique des champs Responses Core, résolution des quatre ancres/références récursives signalées, recherche du mécanisme actuel de compaction et revue des trois pointeurs OpenAPI absents et deux symboles Codex non localisés. Les sept sources web restent non figées. Aucun de ces points n'est présenté comme achevé.

Le périmètre de ce lot est la preuve structurelle. La présence d'un pointeur ou d'un texte dans une source ne prouve ni l'équivalence sémantique des contrats ni l'accès au backend. Aucun proxy ni appel authentifié n'est prévu.

## Lecture du code officiel complet

- Terminé : récupération intégrale des archives Codex et OpenAPI aux mêmes SHA dans `../../upstream/`, sans modification des sources.
- Terminé : 8 419 blobs Codex vérifiés contre l'arbre Git officiel, zéro écart ; OpenAPI identique au snapshot. Résultats : `../../upstream/source-check.json`.
- Terminé : chemin construction → envoi → transport → parsing suivi dans le code ; proxy brut existant et primitives `RequestBody::Raw` / `StreamResponse` localisés.
- Terminé : différences de représentation des champs Responses documentées, voie actuelle de compaction retrouvée, noms actuels des deux symboles précédemment non localisés identifiés. Voir `SOURCE-READING.md`.

La lecture du code remplace ici les hypothèses d'implémentation par des constats sourcés. La compilation des crates, les tests Rust et la disponibilité backend n'ont pas été vérifiés dans ce lot.
