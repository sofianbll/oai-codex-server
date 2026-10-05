# Contre-audit de conformité — 01-openai-compliance.md

Nature : contre-audit contradictoire, **lecture seule** (seul ce fichier est écrit). Sources relues le 20/09/2026. Ce n'est pas un avis juridique.
Méthode : chaque citation et chaque URL du rapport initial ont été reconfrontées au texte publié. `Le texte dit` = constat. `J'en déduis` = interprétation. Aucune source inaccessible n'est reconstituée de mémoire.

## 1. Verdict du contre-audit

Le rapport est globalement fiable, mais pas au niveau de preuve qu'il revendique. **7 citations sur 8 sont exactes mot pour mot et correctement attribuées** ; toutes les URLs existent ; les constats tirés du code sont vérifiés (j'ai recompté indépendamment 38 opérations, valeur identique). Le rapport ne sur-interprète pas les clauses vers plus de risque ; il fait l'inverse sur un point, et il **sous-étaye sa propre thèse centrale**.

Trois défauts matériels :

1. Une citation est présentée entre guillemets alors qu'elle a été **réécrite** : « Use API key authentication… » là où la source dit « We recommend API key authentication… ». La recommandation devient un impératif.
2. Le rapport cite la version **hors EEE/RU/Suisse** des conditions et affirme (§6) que la version EEE/UK en est « identique sur les points utilisés ». Faux au mot près : la version Europe existe en anglais et en français, et ses listes d'interdictions sont rédigées différemment.
3. Deux des cinq sources déclarées (Usage Policies, article d'aide) ne sont **jamais citées** dans le corps, alors qu'elles contiennent des éléments décisifs manquants.

Conclusion bornée : le verdict final (privé = risque faible non nul ; partage/publication = risque élevé) **tient**, mais son socle probatoire doit être corrigé sur les points ci-dessous avant d'être cité comme preuve.

## 2. Tableau : citations et URLs

| # | Citation | URL | Vérifiée | Exacte | Commentaire |
| --- | --- | --- | --- | --- | --- |
| R1 | « You may not share your account credentials or make your account available to anyone else… » | openai.com/terms (§ Registration and access → Registration) | oui | **oui** | Également identique mot pour mot dans la version Europe (EN) et en français (« Vous ne pouvez pas partager les données d'identification de votre compte… »). Attribution correcte. |
| R2 | « Automatically or programmatically extract data or Output (defined below). » | openai.com/terms (§ Using our Services → What you cannot do) | oui | **oui** | Exact. Nuance de valeur : le rapport glose « à grande échelle » — le texte ne pose **aucun seuil**. La version Europe dit « Extraire automatiquement ou par programme des données ou des Données de sortie ». |
| R3 | « Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. **Don't expose Codex execution in untrusted or public environments.** » | developers.openai.com/codex/auth (§ Sign in with an API key) | oui | **NON** (1re phrase) | Le texte dit : « **We recommend** API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. » La 2e phrase est exacte. Une paraphrase est présentée entre guillemets sans ellipse. |
| R4 | « useful when you access OpenAI models through an LLM proxy server » | developers.openai.com/codex/auth (§ Alternative model providers) | oui | **oui** | Extrait exact. Phrase entière : « This is useful when you access OpenAI models through an LLM proxy server. » Attribution « la même page » correcte. |
| R5 | « Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services. » | openai.com/terms (§ What you cannot do) | oui | **oui** | Exact. Hiérarchie complète = « Using our Services » → « What you cannot do » ; l'attribution abrégée est acceptable. |
| R6 | « Modify, copy, lease, sell or distribute any of our Services. » | openai.com/terms (§ What you cannot do) | oui | **oui** | Exact en version hors-EEE. Version Europe : « Modifier, copier, louer, vendre ou distribuer l'un de nos Services. » |
| R7 | « Customer may not resell or lease access to its Account » | openai.com/policies/services-agreement/ (§3.1) | oui | **oui mais tronquée** | Le texte dit «…access to its **Account or any End User Account**. » Coupe sans ellipse. Section 3.1 correcte. |
| R8 | « violate or circumvent Usage Limits or otherwise configure the Services to avoid Usage Limits » | openai.com/policies/services-agreement/ (§3.3(i)) | oui | **oui** | Exact, y compris la lettre (i). |
| R9 | « We and our affiliates own all rights, title, and interest in and to the Services. You may only use our name and logo in accordance with our Brand Guidelines. » | openai.com/terms (§ Our IP rights) | oui | **oui** | Exact. Le texte ne dit pas que « oai » ou « codex » dans un nom de projet serait interdit ; il renvoie aux Brand Guidelines. `J'en déduis` : le risque « nom » est réel mais l'appui textuel est plus faible que ne le suggère le 🟠 du rapport. |
| R10 | « plan_type":"prolite","resets_in_seconds":348763 » (test du 20/09) | aucune URL ; source interne revendiquée | non | **non** | Aucun artefact du dépôt ne porte 348763. Le seul enregistrement trouvé (`artifacts/qa/ui-live/evidence.json`) porte une autre valeur et une structure différente (voir §5). |
| U1 | https://openai.com/terms | — | **oui** | — | Accessible. **C'est la version hors EEE/RU/Suisse.** La page renvoie elle-même les résidents EEE/UK/Suisse vers une autre version (voir §3.1). |
| U2 | https://openai.com/policies/usage-policies/ | — | **oui** | — | En vigueur le 29 octobre 2025 : la date annoncée par le rapport est exacte. Source déclarée mais jamais citée dans le corps. |
| U3 | https://openai.com/policies/services-agreement/ | — | **oui** | — | Exact : le préambule dit qu'il « only applies to use of OpenAI's APIs, ChatGPT Enterprise… and does not apply to OpenAI services used by consumers or individuals ». La note du rapport §3.5 est donc correcte. |
| U4 | https://developers.openai.com/codex/auth | — | **oui** | — | Aucune date de version affichée sur la page ; le rapport écrit « Documentation développeur », donc rien à réfuter. |
| U5 | https://help.openai.com/en/articles/11369540 | — | **oui (URL tronquée)** | — | Résout bien vers « Using Codex with your ChatGPT plan ». En HTTP direct (curl) : 403 Cloudflare ; contenu obtenu par extraction. Source déclarée mais jamais citée dans le corps. |
| C1 | `credentials.ts:45-51`, `upstream.ts:105-106`, `upstream.ts:69-79` + `oai-codex.config.json`, `catalog.ts:34-41`, `app.ts:53-65` | dépôt local | **oui** | **oui** | Vérifié ligne à ligne. `baseUrl` = `https://chatgpt.com/backend-api/codex`. Recomptage indépendant du catalogue : **38** opérations. 1 seul gestionnaire WebSocket (`runtime.ts:58-66`). Rafraîchissement : `spawn("codex", "app-server")` avec `CODEX_HOME` — « mécanisme officiel du CLI » confirmé. |

## 3. Contradictions et nuances manquantes

### 3.1 La version applicable est la version Europe — publique, et disponible en français
`Le texte dit` : la page citée (U1) est la version hors EEE/RU/Suisse et écrit elle-même « If you reside in the European Economic Area, Switzerland, or the UK, your use of the Services is governed by these terms », avec un lien vers `https://openai.com/policies/eu-terms-of-use/` (« Europe Terms of Use ») et sa version française `https://openai.com/fr-FR/policies/eu-terms-of-use/` (« Conditions d'utilisation pour l'Europe », **mise à jour le 16 janvier 2026**).

Comparaison menée :
- **Clause « Registration / Inscription »** : identique mot pour mot dans les trois versions. Le rapport a raison ici.
- **Listes « What you cannot do »** : **rédaction différente**. La version Europe écrit « il vous est interdit de : » et emploie des gérondifs : « Modifier, copier, louer, vendre ou distribuer l'un de nos Services. », « Extraire automatiquement ou par programme des données ou des Données de sortie (définies ci-dessous). », « Interférer avec nos Services ou les perturber, y compris contourner toute limite ou restriction de débit… ». Le rapport cite la formulation hors-EEE. **Même substance, texte non identique** : un lecteur français qui ouvre la page applicable ne retrouvera pas les guillemets du rapport.

Conséquence : la §6 (« le contenu des articles cités y est identique sur les points utilisés ») est **fausse au mot près**, et elle contredit la §7.3 qui demande de « consulter la version française/EEE des conditions en vigueur » comme si elle n'avait pas été lue. Les deux affirmations ne peuvent pas être vraies ensemble.

### 3.2 La version Europe ajoute une annexe commerciale que le rapport ignore
`Le texte dit` : la version Europe comporte une « Annexe relative à l'utilisation commerciale des Services » qui **prévaut en cas de conflit**, avec droit californien, limitation de responsabilité et indemnisation. Son champ est défini d'emblée comme couvrant « l'utilisation personnelle et non commerciale de nos Services par les consommateurs ».
`J'en déduis` : (a) le scénario D du rapport a une base textuelle plus directe que les clauses citées ; (b) le scénario A bénéficie d'une qualification « personnelle et non commerciale » absente de la version citée.

### 3.3 Des textes officiels favorables au projet ne sont pas cités
`https://developers.openai.com/codex/auth` contient aussi :
- « Access tokens are intended for trusted scripts, schedulers, and private CI runners. »
- « If your environment already provides a ChatGPT access token, the CLI can read it from stdin: `printenv CODEX_ACCESS_TOKEN | codex login --with-access-token` »
- « Fallback: Authenticate locally and copy your auth cache … Copy `~/.codex/auth.json` to `~/.codex/auth.json` on the headless machine. »

Ces trois extraits portent directement sur le motif technique du projet : lire `auth.json`, l'utiliser hors du client interactif, depuis une autre machine. Le rapport ne cite que la phrase défavorable (clé API) et la phrase favorable sur les proxys. `J'en déduis` : le dossier est plus équilibré que le rapport ne le présente.

### 3.4 L'absence d'interdiction explicite est vérifiable, mais mal documentée
Le rapport l'affirme sans dire où il a cherché. J'ai contrôlé les trois endroits où une interdiction apparaîtrait :
- **Usage Policies** `/policies/usage-policies/` : aucune clause sur les proxys, les clients tiers, ou l'usage d'un abonnement comme API. `Le texte dit` seulement que « breaking or circumventing our rules and safeguards may mean you lose access to our systems or experience other penalties » et qu'OpenAI « reserve[s] all rights to withhold access ».
- **Service terms** `/policies/service-terms/` (mis à jour 12/06/2026), incorporés aux deux contrats : la §4 « Codex and Code Generation » ne traite que des licences tierces sur les sorties.
- **Codex auth** : aucune phrase n'interdit un client non officiel.

C'est l'argument le plus favorable au projet ; il est sous-étayé dans le rapport.

### 3.5 La phrase « Don't expose Codex execution… » a un contexte
`Le texte dit` : elle figure dans la sous-section « Sign in with an API key ». Le rapport la place en §3.3 et en fait la base du verdict E sans indiquer son emplacement. Phrase générale dans sa formulation : attribution incomplète, pas fausse.

### 3.6 Un mécanisme officiel existe pour l'identité ChatGPT vers des applications tierces, pas pour l'entitlement
`https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt` documente « Sign in with ChatGPT » comme fournisseur d'identité vers des « supported external applications » (partenaires cités : Airtable, GitLab, HubSpot, Notion, Supabase, Vercel).
`J'en déduis` : OpenAI accepte officiellement qu'une identité ChatGPT serve à un service externe — mais c'est de l'identité, pas l'accès au backend Codex. Cela nuance tout raisonnement qui ferait du « client tiers » une faute en soi, sans autoriser le projet. Le rapport ne le mentionne pas.

## 4. Affirmations que je n'ai PAS pu vérifier

1. **Le corps du 429 cité en §2** (`http=429`, `resets_in_seconds: 348763`). Aucun artefact du dépôt ne porte 348763. Non reproductible en lecture seule.
2. **« OpenAI a noué un partenariat avec OpenCode »** : présent dans des sources tierces uniquement (Hacker News, blogs). Aucune confirmation sur un domaine openai.com. À ne pas utiliser comme preuve.
3. **La politique d'application réelle** (détection technique, avertissement, limitation, suspension). Aucune source officielle trouvée — l'incertitude du rapport §6 est justifiée, pas un oubli.
4. **L'effet d'une géolocalisation** sur ce que sert `https://openai.com/terms` à un visiteur français : la version extraite est la version hors-EEE. Je n'ai pas pu établir si la page est routée par IP.
5. **Le caractère opposable des Brand Guidelines** à un nom de projet comme `oai-codex-server` : la page citée renvoie aux Brand Guidelines, que je n'ai pas relues.

## 5. Affirmations fausses ou exagérées

| Affirmation du rapport | Ce que dit la source | Portée |
| --- | --- | --- |
| §3.3 : « Use API key authentication for programmatic Codex CLI workflows… » entre guillemets | « **We** recommend API key authentication… » | **Faux formellement.** Transforme une recommandation en instruction et présente une paraphrase comme citation. Matériel, car le rapport en tire son 🟠 « orientation officielle contraire ». |
| §6 : la version EEE « y est identique sur les points utilisés » | Rédaction différente des listes d'interdictions (voir 3.1) | **Faux au mot près.** Vrai pour la seule clause « Inscription ». |
| §5.2 : la passerelle à clé API est un « usage explicitement prévu par OpenAI » | Le droit d'intégrer dans une « Customer Application » est en Services Agreement §2.2, contrat entreprises/développeurs — pas dans les conditions grand public (cf. U3). Service terms §1 exige en plus de suivre `platform.openai.com/docs`. | **Exagéré** : « explicitement » vaut pour un client API sous contrat business, pas pour un particulier. |
| §2 : « Ne contourne pas les quotas… corps `{…}` » | Le corps réel est emballé dans `{"error":{"type","message","plan_type","resets_at","eligible_promo","resets_in_seconds"}}` (`evidence.json`). | **Présentation trompeuse** : corps reformaté et valeur numérique non traçable. |
| §3.1 : clause « Exposition 🔴 Directe dès qu'une autre personne obtient la clé locale » = « make your account available to anyone else » | Le texte dit bien « make your account available to anyone else ». | **Exact** — et c'est le point le mieux établi du rapport. |
| §4 scénario B : « Violation caractérisée » | Le texte établit la clause ; « caractérisée » est une qualification | **Exagéré** au regard de la clause de non-avis-juridique posée en tête du rapport. |

## 6. Ce que le rapport initial a oublié

1. **L'URL de la version applicable.** Il nomme le problème (§6) sans jamais donner le lien. `https://openai.com/fr-FR/policies/eu-terms-of-use/` existe.
2. **Deux sources déclarées jamais utilisées.** Usage Policies et l'article d'aide figurent au tableau des sources ; aucune citation du corps ne vient d'elles.
3. **La phrase qui tranche le contrat applicable**, dans l'article d'aide pourtant listé : « When you sign in to Codex using an existing ChatGPT account, the ChatGPT Terms of Use and Privacy Policy—or the corresponding online services agreement for OpenAI API and ChatGPT Enterprise, Education or Business Users—apply to data shared between Codex and ChatGPT. » C'est la seule phrase officielle qui rattache explicitement Codex à un contrat donné.
4. **La seule source qui décrit la sanction possible** (Usage Policies : perte d'accès, « other penalties »), alors que la question est laissée ouverte en §6.
5. **Les Service terms**, incorporés à la fois aux conditions grand public et au Services Agreement, et leur section Codex — vérifiée vide de toute interdiction de client tiers.
6. **La Sharing & Publication Policy**, citée comme contraignante par les conditions elles-mêmes, jamais évoquée — alors que la §5.2 envisage précisément une publication.
7. **Le fait que le catalogue de routes publié provient d'un document OpenAI** (`codex-contract-atlas/snapshot/openapi.json`, snapshot du dépôt `openai/openai-openapi`). `J'en déduis` : si la §5.2 publie la « partie neutre », la question de conformité ne se limite plus à la session Codex ; elle touche aussi à la redistribution d'un artefact dérivé d'OpenAI. Le rapport ne pose pas ce point.
8. **Une lecture symétrique des preuves** : sur 8 citations, 6 sont défavorables au projet. Le rapport conclut « zone grise » mais ne présente jamais le dossier favorable en entier (§3.3 et §3.4 ci-dessus).

---

**Bornes de ce contre-audit.** Je n'ai pas relu les Brand Guidelines, la Sharing & Publication Policy, ni la Service Credit Terms. Je n'ai pas rejoué le test 429 (écriture/session requise). Je n'ai trouvé **aucun** document officiel d'OpenAI autorisant nommément un relais local d'abonnement exposé comme API compatible OpenAI — ni en sens inverse.
