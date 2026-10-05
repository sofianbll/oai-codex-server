# Préparation open source — état et bloquants

Audit en lecture seule, 20/09/2026. Aucun fichier du projet n'a été créé, modifié ou supprimé par cet audit.
Méthode : commandes de lecture (`git`, `du`, `find`, `grep`, `python3`) et lecture des fichiers de métadonnées. Chaque constat est vérifiable.

---

## 1. Verdict

Le projet est **techniquement prêt à être publié** (code lisible, tests verts, invariants tenus, aucun secret dans l'arbre) et **administrativement pas prêt du tout** : pas de dépôt git à la racine, pas de licence, métadonnées incomplètes, un dossier `upstream/` de 108 Mo (8431 fichiers) qui n'a rien à faire dans un dépôt public, et une question de conformité ouverte qui conditionne la décision elle-même.

Publier aujourd'hui serait une erreur de séquence. Les étapes sont listées en §7.

---

## 2. État git réel

| Constat | Preuve |
| --- | --- |
| **Aucun dépôt git à la racine du projet** | `find . -maxdepth 3 -name .git` → seul résultat : `./compatibility-tests/.git` |
| `compatibility-tests/` est un dépôt git imbriqué | 1 seul commit : `babbb0d test: verify official Responses proxy with OpenAI Node SDK` |
| Ce dépôt imbriqué n'a **aucun remote** configuré | `git -C compatibility-tests remote -v` → sortie vide |
| `codex-contract-atlas/` possède un `.gitignore` mais **n'est pas** un dépôt (`ls -a` : pas de `.git`) | `ls -a codex-contract-atlas` |
| Aucun dépôt GitHub existant pour ce projet | Filtre sur les 49 dépôts du compte `Sofian-bll` : aucun nom ne correspond à `codex` ou `oai` |

Conséquence : **rien n'est versionné**, donc rien n'est protégé. Une suppression accidentelle de `src/` serait définitive. C'est le risque le plus concret de tout cet audit, avant même la publication.

---

## 3. Ce qu'un dépôt public doit contenir et qui manque

| Fichier | Présent ? |
| --- | --- |
| `LICENSE` | ❌ **absent** |
| `CONTRIBUTING.md` | ❌ absent |
| `CODE_OF_CONDUCT.md` | ❌ absent |
| `SECURITY.md` | ❌ absent |
| `CHANGELOG.md` | ❌ absent |
| `.editorconfig` | ❌ absent |
| CI (`.github/workflows/`) | ❌ absent |
| Modèles d'issues / pull requests | ❌ absents |
| `README.md` | ✅ présent, 114 lignes, en français |
| `DESIGN.md` | ✅ présent, 92 lignes (journal de design system) |
| `docs/` | ✅ présent (recherche de design + captures) |
| `.gitignore` | ⚠️ présent mais incomplet (voir §6) |

`bun run lint`, `bun run check`, `bun run test` existent déjà : la matière d'une CI est là, seule la configuration manque.

---

## 4. Métadonnées de publication

### 4.1 `package.json` (projet principal)

| Champ | Valeur | Problème |
| --- | --- | --- |
| `name` | `oai-codex-server` | Reprend « oai » et « codex » (voir conformité) |
| `version` | `0.1.0` | — |
| `description` | `Configurable Codex gateway, API reference and testing dashboard` | En anglais, alors que le README est en français : choisir une langue |
| `license` | **absent** | 🔴 **Bloquant** : sans licence, personne ne peut légalement réutiliser ni contribuer. Par défaut, tous droits réservés. |
| `private` | **`true`** | 🔴 **Bloquant** : empêche `npm publish`, mais ne bloque pas un dépôt public. À retirer ou à assumer explicitement. |
| `repository` | absent | À définir |
| `author` | absent | À définir |
| `files` | absent | À définir si publication sur un registre |
| `engines` | `bun: >=1.3.0` | ✅ présent |
| `packageManager` | absent | Recommandé : le README demande **deux** gestionnaires (pnpm pour l'installation, Bun pour l'exécution). C'est une friction de premier contact à trancher. |

### 4.2 `codex-contract-atlas/package.json`

`private: true`, `license` absent, scripts cohérents (`test`, `audit`, `reproduce`, `snapshot`, `build`, `data`). Même travail de métadonnées à faire s'il est publié, ou à exclure s'il reste un artefact interne.

---

## 5. Licences — le point délicat

### 5.1 Le projet n'a aucune licence

Aucun `LICENSE`, `COPYING` ni `NOTICE` à la racine. Tant que c'est le cas, le code est **« tous droits réservés »** par défaut, même publié.

### 5.2 `upstream/` contient 108 Mo de sources tierces (8431 fichiers)

| Élément | Constat |
| --- | --- |
| `upstream/codex-132c2be.../LICENSE` | **Apache License 2.0** |
| `upstream/codex-132c2be.../NOTICE` | `OpenAI Codex / Copyright 2025 OpenAI` + mention d'un composant dérivé de **Ratatui (MIT)** |
| `upstream/openai-openapi-ddface9b.../LICENSE` | présent |
| `upstream/openai-openapi-.../openapi.json` | déclare dans son `info` : `license: {name: "MIT", identifier: "MIT"}` |
| Taille | 108 Mo, 8431 fichiers — pour comparaison, tout le code réel du projet (`src/` + `tests/` + `scripts/`) pèse **356 Ko** |

Analyse :

- Apache-2.0 et MIT **autorisent la redistribution** à condition de conserver licence et mentions. Publier `upstream/` n'est donc pas illégal en soi.
- **Mais** c'est inutile et contre-productif : 108 Mo de code OpenAI recopié dans un dépôt public donne l'impression d'un fork, brouille la licence du projet, et alourdit chaque clone. La bonne pratique est de **référencer les commits** (`132c2be239ecbc1f2a9bb22d9210fefe887986a5` et `ddface9bd361f5fe37943291d23ee2ca72cbcc2b`, déjà figés dans les noms de dossiers) et de fournir le script qui les récupère.
- **Question ouverte à trancher** : le code du projet **dérive-t-il** du code de `upstream/` ? Vérification faite par recherche d'imports : **`src/` n'importe rien de `upstream/`**, ni à l'exécution ni dans les tests — le dossier est une référence figée, jamais chargée. Cela ne prouve pas l'absence de code adapté, mais écarte la dépendance de build ; le contrôle manuel avant choix de licence reste recommandé.
- ⚠️ **Dépendance réelle à traiter séparément** : `src/server/catalog.ts:28` lit `codex-contract-atlas/snapshot/openapi.json` **au démarrage du serveur**. Le sous-projet n'est donc pas optionnel : sans son snapshot (8,9 Mo), le serveur ne démarre pas. Toute décision de publication doit le prendre en compte (le committer, ou le générer à l'installation via le script `snapshot` existant).

### 5.3 Compatibilité des licences à choisir

Si le projet est publié seul (sans `upstream/`, sans dérivation), un **MIT** ou **Apache-2.0** convient. Si une partie dérive de Codex (Apache-2.0), publier sous Apache-2.0 est le chemin le plus simple : elle couvre déjà l'attribution et les brevets. Aucune décision n'est prise ici.

---

## 6. Hygiène des secrets et des données identifiantes

### 6.1 Secrets — état sain

| Vérification | Résultat |
| --- | --- |
| Recherche de motifs `sk-…`, `eyJ…`, clés privées dans l'arbre (hors `node_modules`, `upstream`, `.local`, `dist`) | ✅ **aucun secret réel** — seuls deux fragments de faux jeton dans des journaux de tests |
| `.local/server-token` | ✅ `0600`, dossier `0700`, ignoré par git |
| `oai-codex.config.json` (contient le chemin de `CODEX_HOME`) | ✅ ignoré par git |
| `artifacts/qa/live-proxy.json` | ✅ contient uniquement statuts, durées et marqueurs (`PROXY_JSON_OK`, `PROXY_SSE_OK`) — **aucun prompt, aucune réponse** |
| Identifiants Codex (`auth.json`) | ✅ hors du dépôt |

### 6.2 `.gitignore` actuel et ses trous

Contenu réel :

```text
node_modules/
dist/
.local/
oai-codex.config.json
*.tsbuildinfo
artifacts/qa/raw/
```

| Chemin | Taille | Couvert ? | Risque si committé |
| --- | --- | --- | --- |
| `upstream/` | 108 Mo / 8431 fichiers | ❌ **non** | Vérifié : `git check-ignore` ne le couvre pas — 8618 fichiers seraient ajoutés (dont 8431 sous `upstream/`) |
| `compatibility-tests/.build/` | 369 Mo | ✅ oui | Couvert par `compatibility-tests/.gitignore:2` (vérifié) |
| `compatibility-tests/node_modules/` | 28 Mo | ✅ oui | Couvert par `compatibility-tests/.gitignore:1` — un motif `node_modules/` sans barre initiale s'applique à toute profondeur |
| `compatibility-tests/.git/` | 256 Ko | ⚠️ à traiter | git veut l'ajouter comme **dépôt embarqué** (`warning: adding embedded git repository`) |
| `codex-contract-atlas/snapshot/` | 8,9 Mo | ✅ oui | Couvert par `codex-contract-atlas/.gitignore:3` — **mais** c'est une dépendance d'exécution : voir §5.2 |
| `artifacts/` (sauf `qa/raw`) | 3,5 Mo, 66 fichiers | ❌ **partiel** | Seul `artifacts/qa/raw/` est ignoré : les rapports et les JSON de preuve seraient ajoutés |
| `.omo/`, `.codegraph/` | état local d'outils | ❌ non | Ni du code ni de la documentation : à ignorer |
| `docs/design-research/` (images) | 1,4 Mo | ❌ non | À décider |

Le motif `artifacts/qa/raw/` seul est manifestement incomplet : `artifacts/qa/` contient 66 fichiers, dont les rapports d'audit et les JSON de preuve.

Méthode de vérification : `git check-ignore -v <chemin>` pour chaque entrée, puis `git add -A --dry-run`. Les motifs imbriqués (`compatibility-tests/.gitignore`, `codex-contract-atlas/.gitignore`) comptent : l'inspection du seul `.gitignore` racine donne une réponse fausse.

### 6.3 Données identifiantes présentes dans des fichiers destinés à la publication

L'adresse Tailscale réelle de la machine apparaît dans **9 fichiers**, dont ceux qui seraient publiés :

- `README.md` (adresse du dashboard, de Scalar, de l'OpenAPI — lignes 32, 75, 94)
- `tests/access.test.ts:30-34` (utilisée dans des URLs de test)
- `scripts/qa-visual.ts`
- `artifacts/qa/` : `lifecycle.txt`, `lint-final.txt`, `manual-scenarios.md`, `live-proxy.json`, `ui/capture-manifest.json`, `ui-live/evidence.json`

S'y ajoute le chemin personnel `~/.codex` dans le README (§Configuration).

Ce sont des identifiants de réseau interne, pas des secrets — mais ils exposent la topologie de la machine et n'ont aucune valeur pour un lecteur externe. À remplacer par une variable ou une valeur d'exemple.

---

## 7. Étapes minimales, dans l'ordre

Aucune n'a été exécutée.

1. **Trancher la question de conformité** (`01-openai-compliance.md`) : elle détermine *ce qui* peut être publié. Rien d'autre n'a de sens avant.
2. **Trancher la dérivation** : vérifier si `src/` contient du code adapté de `upstream/`, pour choisir la licence en conséquence.
3. ~~**Mettre sous git localement, maintenant, sans publication**~~ — **fait le 20/09/2026**, commit `6cb812b` : 192 fichiers, aucun remote, aucun secret dans l'index. L'absence de versionnage était le risque immédiat le plus concret, indépendant de l'open source.
   - `.gitignore` complété : `upstream/`, `compatibility-tests/`, `.omo/`, `.codegraph/`, `.DS_Store` (en plus des motifs existants) ;
   - vérifié : `git check-ignore -v` sur chaque chemin à risque, puis `git add -A --dry-run`, puis contrôle de l'index avant commit ;
   - reste ouvert : le snapshot du Contract Atlas est ignoré par le `.gitignore` du sous-projet alors qu'il est **nécessaire au démarrage** du serveur — un clone doit le régénérer (`npm run snapshot` dans `codex-contract-atlas/`). À documenter dans le README.
4. **Nettoyer les références à la machine** : adresse Tailscale, chemin `~/.codex`.
5. **Choisir un nom** (voir conformité §5.3) et **choisir une licence** (probablement Apache-2.0).
6. **Compléter les métadonnées** : `license`, `repository`, `author`, `private: false`, décision sur `files` et sur le double gestionnaire de paquets.
7. **Ajouter les fichiers de communauté** : `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `.editorconfig`, modèles d'issues.
8. **Ajouter la CI** : `check` + `test` + `lint` sur push (les trois commandes existent déjà et passent).
9. **Décider du sort des sous-projets** : `upstream/` (référencé par commit, non committé), `codex-contract-atlas/` (publié ou interne), `compatibility-tests/` (submodule, dossier simple, ou suppression du `.git` imbriqué).
10. **Publication** : création du dépôt distant **sur accord explicite**, premier push, et seulement ensuite la vitrine.

---

## 8. Tableau récapitulatif

| Élément | État | Action nécessaire | Bloquant pour publier |
| --- | --- | --- | --- |
| Dépôt git racine | 🟢 **créé** | — (commit `6cb812b`, aucun remote) | Non |
| Conformité OpenAI | 🔴 question ouverte | Décision de périmètre — **tranchée le 20/09 : rester privé** | Non |
| Licence du projet | 🔴 absente | Choisir après vérification de dérivation | Oui (si publication) |
| `package.json` | 🟠 incomplet | `license`, `repository`, `author`, `private` | Oui (si publication) |
| `.gitignore` | 🟢 **complété** | `upstream/`, `compatibility-tests/`, `.omo/`, `.codegraph/`, `.DS_Store` | Non |
| `upstream/` (108 Mo) | 🟢 **ignoré** | — (récupérable via le script `snapshot`) | Non |
| `compatibility-tests/.build/` (369 Mo) | 🟢 déjà ignoré | — (par son propre `.gitignore`) | Non |
| Fichiers de communauté | 🔴 absents | Créer | Non (mais attendu) |
| CI | 🔴 absente | Configurer sur commandes existantes | Non |
| Secrets dans l'arbre | 🟢 aucun | — | Non |
| Données identifiantes | 🟠 9 fichiers | Remplacer IP et chemin | Oui (avant publication publique) |
| Tests et vérifications | 🟢 verts | — | Non |
| Qualité du code (types, lint) | 🟢 propres | — | Non |
| Documentation d'architecture | 🟢 créée par cet audit | À relire puis intégrer | Non |

---

## 9. Addendum — incident trouvé et corrigé le 20/09/2026

Le premier commit a suivi **192** fichiers, dont **`.codegraph`** : un **lien symbolique** vers `~/.omo/codegraph/projects/oai-codex-server-d6d4e37073213783`. Il est passé malgré la règle `.codegraph/` que je venais d'ajouter, parce qu'**un motif terminé par `/` ne correspond qu'à un dossier** — jamais à un lien symbolique ni à un fichier.

Correction appliquée : motif remplacé par `.codegraph`, retrait du suivi (`git rm --cached .codegraph`), commit amendé → **`0ac86b0`**, **191 fichiers**, plus aucun lien symbolique suivi (`git ls-files -s` : aucune entrée en mode `120000`).

Deux leçons réutilisables :

1. Après tout ajout de motif, vérifier avec `git check-ignore -v <chemin réel>`. Une règle écrite n'est pas une règle effective.
2. Avant de déclarer un dépôt propre, chercher les liens symboliques : `git ls-files -s | awk '$1=="120000"{print $4}'`. Ils échappent aux motifs avec barre finale et pointent souvent hors du projet.
