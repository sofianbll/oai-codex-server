# Onboarding et expérience — propositions

Audit en lecture seule, 20/09/2026. Aucun fichier du projet ni du dashboard n'a été modifié.
Preuves utilisées : `src/ui/*`, `artifacts/qa/ui-live/evidence.json` (13 scénarios rejoués le 19/09), captures `artifacts/qa/ui-live/*.png`, `README.md`, `DESIGN.md`.

Constat de départ : le produit est **abouti pour quelqu'un qui l'a construit**, et **opaque pour quelqu'un qui le découvre**. Les cinq pages fonctionnent, la QA visuelle est passée, mais le premier lancement n'est guidé nulle part.

---

## 1. Le parcours de premier lancement aujourd'hui

| Étape | Ce que la personne doit faire | Où elle décroche |
| --- | --- | --- |
| 1 | Installer Bun **et** pnpm, puis `pnpm install --frozen-lockfile`, `bun run build` | Deux gestionnaires de paquets pour un projet Bun. Rien n'explique pourquoi pnpm est nécessaire. |
| 2 | Avoir une session Codex : `codex login` | Le prérequis est cité en une ligne. Aucun diagnostic si c'est absent : le serveur démarre quand même, et l'échec n'apparaît qu'au premier appel. |
| 3 | `./oai-codex init --host tailscale --port 8788` | `init` refuse d'écraser une configuration existante, ce qui est sain, mais le message ne dit pas quoi faire ensuite. |
| 4 | `./oai-codex serve` **ou** `start` | La différence entre les deux (premier plan / détaché) n'est visible que dans le README. |
| 5 | `./oai-codex token`, puis **recopier la valeur** | 🔴 **Point de rupture principal.** L'écran de connexion demande « Jeton du serveur » et précise qu'il est distinct de la session Codex (`src/ui/auth.ts:29,44`) — mais **il n'indique jamais la commande qui le produit**. Il faut déjà savoir que `./oai-codex token` existe. |
| 6 | Coller le jeton, tester dans le playground | Le jeton est conservé en `sessionStorage` : il faut le recoller à chaque nouvel onglet. |

Ce n'est pas un défaut de finition, c'est un défaut de **chemin** : les briques existent, le trajet n'est pas tracé.

---

## 2. Surfaces existantes

| Surface | Source | Fonction |
| --- | --- | --- |
| Connexion | `src/ui/auth.ts` | Saisie du jeton local, message de distinction avec la session Codex |
| Playground Responses | `src/ui/playground.ts`, `body-editor.ts`, `output.ts` | Requête modèle, JSON / texte, multipart, SSE, annulation |
| Explorateur de routes | `src/ui/explorer.ts` | 39 opérations, niveaux de preuve, exemples, WebSocket |
| Journal des requêtes | `src/ui/pages.ts:20-86` | Table méthode / état / HTTP / durée / taille / heure |
| Configuration | `src/ui/pages.ts:88-166` | Vue du serveur actif + éditeur JSON avec « Enregistrer » |
| Documentation | `src/ui/pages.ts:168-196`, `/docs` | Scalar local + URL de base et exemple curl |
| Vitrine de composants | `src/ui/showcase.ts`, `#showcase` | Revue visuelle des primitives |

Navigation réelle (`src/ui/shell.ts:10-32`) : `#playground`, `#explorer`, `#activity`, `#configuration`, `#documentation`. **Aucune page « démarrer » ni « état de santé ».**

---

## 3. Propositions priorisées

Chaque proposition part d'un problème observé, jamais d'une envie de fonctionnalité.

### P1 — Dire comment obtenir le jeton, sur l'écran de connexion 🟢

| | |
| --- | --- |
| **Problème** | L'écran demande le jeton sans dire d'où il vient (`src/ui/auth.ts:19-29`). C'est le seul blocage dur du parcours. |
| **Changement proposé** | Une ligne sous le champ : la commande exacte à exécuter dans le dossier du projet, et la distinction entre la clé du proxy et la session Codex (déjà écrite, à rendre actionnable). |
| **Effort** | S |
| **Bénéfice** | Supprime l'unique impasse du premier lancement. |

### P2 — Un diagnostic de démarrage avant le premier appel 🟢

| | |
| --- | --- |
| **Problème** | Si la session Codex est absente ou expirée, rien ne le dit avant le premier appel, qui échoue avec une erreur d'API. |
| **Changement proposé** | Afficher l'état déjà disponible dans `/api/status` (`auth.available`, `auth.expiresAt`) de façon lisible dès la connexion, avec la marche à suivre si la session est indisponible ou expirée. |
| **Effort** | S |
| **Bénéfice** | Transforme un échec d'appel incompréhensible en instruction claire. Aucune nouvelle donnée n'est nécessaire : elle existe et n'est pas exploitée. |

### P3 — Rendre les erreurs amont lisibles 🟠

| | |
| --- | --- |
| **Problème observé (preuve)** | Le `429` de l'abonnement arrive avec `plan_type` et `resets_in_seconds` (`evidence.json`, scénario « playground live request ») et est affiché en JSON brut. Le `403` de `/v1/audio/transcriptions` arrive en **`text/html`** : le playground affiche alors une page HTML entière de l'amont. |
| **Changement proposé** | Reconnaître les cas connus — limite d'usage atteinte, session expirée, route refusée par l'abonnement — et afficher une phrase en français **avec la donnée utile** (par exemple l'heure de réinitialisation calculée depuis `resets_at`), en laissant le JSON brut accessible dans un repli. |
| **Effort** | M |
| **Bénéfice** | C'est la différence entre « le proxy est cassé » et « mon quota est épuisé jusqu'à telle heure ». Vécu aujourd'hui même : le quota est épuisé jusqu'au 24/09 à 12h52. |

### P4 — Ne pas laisser une configuration enregistrée sans suite 🟠

| | |
| --- | --- |
| **Problème** | « Enregistrer » répond qu'un redémarrage est nécessaire (`src/ui/pages.ts:151-153`), mais aucun redémarrage n'est possible depuis l'interface. Le seul contrôle serveur exposé est `POST /api/server/stop` : après lui, le dashboard est inaccessible et il faut passer par le terminal. |
| **Changement proposé** | Soit indiquer explicitement la commande de redémarrage à côté du message, soit ne pas exposer l'arrêt dans l'interface tant qu'il n'existe aucun moyen de la relancer depuis elle. La seconde option est la plus simple et la plus honnête. |
| **Effort** | S |
| **Bénéfice** | Évite un état où l'interface s'arrête elle-même sans retour possible. |

### P5 — Un premier écran qui dit ce que le serveur fait 🟡

| | |
| --- | --- |
| **Problème** | On arrive directement dans un playground dense. Rien ne dit ce qui est branché : quel abonnement, quel point de terminaison fixe, quelles routes sont réellement vérifiées. |
| **Changement proposé** | Remplacer le point d'entrée par un état des lieux court : serveur actif ou non, session Codex disponible ou non, modèle par défaut, nombre de routes relayables et niveau de preuve. Un seul écran, sans ajouter de page au menu. |
| **Effort** | M |
| **Bénéfice** | Le niveau de preuve est le vrai sujet du produit ; le rendre visible dès l'entrée évite de faire croire que 39 routes fonctionnent. |
| **Réserve** | À ne faire que si P1 et P2 sont traités : sinon on ajoute de l'information sans avoir résolu le blocage. |

### P6 — Reprendre le jeton sans le recopier 🟡

| | |
| --- | --- |
| **Problème** | Le jeton vit en `sessionStorage` : chaque nouvel onglet redemande une recopie manuelle. |
| **Changement proposé** | À évaluer seulement après P1–P3 : le sujet touche au stockage d'un secret dans le navigateur, où la sobriété actuelle est un choix défendable. |
| **Effort** | M |
| **Bénéfice** | Confort. |
| **Réserve** | Ne pas dégrader la posture de sécurité actuelle pour un gain de confort. À traiter en dernier, voire jamais. |

---

## 4. Ce qui est déjà bon et ne doit pas être cassé

- **Le journal ne contient aucun message ni secret** : seulement méthode, chemin sans query, statut, durée, taille (`activity.ts`, confirmé par `/api/activity`).
- **La distinction des jetons est écrite noir sur blanc** (`auth.ts:44`, `pages.ts:127`, `openapi.ts:141`) : c'est rare et précieux, il faut la garder à chaque évolution.
- **Les erreurs amont ne sont jamais transformées en faux succès** : le `429` arrive au client tel quel. À préserver : P3 doit ajouter une lecture, **jamais** masquer le corps d'origine.
- **Les niveaux de preuve sont affichés** (`vérifié`, `présent dans le code Codex`, `à vérifier`) au lieu d'être promis. C'est la meilleure décision produit du projet.
- **Le catalogue est explicitement séparé de la disponibilité réelle** (`catalog.ts:44-46`).
- **Accessibilité** : état jamais porté par la couleur seule, `aria-current` sur la navigation, `role=alert` pour les erreurs, cibles 44 px, `prefers-reduced-motion` respecté.

---

## 5. À écarter explicitement

1. **Thème clair / sélecteur de thème** — un seul thème sombre est un choix assumé (`DESIGN.md:22`) et cohérent ; cela n'aiderait pas le premier lancement.
2. **Multi-utilisateur, comptes, partage de clés** — hors du périmètre du produit et en conflit direct avec la question de conformité : le serveur est mono-utilisateur par conception, et c'est ce qui le protège.
3. **Assistant de configuration multi-étapes** — le vrai manque est une phrase sur l'écran de connexion (P1) et une lecture d'état (P2), pas un assistant. Un assistant serait une fonctionnalité spéculative pour un problème qui se règle en deux lignes.

---

## 6. Ordre proposé

`P1` → `P2` → `P4` → `P3` → (`P5`) → (`P6`)

Les trois premiers sont petits, sans nouvelle dépendance, et suppriment les trois seules impasses réelles du parcours. `P3` améliore le vécu en cas d'incident. `P5` et `P6` sont optionnels et peuvent ne jamais être faits.

**Aucune de ces propositions n'est appliquée.** Elles sont soumises à validation, et aucune ne nécessite de toucher au relais ni aux invariants de sécurité.
