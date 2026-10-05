# Cache Codex : mécanisme officiel vérifié

Version officielle courante analysée : `b05b3e180b858054f10d242e564fc4707b409e8c` (2026-09-20).

## Différence avec une simple lecture de la documentation publique

Le code du client Codex indique explicitement que ChatGPT dérive l'affinité du cache depuis l'en-tête Responses `session-id`. Pour une session racine, sa valeur suit la clé de cache ; l'identité réelle du thread reste portée séparément dans les métadonnées.

- [Dérivation de la clé et de l'en-tête de session](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/src/client.rs#L561-L582).
- [Champ JSON prompt_cache_key](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/src/client.rs#L959-L981).
- [En-têtes exacts session-id/thread-id](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/codex-api/src/requests/headers.rs#L5-L14).
- [Options communes HTTP/WS](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/src/client.rs#L1343-L1376).
- [Test du fork éphémère : même routage de cache et identité de session distincte](https://github.com/openai/codex/blob/b05b3e180b858054f10d242e564fc4707b409e8c/codex-rs/core/tests/suite/prompt_cache_key.rs#L163-L220).

Le transport fournit également les identités et métadonnées du client. Ce rapport n'en déduit pas qu'il faut recopier tous les en-têtes : seule une comparaison contrôlée peut établir lesquels corrigent notre cas. Aucune attestation ni identité artificielle n'est proposée.

## Hypothèse locale à distinguer

Notre adaptateur conserve la clé JSON. Un SDK OpenAI standard ne construit pas les en-têtes spécifiques Codex à sa place. Si `session-id` n'est ni fourni ni dérivé par le proxy, les demandes peuvent ne pas retrouver l'affinité de cache recherchée malgré la clé stable dans le corps.

La correspondance source + implémentation concurrente justifie un test A/B, mais ne garantit pas un cache hit. Il faut conserver les véritables compteurs amont et mesurer un préfixe suffisamment long.
