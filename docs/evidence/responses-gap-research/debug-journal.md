# Debug Journal — Codex prompt cache
Started: 2026-09-20
Goal: inspect our implementation, compare Codex-specific mechanisms in other repositories, reproduce the cause, apply and verify a minimal clean solution.

## Environment snapshot
- Runtime: Bun 1.4.2 / TypeScript; Node v22.23.1 orchestration; Python3 OpenAI SDK probes.
- Entry: src/cli/main.ts serve via bin/oai-codex.
- Existing service: 127.0.0.1:8788; actual process/config/upstream identity under read-only audit by gap_local. Must not stop or reconfigure it.
- Working tree was already dirty before cache work; preserve all prior edits.
- References read: debugging index, runtimes/node, methodology/00-setup, 02-investigate, 06-fix, partial-runtime-evidence. Workers load relevant runtime/programming references for any new script.

## Hypotheses
1. OPEN: Missing or unstable Codex session/cache routing headers despite a stable body key. Distinguishing evidence: compare actual outgoing body/headers with pinned official/competitor code, then controlled same-prefix A/B. Candidate fix: identity mapping.
2. OPEN: Observability/probe error or stale/wrong service. Distinguishing evidence: actual runtime fingerprint, source upstream usage field presence and values versus presented report, local recording fixture. Candidate fix: faithful measurement.
3. OPEN: Cache eligibility or backend transport/policy differs for OAuth/Codex. Distinguishing evidence: eligible measured input tokens, stable prefix/options/account, HTTP versus WS with official settings, cache read/write counters and response header state. Candidate fix: supported transport.

## Failed hypothesis round counter
- Cache-specific round1 gathering local and competitor evidence. Earlier zeros were observations with incomplete preconditions, not a cause.

## Artifacts to revert / retain
- Root-owned /private/tmp/responses-gap-official/*.rs and /private/tmp/responses-gap-cpa/*.go are read-only source downloads; retain hashes then remove after active reviewers finish.
- Native diagnostic runner: worker gap_native_probes records exact own temp paths before creation and removes them when done.
- No debugger injection, product edit, runtime reconfiguration or permanent cache storage introduced yet.
- Durable evidence and plan: docs/evidence/responses-gap-research/cache-*.md/json.
- This journal: copy to evidence when complete, then remove root temp journal.

## Findings
- Prior short cache requests each reported20 inputtokens, cached_tokens0; inadequate eligible-prefix test.
- Prior follow-up used identical1800wordprefix/key, reportedcached_tokens0/0, but did not retain input_tokens. Runtime identity still needs verification.
- Official currentCodex client.rs561-582 derives cache key and route sessionidentity together. Exact wireheader spellings and competitor adaptations under investigation.

### Cache round1 source findings
- Officialclient current SHA b05b3e... client.rs574: cacheaffinity derivesfrom `session-id`; root responses_session_idreturns prompt_cache_key.
- Current requestheaders emits exacthyphen `session-id` and `thread-id`, confirmed atsameSHA.
- A reports currentCLIProxyAPI61fdfc mirrors body prompt_cache_key into Session-Id too; source citation memo pending.
- D prepares6callmax controlled A/B only after Cconfirmsruntimeupstream. No productedit yet.

### Runtime et A/B confirmés
- PID45253, source Bun, config authentifiée du runtime : minimal, https://chatgpt.com/backend-api/codex, gpt-6-astra ; les modules pertinents précèdent le démarrage. Pas de redémarrage de8788.
- Quatre appels byte-identiques : A sans session-id input1822/cached0 puis0 ; B avec session-id=clé input1822/cached0 puis1664. Pas de troisième condition A (clé mémoire perdue à la fin du processus).
- H1 étayée par les sources et compatible avec le A/B : mapping d’affinité manquant. Le A/B ne prouve pas une causalité exclusive face au warm-up/timing. H2 également confirmée sur le banc : 20tokens et seultexte exact ne prouvent pas le cache.
- Correction déléguée : C gateway et fixture cache dédiée ; B scénario Python permanent et fixture ; D QA native sur runtime frais après correction. Aucun autre en-tête ou stockage ajouté.

### Ownership et politique finale
- Root ajoute la documentation de compatibilité dans README.md et la synthèse CACHE.md ; ne modifie pas les autres changements antérieurs.
- Dérivation seulement pour une chaîne ASCII imprimable, non vide, inchangée par trim. Pas de limite512 arbitraire, de coercition ou de rejet nouveau ; les valeurs non représentables restent dans le corps sans en-tête dérivé.
- E réutilisé pour revue finale indépendante liée aux empreintes des fichiers sales ; le PASS de recherche initial ne couvre pas ce correctif.

### Correction et vérification finales
- Gateway : régression rouge (11pass/1fail attendu), puis13fixtures vertes avec route nonResponses ajoutée ; mappingexactminimal et clés invalides conservées.
- Banc : fauxpositif 0cached reproduit, puis13fixtures vertes ycompris compteurs absents/nuls/malformés et cached>input. Basedpyright0erreur/0warning.
- Root SDK2appels : input2893, cached0puis2688, HTTP200JSON et CACHE_OK. Aucun session-id manuel. Health200/JSONinvalide400.
- Après renforcement du prédicat numérique, root a réévalué les captures natives : [false,true], aucun nouvel appel réseau.
- Suiteglobale187pass/0fail, check/build0 ; lint initialement une erreur de format dans le nouveau test, corrigée puis lint0. Les infos préexistantes restent.
- D a arrêté uniquement son serveur62101 et supprimé sa clé/config/capturesbrutes ; le serveur8788/PID45253 reste actif et charge toujours les modules pré-correction.

### Clôture
- Revue finale CACHE PASS avec huit empreintes de fichiers recomputées indépendamment.
- Les neuf téléchargements de sources dans /private/tmp/responses-gap-official et /private/tmp/responses-gap-cpa ont été supprimés après conservation des empreintes.
- Les cinq membres V2 sont terminés ; état durable de l’équipe archivé et copié dans team-archive, puis état actif supprimé. Aucune opération d’archive runtime V2 n’existe.
- Journal copié dans les preuves, puis supprimé de la racine. Plan entièrement réconcilié.
