# Contrats OpenAI : stockage, Conversations et background

Recherche documentaire ciblée du **16 octobre 2026**, sans appel modèle ni backend. Ce document constate le contrat public ; il ne constitue ni une spec produit ni une preuve de compatibilité vérifiée avec Codex.

## Conclusion utile au cadrage

- **Responses : `store` omis signifie normalement `true`**. Exceptions documentées : ZDR et certains traitements background. Le choix du défaut local reste à l'arbitrage parent ; cette note ne le décide pas. [R1, D1, B1]
- **Chat : contradiction officielle à conserver visible**. Le schéma OpenAPI indique `default: false`, mais le guide de migration annonce un stockage par défaut pour les nouveaux comptes. Impossible de revendiquer un défaut universel sans qualifier le profil. [O1, M1]
- **Supprimer une conversation ne supprime pas ses items**. Supprimer un item renvoie la conversation restante, pas un objet `item.deleted`. Aucune purge des réponses, fichiers ou résultats d'outils n'est promise en cascade. [C1, C2, O1]
- **`background:true, store:false` est désormais documenté comme permis**, avec stockage temporaire d'environ dix minutes pour le polling. Ce n'est pas une absence de stockage. Pour MAM, seul `store:true` explicite conserve le résultat au-delà de cette fenêtre ; l'omission n'est donc pas équivalente à `true`. [B1, D1]
- Une restauration locale doit conserver les **items structurés ordonnés**, les associations d'outils, `phase` et les contenus chiffrés terminés. Un transcript texte ne restaure pas fidèlement le contexte. La portabilité des contenus chiffrés vers Codex n'est pas établie par le contrat public. [S1, Q1, K1]

## Méthode et niveau de preuve

Lecture d'`AGENTS.md`, des trois documents `docs/agents/`, de `README.md` et de `GLOSSARY.md` ; `docs/adr/` absent. Pas de nouvel inventaire du projet ni du tracker.

SDK installé : **`openai` Node 7.20.0**, confirmé dans son `package.json`. Les cinq fichiers examinés ont été comparés octet pour octet aux sources officielles du tag `v7.20.0` : tous identiques. Leurs déclarations TypeScript sont des types publics, pas une validation runtime du service. [K1–K5]

Schéma public : `openai/openai-openapi`, commit **`6ca9cb2b2dd5fbe766c32f3ab898e2e479c29840`**, daté du 16 octobre 2026 à 19:10:05 UTC. Les guides et API references ci-dessous ont été consultés le même jour ; ils peuvent évoluer indépendamment de ce schéma. [O1]

## 1. Defaults `store` et interaction avec `conversation`

### Responses

`ResponseCreateParamsBase.store?: boolean | null` et le schéma de création disent explicitement : « Defaults to true when omitted », stockage « at least 30 days » si vrai, sous réserve des exceptions. Le guide conversation-state présente une conservation de trente jours par défaut. **Trente jours exactement comme TTL local est un profil d'adaptation**, pas une preuve que le service public efface physiquement chaque donnée à J+30. Le guide your-data distingue état applicatif, logs de surveillance, cache et médias ; `store:false` n'est pas une promesse de suppression de toutes ces catégories. [R1, S1, D1, K1]

Sous ZDR, `store` est traité comme faux même si vrai est demandé. Ne pas appliquer ces contrôles d'organisation API à un abonnement Codex sans preuve séparée. [D1]

### Chat Completions

- `CreateChatCompletionRequest.properties.store` porte **`default: false`** dans OpenAPI. [O1, lignes 44610–44620]
- Le guide de migration dit deux fois : **« Chat completions are stored by default for new accounts »**. [M1]
- La référence de création et le SDK déclarent `store` optionnel et nullable mais leur description ne tranche pas le défaut selon l'ancienneté du compte. Les méthodes retrieve/list/update/delete du SDK ne concernent que les completions stockées avec `store:true`. [H1, K4]

**Implication :** ne pas transformer cette divergence en décision locale silencieuse. `store:false` explicite évite l'ambiguïté documentaire ; le comportement d'une omission doit être annoncé comme profil choisi. La date de bascule et le comportement des comptes existants ne sont pas établis par ces sources.

### `conversation` avec `store:false`

Le champ `conversation` signifie que les items existants sont préfixés à l'entrée et que les nouveaux items d'entrée et de sortie sont ajoutés automatiquement après achèvement de la réponse. Les objets Conversation et leurs items n'ont pas le TTL de trente jours ; your-data indique « until deleted ». [R1, S1, D1]

Les schémas et types consultés **ne déclarent pas d'exclusion** entre `conversation` et `store:false` et ne décrivent pas `store:false` comme un opt-out de l'ajout des items. En revanche, ils n'explicitent pas dans une règle dédiée le résultat de cette combinaison. Conclusion prudente : **ne pas promettre que `store:false` empêche la persistance de l'historique conversationnel** ; distinguer stockage de l'objet Response et stockage des items Conversation. L'acceptation effective et les cas d'échec/annulation de cette combinaison restent non vérifiés. [R1, K1, O1]

Le SDK autorise aussi `null` : cela ne documente pas son équivalence à une omission. Ne pas confondre absent, nul, faux et vrai. [K1, K4]

## 2. Suppressions : périmètre exact et contraintes

### `DELETE /conversations/{conversation_id}`

La référence, le schéma et `Conversations.delete()` disent exactement : **« Items in the conversation will not be deleted »**. Retour : `{id, object:"conversation.deleted", deleted:boolean}`. Le conteneur Conversation est supprimé ; ses items ne le sont pas par cette opération. Une cascade locale supprimant automatiquement les items contredirait ce contrat public. [C1, O1, K2]

**Non spécifié :** accès ultérieur aux items survivants après disparition du parent, purge physique, GC, durée supplémentaire, effet sur les objets Response associés ou sur leurs descendants. Les routes publiques d'items sont rattachées à un `conversation_id` ; survivre n'implique donc pas être encore récupérable par cette route. Ne pas présenter cette opération comme un effacement intégral des données. [C1, C2, O1]

### `DELETE /conversations/{conversation_id}/items/{item_id}`

Supprime l'item de cette conversation ; retourne **l'objet Conversation** (`id`, `created_at`, `metadata`, `object:"conversation"`). SDK exact : `items.delete(itemID, {conversation_id}) -> APIPromise<Conversation>`. Ne pas copier les exemples positionnels historiques du YAML pour coder avec le SDK installé. [C2, K3]

Le schéma documente **400 si la conversation est verrouillée**, **404 si la conversation ou cet item dans cette conversation n'existe pas**, et 500 si la mise à jour ne peut pas être finalisée. Il ne garantit pas une cascade sur les items suivants, un couple appel/résultat d'outil, une réponse déjà créée ou le fichier référencé par l'item. « Pas de cascade spécifiée » n'est pas une preuve expérimentale d'indépendance de toutes les copies internes. La répétition d'un DELETE d'item n'est pas documentée comme retournant toujours 200 : ne pas lui attribuer l'idempotence de réponse du cancel. [O1, lignes 5025–5071 ; C2]

### Contraintes des items

- Création de conversation avec items initiaux et ajout d'items : **20 items maximum par appel** ; `items` d'ajout est une liste de `ResponseInputItem`, pas une liste de textes arbitraires. [C3, K2, K3, O1]
- L'ajout peut échouer en 400 pour items invalides, déjà présents ou conversation verrouillée ; 404 si conversation absente ; 500 si finalisation impossible. L'atomicité d'un lot, les règles exhaustives de validation croisée et le moment exact du verrouillage ne sont pas précisés. [O1, lignes 4571–4638]
- La liste est paginée et **descendante par défaut** dans le SDK ; restaurer chronologiquement exige `order:"asc"` et toutes les pages utiles. Le schéma de sortie Conversations accepte des rôles plus larges que les messages d'entrée Responses : un objet de sortie n'est pas automatiquement un input valide. [K2, K3, K1]

**Implication locale :** conserver séparément parent, rattachement d'item et Response ; toute politique de purge intégrale doit être explicitement distincte du DELETE compatible. Ce constat n'autorise aucune décision d'architecture ou modification produit ici.

## 3. Jobs background : conservation, reprise et annulation

### Conservation publique, sans extrapolation entre profils

| Profil API public | `store:false` | `store` omis | `store:true` explicite |
| --- | --- | --- | --- |
| Background sous MAM, y compris enhanced MAM | Temporaire ≈10 min puis suppression | Temporaire ≈10 min puis suppression | Conservation standard après la fenêtre de polling |
| Background sous ZDR | Temporaire ≈10 min | Effectivement faux ; temporaire ≈10 min | Traité comme faux ; temporaire ≈10 min |
| Background hors contrôles particuliers | Autorisé ; stockage temporaire pour exécution/polling | Défaut général Responses vrai ; portée exacte des règles MAM non transposable sans qualification | Règle générale : au moins 30 jours, sous exceptions |

Sources : le guide background permet expressément `store:false` dans ses limites ; your-data qualifie précisément les cas MAM et ZDR. **Ne pas généraliser « omis = dix minutes » à tous les comptes**, ni « background exige store:true ». Le point de départ exact du délai approximatif, le TTL séparé du journal SSE et les courses avec une exécution très longue ne sont pas définis ici. [B1, D1, R1]

### Reprise SSE

Créer avec **`background:true` ET `stream:true`** ; mémoriser `response.id` et le dernier `sequence_number` reçu. Une rupture du flux n'arrête pas le job background. Reprise par **`GET /responses/{id}?stream=true&starting_after=N`** : `N` est un numéro d'événement, pas un index d'item ni un offset texte ; les événements commencent après ce numéro. Un nouveau stream n'est permis que si la réponse background a été créée avec `stream:true`. [B1, R2]

Le SDK 7.20.0 possède déjà `responses.retrieve(id, {stream:true, starting_after:N})` avec un retour typé stream. La mention « SDK support coming soon » dans certains exemples du guide background est donc périmée pour cette méthode installée. Le markdown de la référence retrieve affiche aussi une variante `stream: optional false`, alors que le SDK expose distinctement les surcharges streaming/non-streaming : ne pas en déduire une interdiction de `true`. [K1, R2, B1]

### Statuts et cancel

Statuts publics : **`queued`, `in_progress`, `completed`, `failed`, `cancelled`, `incomplete`**. Le polling continue pendant les deux premiers ; les autres sont terminaux. Aucun statut Response public `cancelling`. [B1, R3, K1]

`POST /responses/{id}/cancel` est réservé aux réponses créées avec `background:true` et retourne un objet Response. Le guide garantit : **annuler deux fois est idempotent, les appels suivants renvoient l'objet final**. Ne pas transformer une réponse déjà terminée en faux `cancelled`, ni confondre cancel et delete. Le contrat consulté ne détaille pas tous les codes d'erreur, la course complétion/annulation ou une garantie de statut immédiatement `cancelled` dans chaque course. Pour une requête synchrone, le guide préconise de terminer la connexion. [B1, R3]

**Adaptation locale déjà cadrée, pas résultat testé :** au redémarrage, les jobs non terminés deviennent `failed`, sans relance. Ce choix n'est pas une propriété documentée du service OpenAI ; une reprise SSE locale exige un journal d'événements conservé avec ses séquences, pas seulement le JSON final. Une fenêtre temporaire ≈10 min pour `store:false` reste à distinguer de la conservation durable 30 jours et du quota local de 1 Gio. Aucun arbitrage sur l'omission ou autorisation QA n'est ajouté ici.

## 4. Restauration locale fidèle du contexte

1. **Choisir une seule continuité publique.** `conversation` et `previous_response_id` sont explicitement incompatibles, même si les propriétés indépendantes du type TypeScript ne rendent pas ce conflit impossible à compiler. Une adaptation locale peut résoudre un identifiant local puis fournir le contexte explicite au backend ; elle ne doit pas envoyer un identifiant inventé comme s'il était une continuité Codex native. [R1, K1]
2. **Ne pas doubler l'historique.** `conversation` préfixe déjà ses items ; `previous_response_id` chaîne le contexte. En mode replay, reconstituer l'ordre et la branche réellement référencée. Les `instructions` d'une réponse antérieure ne sont pas automatiquement reconduites avec `previous_response_id` : ne pas transformer toutes les anciennes instructions en instructions persistantes lors de l'émulation. [R1, K1, S1]
3. **Préserver les outils en tant qu'items.** Chat utilise notamment les messages assistant `tool_calls` et les messages `role:"tool"` liés par `tool_call_id`. Responses utilise `function_call` et `function_call_output` liés par `call_id` (et d'autres unions pour les autres outils). Ne pas faire passer un message Chat `role:"tool"` tel quel comme message Responses. Conserver arguments, résultats, identifiants et tous les items entre la dernière entrée utilisateur et le résultat d'outil ; rejouer un résultat n'autorise pas à réexécuter son effet externe. [H1, R1, Q1, K1, K4]
4. **Préserver `phase`.** `commentary` n'est pas `final_answer`. Le SDK insiste sur sa conservation pour les modèles Codex récents, et le guide reasoning avertit du risque d'arrêt prématuré si le champ disparaît. Ne pas l'ajouter aux messages utilisateur ni le déduire d'un texte aplati. [Q1, K1, K2]
5. **Conserver le chiffré opaque terminé.** Le guide reasoning actuel et le SDK disent que `encrypted_content` est fourni par défaut sur les items reasoning ; `include:["reasoning.encrypted_content"]` est accepté pour compatibilité, non exigé par ce contrat récent. En SSE, retenir l'item de `response.output_item.done`, pas la valeur potentiellement partielle de `output_item.added`. Les items de compaction et autres empreintes opaques ne sont pas remplaçables par un résumé texte. [Q1, K1]
6. **Respecter la projection sortie → entrée.** Le SDK public fournit `toResponseInputItems()` : retire `created_by`, `parsed` et `parsed_arguments`, conserve `phase`/reasoning, filtre certains items non rejouables sans changement de sens (ex. `additional_tools` non developer, certains outputs d'outil non terminés) et rejette les types inconnus. Ce helper établit que « JSON de sortie recopié aveuglément » n'est pas la règle générale. Conserver l'original en stockage et distinguer sa projection d'entrée ; ne pas effacer silencieusement un contexte indispensable au motif qu'un helper filtre un item. [K5, S1]

La persistance du reasoning ne garantit pas sa réutilisation universelle : le guide limite la réutilisation à une même famille de modèles et indique que les éléments incompatibles sont omis du contexte. `reasoning.context:"all_turns"` n'invente pas les items absents. La durée de validité des blobs, leur portabilité compte/backend et la restauration d'environnements hébergés d'outils ne sont pas garanties par ces sources. [Q1]

## Frontière API publique / backend Codex / inconnues

- **Contrat API public établi :** defaults et exceptions ci-dessus, routes/types des suppressions, reprise background, exclusion des deux mécanismes de contexte, structure de replay. Ce n'est pas une vérification runtime.
- **Possibilité technique d'adaptation locale :** matérialiser l'historique, gérer identifiants, stockage et jobs en local, puis envoyer des inputs explicites. Cela respecte l'objectif d'adaptation locale explicite seulement si les items nécessaires sont acceptés et leurs résultats fidèlement restitués ; la faisabilité de toute option Responses ne découle pas du stockage seul.
- **Capacité Codex native non établie ici :** persistance API, Conversations, scheduler background, annulation native et résolution durable de `previous_response_id`. Une route relayable ou un type du SDK ne les prouve pas. La continuité Codex reste distincte du stockage durable, conformément à `GLOSSARY.md`.
- **Inconnues à ne pas masquer :** replay chiffré après redémarrage et selon compte/famille/backend ; effets exacts de suppression sur copies historiques et items orphelins ; courses de verrouillage/annulation ; TTL SSE ; interaction conversation/store:false pour tous les états terminaux ; modèle de défaut Chat selon comptes. Les combinaisons non précisées restent non vérifiées, pas arbitrairement acceptées ou refusées.

## Sources primaires

- **R1** — [Responses create, référence exacte](https://developers.openai.com/api/reference/resources/responses/methods/create) : `store`, `conversation`, `previous_response_id`, input et instructions.
- **R2** — [Responses retrieve](https://developers.openai.com/api/reference/resources/responses/methods/retrieve) : `starting_after`, streaming.
- **R3** — [Responses cancel](https://developers.openai.com/api/reference/resources/responses/methods/cancel) : restriction background et Response/statuts.
- **S1** — [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state) : historique complet, conservation et distinction Conversations/Responses.
- **D1** — [Your data](https://developers.openai.com/api/docs/guides/your-data#v1responses) : état applicatif, MAM/ZDR, exceptions et rétention Conversations.
- **B1** — [Background mode](https://developers.openai.com/api/docs/guides/background) : storefalse, polling, cancel idempotent et reprise SSE.
- **M1** — [Migration vers Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses) : défaut Chat des nouveaux comptes, en divergence avec O1.
- **H1** — [Chat create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) : messages tool et store.
- **C1** — [Delete conversation](https://developers.openai.com/api/reference/resources/conversations/methods/delete) : non-suppression explicite des items.
- **C2** — [Delete conversation item](https://developers.openai.com/api/reference/resources/conversations/subresources/items/methods/delete) : portée et objet Conversation retourné.
- **C3** — [Create conversation items](https://developers.openai.com/api/reference/resources/conversations/subresources/items/methods/create) : liste typée et maximum 20.
- **Q1** — [Reasoning : préservation, replay et phase](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls).
- **O1** — [OpenAPI officiel figé](https://github.com/openai/openai-openapi/blob/6ca9cb2b2dd5fbe766c32f3ab898e2e479c29840/openapi.yaml) : en particulier [create items et erreurs](https://github.com/openai/openai-openapi/blob/6ca9cb2b2dd5fbe766c32f3ab898e2e479c29840/openapi.yaml#L4571-L4638), [delete item et erreurs](https://github.com/openai/openai-openapi/blob/6ca9cb2b2dd5fbe766c32f3ab898e2e479c29840/openapi.yaml#L5025-L5071), [default Chat](https://github.com/openai/openai-openapi/blob/6ca9cb2b2dd5fbe766c32f3ab898e2e479c29840/openapi.yaml#L44610-L44620).
- **K1** — [SDK Node 7.20.0, types et méthodes Responses](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/responses/responses.ts) ; copie inspectée : `node_modules/openai/src/resources/responses/responses.ts` (notamment 10981–11190, 11456–11520, 7257–7267).
- **K2** — [SDK Node 7.20.0, Conversations](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/conversations/conversations.ts).
- **K3** — [SDK Node 7.20.0, items](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/conversations/items.ts).
- **K4** — [SDK Node 7.20.0, Chat Completions](https://github.com/openai/openai-node/blob/v7.20.0/src/resources/chat/completions/completions.ts).
- **K5** — [SDK Node 7.20.0, projection publique ResponseInputItems](https://github.com/openai/openai-node/blob/v7.20.0/src/lib/responses/ResponseInputItems.ts).

Limites de cette recherche : aucun test live, aucune exécution Codex, aucun accès aux identifiants ou données privées, aucun changement produit/branche/commit/issue. Les décisions de défaut local `store` et d'autorisations QA demeurent au parent. Production non touchée.
