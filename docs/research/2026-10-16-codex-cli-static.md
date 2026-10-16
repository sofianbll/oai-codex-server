# Codex CLI — identité et limites de l’inspection statique

Observation du 16 octobre 2026 avec REA CLI 6.5.0. Cible sélectionnée par l’utilisateur : la CLI Codex installée. Aucun lancement de Codex, accès aux identifiants ou appel d’inférence.

## Identité observée

- Exécutable `codex`, Mach-O arm64, 249 952 688 octets.
- SHA-256 : `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`.
- L’installation Homebrew est rangée sous `0.163.0`. Cette indication de version vient du chemin d’installation, pas d’un appel à `codex --version` ni d’une attestation de provenance du binaire.
- UUID Mach-O : `67816B08-85F9-3C00-AAA0-C07A2F073094`.

## Evidence REA

| Opération | Evidence | Observation et limites |
|---|---|---|
| `inspect_rust_binary` | `ev_34650dc4cd394125cb9111010339f87ea1765c0227d1260bac49f00113e888dc` | Aucun segment `.dep-v0` trouvé. Cela ne signifie pas absence de dépendances. Un chemin de compilation contient un hash rustc : c’est une inférence, pas une authentification du compilateur. |
| `inspect_macho` | `ev_cc483504ca534c84e1fc9643941e6ccc817854e652a4c1a7b385192d17fa8f32` | Une architecture et un point d’entrée, cinq segments et quinze dépendances dynamiques inventoriés. Les imports/exports peuvent être incomplets, notamment si des symboles ont été supprimés. |

Les deux enregistrements complets sont conservés localement hors du dépôt. Ils portent le même digest de cible. Aucun pseudocode ni graphe d’appels fonctionnel n’a été produit.

## Ce que cette inspection ne prouve pas

L’identité et la disposition du binaire ne démontrent pas la disponibilité des API Images, Audio, Realtime, Conversations ou Chat Completions. Le diagnostic de l’environnement n’a identifié aucun moteur de décompilation native configuré ; aucune installation ni réparation de configuration n’a été effectuée. Les inspections statiques ci-dessus fonctionnent indépendamment de ces moteurs.

La recherche dans les sources de release et les issues officielles est distincte : voir [la frontière de compatibilité](2026-10-16-codex-compatibility-frontier.md). Elle n’établit pas à elle seule l’équivalence exacte entre les sources publiées et cet exécutable, ni les droits actuels du compte.

## Suite autorisée et limites de sécurité

Comparer cette identité avec la CLI éventuellement embarquée dans la distribution Desktop officielle sélectionnée. Les contrats encore inconnus restent inconnus jusqu’à une preuve adéquate ; aucune chaîne de caractères, métadonnée ou fonction d’interface ne vaut réussite d’un appel backend.

Les essais avec une session réelle, les changements de destination des identifiants, l’installation d’un moteur et toute modification du service actif nécessitent un mandat distinct. Cette inspection n’a touché ni la configuration ni la production.
