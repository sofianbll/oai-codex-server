# Atlas — contrôle reproductible

- openai/codex : `132c2be239ecbc1f2a9bb22d9210fefe887986a5`
- openai/openai-openapi : `ddface9bd361f5fe37943291d23ee2ca72cbcc2b`

24/32 sources collectées et empreintes vérifiées ; 1 absente(s), 7 non figée(s).

45 opérations ; 6228 nœuds de schéma uniques ; 2948 déclarations de propriétés. 4 problème(s) de parcours.

Les nombres décrivent des déclarations, pas des fonctionnalités ni un taux de compatibilité. Le parcours conserve les références, compositions et contraintes.

## Contrôle des 366 fiches éditoriales

| Résultat de localisation | Nombre de côtés de fiche |
|---|---:|
| pointer_found | 73 |
| text_candidate | 168 |
| no_mapping_claimed | 237 |
| manual_locator | 208 |
| source_unavailable | 41 |
| pointer_missing | 3 |
| symbol_not_located | 2 |

Un pointeur trouvé prouve son existence. Une occurrence textuelle Codex aide à localiser le code ; elle ne valide pas le symbole, sa sérialisation ou l'équivalence. **0 mapping sémantique revalidé, 0 appel backend.**

Les sources absentes, références à revoir et expériences sont dans [unknowns.json](unknowns.json). Les preuves par fiche sont dans [report.json](report.json).

Régénération hors ligne : `npm run audit`. Les sorties ne contiennent ni date d'exécution ni chemin absolu. Les empreintes des entrées et générateurs sont dans le rapport.
