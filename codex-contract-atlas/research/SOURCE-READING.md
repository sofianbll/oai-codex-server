# Lecture directe du code Responses

Périmètre : code officiel Codex `132c2be239ecbc1f2a9bb22d9210fefe887986a5` et OpenAPI `ddface9bd361f5fe37943291d23ee2ca72cbcc2b`, récupérés intégralement dans `../../upstream/`. Les constats ci-dessous sont issus des sources lues ; aucun résultat backend n'est déduit.

## Ce qu'on peut reprendre

Un proxy existe déjà dans [`responses-api-proxy/src/lib.rs`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/responses-api-proxy/src/lib.rs#L163). Il accepte `POST /v1/responses`, lit le body en bytes, remplace Authorization/Host, transmet le body à l'upstream configuré, puis restitue statut, headers sélectionnés et flux de réponse. C'est une base concrète de transport à examiner.

Il ne constitue pas à lui seul la gateway souhaitée : sa clé Bearer est fixe, il n'orchestre pas le renouvellement OAuth, le routage multi-compte ni le runtime Codex, et il ne couvre qu'une route exacte. Il charge le body de requête en mémoire ; son filtrage des headers entrants se limite explicitement à Authorization/Host. Ces limites restent à traiter avant réutilisation.

Une couche plus basse existe aussi : [`RequestBody::Raw`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/http-client/src/request.rs#L49), `Request::with_raw_body`, et [`StreamResponse`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/http-client/src/transport.rs#L25) donnent accès aux bytes, au statut et aux headers sans passer par le modèle d'événements Codex. La réutilisation de ces crates demande encore un choix d'intégration et des tests ; leur existence est confirmée.

## Différences observées, pas supposées

| Sujet | Contrat public figé | Code Codex figé | Conséquence pour la façade |
|---|---|---|---|
| Champs racine | 31 noms distincts dans `CreateResponse`, en suivant `$ref` et `allOf` | 16 champs dans `ResponsesApiRequest`, dont 14 noms communs | Le type Rust ne représente pas tout le contrat public. Ce comptage ne mesure pas une compatibilité. |
| `input` | `InputParam` accepte une chaîne ou un tableau | `Vec<ResponseItem>` | Une chaîne publique ne passe pas directement dans ce type. |
| `tool_choice` | `ToolChoiceParam` admet des modes et plusieurs formes objets | Type `String` ; le builder du runtime choisit `"auto"` | L'objet de sélection d'un outil précis est hors du type ; le builder impose son choix. |
| `store`, `stream` | Booléens ou null ; défauts respectifs true et false dans le schéma | Le builder écrit `store: false`, `stream: true` | Reprendre le builder changerait la demande du client. L'accès backend aux autres modes reste à tester. |
| `instructions` | Chaîne ou null | `String`, omise à la sérialisation si vide | Null, vide et omission ne sont pas représentés de la même manière. |
| `previous_response_id` | Champ public de `ResponseProperties` | Absent du type HTTP ; présent sur `ResponseCreateWsRequest` | Distinguer HTTP, WebSocket et comportement backend au lieu de les fusionner. |
| `text.format` | Variants text, json_schema et json_object | `TextFormatType` ne contient que `JsonSchema` | Le type Codex est plus étroit que le contrat public. |
| `tools` | Union de définitions d'outils | `ResponsesApiTools(Arc<RawValue>)` | Les définitions ont déjà une représentation JSON brute réutilisable ; cela ne rend pas tout le body brut. |
| SSE | Événements du contrat Responses | Plusieurs événements finissent dans une branche de log puis `Ok(None)` | Relayer uniquement les `ResponseEvent` perdrait des événements du flux d'origine. |
| Items inconnus | Le relais doit conserver les extensions reçues | `ResponseItem` utilise `#[serde(other)] Other` sans payload | Une reconstruction depuis cet enum ne peut pas préserver l'item inconnu d'origine. |

Sources : [`common.rs:179`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/codex-api/src/common.rs#L179), [`common.rs:260`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/codex-api/src/common.rs#L260), [`client.rs:869`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/core/src/client.rs#L869), [`client.rs:966`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/core/src/client.rs#L966), [`sse/responses.rs:531`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/codex-api/src/sse/responses.rs#L531), [`models.rs:1253`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/protocol/src/models.rs#L1253), [OpenAPI figé](https://github.com/openai/openai-openapi/blob/ddface9bd361f5fe37943291d23ee2ca72cbcc2b/openapi.json).

Les pointeurs publics relus sont `#/components/schemas/CreateResponse`, `InputParam`, `ToolChoiceParam`, `ResponseProperties`, `ModelResponseProperties`, `ResponseTextParam` et `TextResponseFormatConfiguration` sous `#/components/schemas/`.

Les 17 champs publics absents de **ce type HTTP** : `metadata`, `top_logprobs`, `temperature`, `top_p`, `user`, `safety_identifier`, `prompt_cache_retention`, `prompt_cache_options`, `previous_response_id`, `background`, `max_tool_calls`, `prompt`, `truncation`, `moderation`, `conversation`, `context_management`, `max_output_tokens`. Leur absence dans ce type n'établit pas un refus par le backend. Les deux champs supplémentaires de ce type Codex sont `client_metadata` et `access_programs`.

`ResponsesClient::stream(Value, ...)` accepte un body JSON plus large que `stream_request(ResponsesApiRequest, ...)`, mais sérialise encore le body et renvoie le même flux typé : cette autre méthode ne suffit donc pas à préserver le flux brut. Voir [`endpoint/responses.rs`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/codex-api/src/endpoint/responses.rs#L110).

## Compaction et références anciennes retrouvées

Le fichier historique `codex-api/src/endpoint/compact.rs` est absent. La voie courante examinée est [`core/src/compact_remote_v2_attempt.rs:78`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/core/src/compact_remote_v2_attempt.rs#L78) : elle ajoute `ResponseItem::CompactionTrigger {}` puis construit un `Prompt`. [`run_remote_compaction_request_v2`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/core/src/compact_remote_v2.rs#L387) appelle ensuite `client_session.stream(...)` et collecte l'item de compaction. Le test de sérialisation du trigger est présent à [`models.rs:3774`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/protocol/src/models.rs#L3774). Il n'a pas été exécuté ici. Ce chemin ne prouve pas la disponibilité de la route publique `/responses/compact` avec une authentification Codex.

Les deux symboles signalés comme non localisés ont des remplaçants candidats précis :

- Recherche web : [`ResponseItem::WebSearchCall`, `models.rs:1190`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/protocol/src/models.rs#L1190), au lieu du nom éditorial `WebSearchToolCall`.
- Agents : [`agent_control.spawn_agent_with_communication`, `spawn.rs:202`](https://github.com/openai/codex/blob/132c2be239ecbc1f2a9bb22d9210fefe887986a5/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L202), au lieu de `spawn_agent_with_metadata`.

Ces localisations corrigent le point d'entrée de recherche ; elles ne valident pas à elles seules les 366 correspondances.

## Décision d'architecture étayée

Pour le relais compatible OpenAI, prendre le proxy brut et les primitives de transport comme références. Garder le builder et le parseur Codex pour comprendre le runtime et ses adaptations. Éviter de faire traverser obligatoirement `ResponsesApiRequest` et `ResponseEvent` à tous les messages : les restrictions et pertes possibles sont visibles dans le code ci-dessus.

Les sources complètes, les dépendances et les tests sont désormais disponibles pour implémenter et vérifier ce chemin. Les tests du proxy, les appels backend et l'intégration d'authentification restent à exécuter dans leur lot d'implémentation.
