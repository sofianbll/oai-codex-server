# Codex Contract Atlas

Documentation interactive de recherche et de conception. Objectif : une façade OpenAI-compatible avec le minimum de traduction, en préservant les capacités réellement accessibles du backend et du runtime Codex.

## Reprise : socle reproductible

Le lot de collecte et de contrôle structurel est maintenant disponible. Depuis ce dossier :

```sh
npm test
npm run reproduce
```

La deuxième commande vérifie les SHA-256 des sources locales, produit deux générations hors ligne, compare leurs bytes et publie le résultat dans `research/generated/`. Aucune dépendance npm n'est requise (Node 18+). Le rapport est [research/generated/REPORT.md](research/generated/REPORT.md), les empreintes de reproduction sont dans [research/reproduction-check.json](research/reproduction-check.json).

Le verrou [research/source-lock.json](research/source-lock.json) identifie les deux SHA Git exacts et les empreintes des fichiers collectés. Pour restaurer les sources sur une autre machine, lancer `npm run snapshot` (Python 3.10+, réseau public), puis `npm run reproduce`. Le collecteur retourne actuellement **2** : le fichier historique `codex-rs/codex-api/src/endpoint/compact.rs` n'existe pas à ce SHA. Ce manque est conservé dans le verrou et le rapport ; les 24 fichiers effectivement collectés doivent tous avoir leur empreinte attendue. Les sept sources web sans fichier Git restent non figées. Une autre erreur de collecte ne doit pas être ignorée ; l'audit refusera un fichier manquant ou altéré.

L'inventaire généré parcourt les schémas atteignables depuis les opérations Responses, Models, Images, Audio, Realtime et Live. Il conserve chaque déclaration une fois, avec des liens pour `$ref`, les propriétés et les compositions : les cycles n'imposent plus de développer indéfiniment les mêmes types. Les quatre usages de références/ancres récursives non résolus restent signalés. Il s'agit d'un inventaire structurel, pas d'un validateur ni d'une preuve de compatibilité.

Le contrôle des fiches distingue pointeur trouvé, pointeur absent, occurrence textuelle candidate, localisation manuelle et source indisponible. **Les 366 mappings éditoriaux ne sont pas automatiquement revalidés.** Les limites historiques ci-dessous continuent à s'appliquer à l'interface et au dataset éditorial. Les critères du futur relais sont dans [research/RESPONSES-CORE.md](research/RESPONSES-CORE.md).

## Ouvrir le site

Ouvrir `index.html` dans un navigateur moderne, JavaScript activé. L’interface, les données et le résolveur sont embarqués : aucun compte, serveur, package npm ou clé API n’est nécessaire. Les liens de provenance ouvrent les sources externes.

Pour servir le dossier localement :

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Puis ouvrir `http://127.0.0.1:8080`.

## Ce qui est livré

366 fiches : **46 routes / RPC, 192 paramètres, 48 événements, 22 headers, 38 capacités et 20 outils**, avec 32 références de sources. Ces catégories sont distinctes ; les fiches ne représentent ni 366 fonctionnalités ni une mesure exhaustive de l’API.

L’interface contient : recherche globale (Cmd/Ctrl+K), filtres combinables, pagination, liens directs, contrats public/Codex côte à côte, chaînes d’origine, conditions d’authentification, risques, critères d’acceptation, architecture à deux chemins, feuille de route de 10 lots plus un lot 0, sources, inconnues et exports JSON/CSV.

Le laboratoire importe un OpenAPI JSON local et expose : sélection des opérations ou composants, schéma brut **parsée/reformaté**, schéma résolu, propriétés imbriquées et contexte des variantes, références suivies, cycles, références non résolues, comparaison de versions avec résolution des références et export de la sélection. La fixture intégrée est **pédagogique**, pas une copie du contrat officiel.

Clair / sombre / système ; responsive. Le changement de thème est conservé lorsque le navigateur autorise localStorage, avec repli en mémoire autrement.

## Limites importantes

Cette livraison est un **audit éditorial partiel**, pas l’extraction exhaustive demandée de tous les schémas OpenAI et de tous les sérialiseurs Codex. Les sections majeures et des champs imbriqués sont documentés ; les types, variantes, statuts HTTP et correspondances non résolus sont explicitement marqués. Le document OpenAPI officiel intégral n’est pas embarqué.

Les sources ont été consultées sur `main` ou sur les pages de documentation, sans SHA unifié. Des caches peuvent avoir servi des révisions différentes. Les manifeste d’audit porte donc `revision: null` et `contentSha256: null` au lieu de valeurs inventées.

**Aucun test backend authentifié n’a été effectué.** Un champ présent dans le client, un test mock ou un feature flag ne prouve pas l’accès réel du compte. Les 14 expériences proposées restent `NOT_RUN`. Les tests de cette archive vérifient uniquement l’outil de documentation.

Ce livrable n’est pas un proxy opérationnel. Il décrit comment construire et vérifier la façade. Aucun compte n’a été connecté, aucun token collecté, aucune attestation fabriquée. Un prototype hébergé Lovable a été amorcé, mais sa page d’accueil inspectée restait un placeholder ; la version autonome de cette archive est la livraison utilisable et testée, pas un déploiement public.

Vidéo, Files API et Uploads API génériques sont hors périmètre. Le filesystem du workspace et ses RPC restent dans le périmètre.

## Lire les niveaux de preuve

- `candidate` : correspondance à tester, pas garantie de pass-through intégral.
- `translation` : adaptation à isoler et tester, seulement pour une différence démontrée.
- `runtime` : la fonction implique une exécution hôte ; ne pas l’assimiler à un outil hébergé.
- `codex_only` / `superset` : extension native identifiée, pas nécessairement standard.
- `unknown` : mapping non établi, **pas** conclusion d’absence de fonctionnalité.

`confidence` qualifie la preuve source, jamais le succès d’un appel. Les complexités 1–5 et les lots sont des estimations de cet audit. Les champs `required: null` et `nullable: null` signifient « non établi ». Une case OpenAI vide n’est pas une preuve d’absence de route publique.

## Organisation des fichiers

```text
index.html                    Site autonome, généré
src/app.js                    Interface / navigation / exports
src/style.css                 Tokens visuels / responsive / thèmes
src/schema.js                 Résolution et inventaire structurel

data/mapping.json             Fiches, métadonnées, lots, expériences
data/mapping.csv              Export tabulaire
data/sources.json             Manifeste de l’audit, non figé

scripts/build_data.py          Données éditoriales et références
scripts/build_site.py          Assemblage du HTML autonome
scripts/fetch_snapshot.py      Collecte publique au SHA + hashes bytes
scripts/extract_schema.js      Extraction locale du véritable OpenAPI
scripts/diff_schema.js         Diff structurel de deux JSON

tests/schema.test.js           Tests du résolveur et de l’intégrité
 tests/ui_test.py              Tests d’interface Playwright
 tests/unit-results.txt        Résultats effectivement exécutés
 tests/ui-results.json         Résultats effectivement exécutés
 tests/fixture-*.json          Fixtures pédagogiques et leur extraction
 tests/*.png                   Captures desktop, mobile et sombre
```

## Reproduire le build

Depuis le dossier du projet, Python 3.10+ et Node.js 18+ :

```sh
python3 scripts/build_data.py
node tests/schema.test.js
python3 scripts/build_site.py
```

Modifier les fiches dans `scripts/build_data.py` puis reconstruire. Modifier directement `data/mapping.json` est également possible, mais une nouvelle exécution de `build_data.py` écrasera ces changements : conserver une seule source de vérité pour votre workflow.

## Constituer un snapshot réellement figé

Cette étape nécessite un accès réseau. Le script ne contacte que les sources publiques ; il n’appelle pas le backend Codex.

```sh
# PyYAML n’est requis que si la source upstream est disponible en YAML.
python3 -m pip install PyYAML
python3 scripts/fetch_snapshot.py --out snapshot

# Ou fixer explicitement les deux révisions Git :
python3 scripts/fetch_snapshot.py --out snapshot \
  --codex-ref <SHA_CODEX> --openapi-ref <SHA_OPENAPI>
```

`GITHUB_TOKEN` peut être défini pour éviter une limite de l’API GitHub ; il n’est envoyé qu’à `api.github.com`, jamais au backend OpenAI ni aux URLs de sources brutes. Ne pas le mettre dans les fichiers ou captures.

Le script résout les SHAs réels par dépôt, récupère chaque fichier au SHA, enregistre ses bytes et leur SHA-256, et conserve les échecs dans `snapshot/source-manifest.json`. Un échec provoque un code de sortie 2 ; un manifeste partiel n’est pas un succès intégral. Les pages de documentation non Git ne sont pas figées par ce script.

Le fichier `snapshot/openapi.json` est une représentation normalisée ; son hash est distinct du hash des bytes de la source originale. **La nouvelle collecte ne revalide pas automatiquement les mappings éditoriaux.** Les changements entre les nouvelles sources et l’audit doivent être examinés.

## Extraire l’OpenAPI et comparer des versions

```sh
node scripts/extract_schema.js snapshot/openapi.json \
  --out data/openapi-inventory.json

node scripts/diff_schema.js avant.json apres.json \
  '#/components/schemas/CreateResponse' > diff.json
```

L’extracteur conserve l’opération, le média, le statut de réponse, les paramètres d’URL et les propriétés imbriquées avec la chaîne de références. Par défaut il vise Responses, Models, Images, Audio, Realtime et Live. `--all-routes` inclut les autres routes sauf Files/Uploads/Video. Un plafond `--max-rows` (100 000 par défaut) et des limites de profondeur empêchent les expansions incontrôlées ; une troncature est enregistrée, jamais déclarée exhaustive.

Le résolveur garde `allOf` comme conjonction, ne fait pas de « last-write-wins », conserve `oneOf`/`anyOf` et réunit les contraintes `required` conjuguées. Les lignes représentent des **déclarations par branche**, pas nécessairement des propriétés globalement requises. Les références externes, ancres, `$id`, références dynamiques et certains mots-clés avancés ne sont pas complètement résolus. Il n’est donc **pas un validateur JSON Schema complet**. Utiliser un moteur complet compatible avec le dialecte pour certifier la validation d’instances.

L’inventaire structurel n’établit pas l’équivalence sémantique ni la compatibilité backend. Le diff CLI est brut/structurel ; le diff de l’interface développe les références du pointeur sélectionné pour détecter les changements transitifs.

## Tests effectivement réalisés

`node tests/schema.test.js` : **19 tests réussis** lors de la génération, couvrant références, échappement, intersections, requiredness, variantes, cycles, limites, diff, IDs, sources et liens de lots.

`tests/ui-results.json` : **33 contrôles réussis** avec Chromium, dont 13 vues, les 366 gabarits de fiche, recherche, filtres, navigation, JSON/CSV, import, diff transitif, sombre, mobile et absence de débordement horizontal sur les pages contrôlées.

Le navigateur du conteneur bloquait les navigations réseau et `file://`. Le HTML a donc été chargé par `set_content` ; les interactions et téléchargements ont été exercés localement. Ce test ne certifie ni un déploiement hébergé, ni tous les navigateurs, ni un backend.

Pour relancer les tests UI :

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/ui_test.py
```

`CHROMIUM_PATH` peut désigner un binaire existant. Le runner choisit `/usr/bin/chromium` s’il existe, sinon le binaire Playwright installé.

## Sécurité et conservation du contrat

Le futur relais doit préserver les bodies et événements inconnus, tout en filtrant les secrets et headers hop-by-hop. État opaque, IDs de sessions, routage adhérent et caches doivent rester isolés par compte. Les liens signés, cookies, attestations et tokens ne doivent pas apparaître dans les fixtures ou la télémétrie.

Ne pas transformer la présence d’un champ de catalogue en autorisation. Refuser explicitement les opérations non prises en charge plutôt que fabriquer une réussite ou supprimer silencieusement des paramètres. Ne pas réutiliser les contrôles du runtime pour prétendre que des RPC Codex sont des endpoints OpenAI standards.

## Attribution

Ce projet n’est pas un produit officiel OpenAI ou Stripe. Les sources externes restent soumises à leurs licences respectives ; elles sont liées dans les fiches. Aucune police propriétaire ni dépendance distante n’est embarquée.
