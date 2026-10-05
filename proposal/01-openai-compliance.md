# Conformité OpenAI — oai-codex-server

**Version 2, corrigée le 20/09/2026 après contre-audit contradictoire** (voir `01b-contre-audit-conformite.md`). Journal des corrections au §9. Ce document n'est pas un avis juridique.

Date de lecture initiale : 20 septembre 2026. Lecture seule : aucun fichier du projet n'a été modifié.

Sources primaires consultées le 20/09/2026 :

| Source | Version / date affichée | Applicable au cas de Sofian ? |
| --- | --- | --- |
| **Europe Terms of Use** — https://openai.com/policies/eu-terms-of-use/ (FR : https://openai.com/fr-FR/policies/eu-terms-of-use/) | **16 janvier 2026** | ✅ **oui** — résident de l'EEE (France) |
| OpenAI Terms of Use — https://openai.com/terms | 1er janvier 2026 | ❌ **non** : version hors EEE / UK / Suisse, la page le déclare elle-même |
| OpenAI Usage Policies — https://openai.com/policies/usage-policies/ | 29 octobre 2025 | oui |
| OpenAI Service terms — https://openai.com/policies/service-terms/ | 12 juin 2026 | oui (incorporés aux deux contrats) |
| OpenAI Services Agreement — https://openai.com/policies/services-agreement/ | — | ❌ non : API et offres entreprise, ne couvre pas un abonnement grand public |
| Codex — Authentication — https://developers.openai.com/codex/auth | aucune date de version affichée | documentation développeur |
| Aide « Using Codex with your ChatGPT plan » — https://help.openai.com/en/articles/11369540 | — | centre d'aide |

⚠️ **La version applicable est la version Europe, et non `openai.com/terms`.** La rédaction des listes d'interdictions diffère entre les deux (voir §3.2 et §6).

---

## 1. Verdict

**Usage personnel et privé, sur les appareils de Sofian, sans partage de l'accès et sans contournement des quotas : zone grise à risque faible mais non nul.**
**Publication en open source, ou partage de l'accès à un tiers : risque élevé de conflit avec les conditions d'utilisation d'OpenAI.**

La différence ne vient pas du code, elle vient du **destinataire de l'accès** et de la **distribution**. Les clauses réellement en jeu portent sur le partage de compte, l'usage programmatique d'un abonnement, et la distribution d'un outil qui permet à d'autres de faire la même chose.

---

## 2. Ce que fait réellement le projet (vérifié dans le code)

| Comportement | Preuve |
| --- | --- |
| Lit la session ChatGPT déjà enregistrée par le CLI Codex officiel dans `auth.json` | schéma `src/server/credentials.ts:11-25`, validation `:47`, relecture à chaque appel `:102-104` |
| Remplace l'en-tête `Authorization` de l'appelant par le jeton d'accès de l'abonnement et ajoute l'identifiant de compte | `src/server/upstream.ts:105-106` |
| Relaie vers un point de terminaison figé : `https://chatgpt.com/backend-api/codex` | figé par le schéma `src/server/config.ts:17` (`z.literal`), non-échappement revérifié en `src/server/upstream.ts:73-78` |
| Expose 38 opérations HTTP + 1 WebSocket, utilisables par n'importe quel client compatible OpenAI | `src/server/catalog.ts:34-41`, recompté le 20/09 |
| Relaie en réalité **tout** chemin `/v1/*`, y compris hors catalogue (ex. `POST /v1/chat/completions`) | `src/server/app.ts:130` (`app.all("/v1/*")`) — le catalogue décrit l'annonce, pas la limite du relais |
| **Ne contourne pas les quotas** : le `429 usage_limit_reached` de l'abonnement est relayé tel quel | Test du 20/09, enregistré dans `artifacts/qa/ui-live/evidence.json` ; structure réelle du corps : `{"error":{"type","message","plan_type","resets_at","eligible_promo","resets_in_seconds"}}` |
| Rafraîchit la session par le mécanisme officiel du CLI (pas de contournement du rafraîchissement) | `src/server/codex-refresh.ts` (`codex app-server`), README §Authentification |
| N'émule ni ne revend l'API : aucune facturation, aucune clé OpenAI tierce, aucun partage prévu par le code | `src/server/app.ts:53-65` (clé locale unique) + `src/server/runtime.ts:58-71` (mêmes contrôles pour les WebSockets) |

Nuance importante : le projet **ne détourne pas** la limite d'usage, il **l'expose** à d'autres clients. Il ne décompresse ni ne décortique aucun binaire : le protocole vient du client Codex, publié en open source par OpenAI.

---

## 3. Clauses pertinentes

Les deux formulations sont données quand elles diffèrent. **Celle applicable à Sofian est la version Europe.**

### 3.1 Compte et identifiants — clause identique dans les deux versions

> « You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account. »
> — Terms of Use (hors EEE), « Registration and access » → « Registration » ; **identique mot pour mot dans la version Europe (anglais) et en français**

| | |
| --- | --- |
| Ce que fait le projet | Le serveur est lié à l'abonnement personnel de Sofian. Chaque requête relayée consomme **son** compte. |
| Exposition | 🟢 **Nulle** tant que Sofian est le seul utilisateur, sur ses propres appareils. 🔴 **Directe** dès qu'une autre personne obtient la clé locale ou l'accès au réseau : cela revient à « make your account available to anyone else ». |

C'est le point le mieux établi de toute cette analyse : la clause est explicite, identique dans les deux versions, et son déclenchement dépend d'un fait vérifiable (une autre personne accède-t-elle au serveur ?).

### 3.2 Extraction automatisée

> Version Europe (applicable) : « Automatically or programmatically extracting data or Output (defined below). »
> Version hors EEE : « Automatically or programmatically extract data or Output (defined below). »
> — « Using our Services » → « What you cannot do »

| | |
| --- | --- |
| Ce que fait le projet | Expose un accès **programmatique** à la sortie du modèle, consommé par des SDK. |
| Exposition | 🟠 **Zone grise.** Le texte vise l'extraction de données ou de sorties ; il **ne fixe aucun seuil** et n'énumère aucune exception. L'argument « à grande échelle » ne peut pas être tiré du texte. |

### 3.3 Usage programmatique d'un abonnement

> « **We recommend** API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted or public environments. »
> — Codex, Authentication, sous-section « Sign in with an API key »

| | |
| --- | --- |
| Ce que fait le projet | Rend la session Codex disponible à des clients **autres que** le CLI / IDE / app officiels. |
| Exposition | 🟠 **Orientation officielle contraire, mais formulée comme une recommandation.** OpenAI désigne la clé API — facturée à l'usage — comme la voie de l'automatisation. Le texte ne dit ni « must » ni « only ». La seconde phrase, elle, est une mise en garde directe sur l'exposition. |

Élément en faveur du projet, sur la même page : l'option `requires_openai_auth = true` est décrite comme « useful when you access OpenAI models through an LLM proxy server ». OpenAI prévoit donc explicitement le passage par un proxy. La différence est de sens : là, Codex est le client d'un proxy ; ici, un proxy générique est le client de Codex.

### 3.4 Atteinte aux mesures de protection

> Version Europe (applicable) : « Interfering with or disrupting our Services, including circumventing any rate limits or restrictions or bypassing any protective measures or safety mitigations we put on our Services. »
> Version hors EEE : « Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services. »
> — « What you cannot do »

| | |
| --- | --- |
| Ce que fait le projet | Ne contourne ni ne relève aucune limite : la limite de l'abonnement s'applique intégralement et est visible par l'appelant. |
| Exposition | 🟢 **Faible** pour le comportement du code. Un tiers pourrait en revanche s'en servir pour répartir une charge sur plusieurs comptes — ce serait alors son manquement, mais le projet en serait l'instrument. |

### 3.5 Distribution et revente

> Version Europe (applicable) : « Modifying, copying, leasing, selling or distributing any of our Services. »
> Version hors EEE : « Modify, copy, lease, sell or distribute any of our Services. »
> — « What you cannot do »
> « Customer may not resell or lease access to its Account **or any End User Account** » — Services Agreement §3.1
> « violate or circumvent Usage Limits or otherwise configure the Services to avoid Usage Limits » — Services Agreement §3.3(i)

| | |
| --- | --- |
| Ce que fait le projet | Rien de tel aujourd'hui : aucun partage, aucune revente, aucune mise à disposition publique. |
| Exposition | 🔴 **C'est le scénario de la publication open source** : distribuer un outil qui transforme un abonnement ChatGPT en API compatible OpenAI met cet usage à portée de n'importe qui, y compris de personnes qui l'utiliseront au détriment des quotas. |

Note : le Services Agreement ne s'applique pas à un abonnement ChatGPT grand public ; il est cité parce qu'il montre la position constante d'OpenAI sur les limites d'usage. La version Europe des conditions comporte en plus une **annexe « utilisation commerciale »** qui **prévaut en cas de conflit** (voir §3.7).

### 3.6 Nom et marques

> « We and our affiliates own all rights, title, and interest in and to the Services. You may only use our name and logo in accordance with our Brand Guidelines. »
> — « Our IP rights »

| | |
| --- | --- |
| Ce que fait le projet | Le nom `oai-codex-server` reprend « oai » et « codex », et le README mentionne l'adresse réelle de la machine. |
| Exposition | 🟠 À traiter **avant** toute publication : renommer. Le texte renvoie aux Brand Guidelines sans interdire nommément un nom de projet : l'appui textuel est réel mais plus faible qu'un « interdit ». |

### 3.7 Annexe commerciale de la version Europe

> « If you use our Services for commercial or business use, the following terms apply. In the event of a conflict between this Business Use of the Services Addendum and the rest of these Terms, this Addendum shall take precedence. »
> « Governing law (business use). California law will govern these Terms… »
> — Europe Terms of Use, « Business use of the Services addendum » (16 janvier 2026)

Deux conséquences :

- Le champ des conditions est défini d'emblée comme couvrant « **personal, non-commercial use** of our Services by consumers » — qualification **favorable** au scénario A, absente de la version que ce rapport citait initialement.
- En cas d'usage commercial, cette annexe **prime** sur le reste et bascule le droit applicable vers la Californie. C'est la base textuelle la plus directe du scénario D.

Hors annexe commerciale, la version Europe retient : « The law of the jurisdiction where you are a resident will govern these Terms. »

---

## 4. Risques par scénario

| Scénario | Risque | Raisonnement |
| --- | --- | --- |
| **A. Privé, mono-utilisateur, ses propres appareils**, volume faible à modéré | 🟡 Faible mais non nul | Aucun partage d'identifiants, aucun contournement de quota. Qualification « personnel et non commercial » dans la version applicable. Deux points de friction : l'usage programmatique d'un abonnement, et l'orientation officielle vers la clé API. Le plus probable en cas de détection est un durcissement ou un blocage, pas une sanction lourde. |
| **B. Partage avec un proche** (clé locale transmise) | 🔴 **Clause explicite déclenchée** | « make your account available to anyone else ». Les activités de l'autre personne sont sous la responsabilité du titulaire. Le mot « violation caractérisée » serait une qualification juridique que ce document n'a pas les moyens de poser : la clause est claire, la sanction reste inconnue. |
| **C. Publication open source publique** | 🔴 Élevé | Le projet devient un moyen générique d'obtenir une API compatible OpenAI sans la payer. C'est le cœur de ce que les clauses 3.2, 3.3 et 3.5 cherchent à décourager. Risques : demande de retrait, blocage de compte pour les utilisateurs, réputation du projet. S'y ajoute une question distincte, la redistribution du catalogue de routes (§8.5). |
| **D. Usage commercial ou revente d'accès** | ⛔ Prohibé | Cumul des clauses 3.1, 3.4, 3.5, et de l'annexe commerciale qui prévaut. À exclure sans discussion. |
| **E. Exposition sur Internet (au-delà du Tailscale)** | ❌ À ne pas faire | Contredit frontalement « Don't expose Codex execution in untrusted or public environments ». |

Le point de bascule est donc **B / C / E** : tout ce qui fait sortir la session du cercle « Sofian et ses propres machines ».

---

## 5. Options, de la plus sûre à la plus exposée

### 5.1 Rester privé — recommandé par défaut

Garder le projet hors ligne publique, limité aux appareils de Sofian, sur son réseau Tailscale, sans jamais transmettre la clé locale. Aucun changement de code. C'est l'état actuel.

### 5.2 Publier seulement la partie neutre

Séparer ce qui pose problème de ce qui est utile au plus grand nombre :

| Partie | Publiable ? |
| --- | --- |
| Transport OpenAI-compatible, adaptation `responses`, agrégation SSE, dashboard, explorer, journal, Scalar | 🟢 Oui, sous réserve : c'est une passerelle générique alimentée par la **clé API de l'utilisateur**. Attention à ne pas présenter cela comme une autorisation tirée des conditions grand public : le droit d'intégrer le service dans une « Customer Application » figure au **Services Agreement §2.2**, contrat entreprises / développeurs, et les Service terms §1 imposent en plus de suivre `platform.openai.com/docs`. Pour un particulier, c'est la voie normale de l'API, pas un droit écrit. |
| Relais de la session d'abonnement Codex (`credentials.ts`, `codex-refresh.ts`, `baseUrl` Codex) | 🔴 Non : c'est exactement la partie qui pose la question. |

Autrement dit : publier une passerelle *vers l'API officielle avec la clé de l'utilisateur*, et garder le relais d'abonnement comme usage privé documenté mais non distribué. C'est un arbitrage de conception, pas une modification à faire maintenant.

### 5.3 Renommer avant toute publication

Nommer le projet d'après sa fonction technique, sans « oai » ni « codex » dans le nom, et retirer du README l'adresse Tailscale personnelle et le chemin `~/.codex`.

---

## 6. Incertitudes — ce que cette analyse ne tranche pas

- **Aucun document public consulté ne traite nommément du cas « abonnement ChatGPT exposé comme API compatible OpenAI ».** La qualification se fait par interprétation de clauses générales. Recherche menée dans les quatre endroits où une interdiction apparaîtrait — Usage Policies, Service terms §4 « Codex and Code Generation », Services Agreement, page d'authentification Codex : **aucune interdiction de client tiers ni de proxy n'y figure**, et aucune autorisation non plus.
- On ne sait pas si OpenAI détecte techniquement ce type de relais, ni quelle politique d'application elle applique. La seule sanction décrite publiquement est générale : les Usage Policies indiquent que contourner les règles « may mean you lose access to our systems or experience other penalties » et qu'OpenAI « reserve[s] all rights to withhold access ».
- **La version applicable est celle de l'Europe** (résident de l'EEE) : https://openai.com/policies/eu-terms-of-use/, mise à jour le 16 janvier 2026, version française à https://openai.com/fr-FR/policies/eu-terms-of-use/. Sa clause « Inscription » est identique mot pour mot à celle citée ici ; ses **listes d'interdictions sont rédigées différemment** (gérondifs et formulation différente, mêmes substances). Un lecteur qui ouvre la page applicable ne retrouvera donc pas les guillemets de la version hors EEE — les deux formulations sont citées au §3.
- La qualification du « programmatic use » d'un abonnement (§3.2) reste ouverte : aucune source trouvée ne donne de seuil ni d'exemple.
- Le rattachement contractuel de Codex est énoncé, lui, explicitement, dans l'article d'aide : « When you sign in to Codex using an existing ChatGPT account, the ChatGPT Terms of Use and Privacy Policy—or the corresponding online services agreement for OpenAI API and ChatGPT Enterprise, Education or Business Users—apply to data shared between Codex and ChatGPT. » C'est la seule phrase officielle trouvée qui rattache Codex à un contrat donné.
- Le « partenariat OpenAI–OpenCode » parfois évoqué dans les discussions autour de ce type d'outil **n'a été trouvé que dans des sources tierces** (forums, blogs). Il n'est pas utilisable comme preuve et n'entre pas dans cette analyse.

---

## 7. Recommandation bornée

1. **Ne pas publier** le relais de session en open source tant que la question de conformité n'est pas tranchée — soit par une réponse écrite d'OpenAI, soit par le choix de la variante 5.2.
2. **Garder l'accès strictement personnel** : jamais de clé locale transmise, jamais d'exposition hors Tailscale.
3. **Avant toute décision de publication**, lire la version Europe en vigueur (URL au §6) et éventuellement poser la question directement au support OpenAI. C'est la seule voie qui transforme une interprétation en réponse.

---

## 8. Éléments officiels qui n'étaient pas cités en version 1

Cette section a été ajoutée après le contre-audit, qui a reproché à la version 1 de ne présenter qu'un dossier déséquilibré (6 citations sur 8 défavorables). Tous les extraits ci-dessous sont vérifiés sur la source réelle le 20/09/2026.

### 8.1 Éléments favorables au projet (page d'authentification Codex)

| Extrait officiel | Portée |
| --- | --- |
| « Access tokens are intended for trusted scripts, schedulers, and private CI runners. » | OpenAI documente des jetons destinés à un usage **non interactif** sur des exécutants **privés**. C'est le motif exact du projet. |
| « If your environment already provides a ChatGPT access token, the CLI can read it from stdin: `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token` » | OpenAI documente l'injection d'un jeton d'accès ChatGPT **venu d'ailleurs**, hors du navigateur. |
| « Fallback: Authenticate locally and copy your auth cache » … « Copy `~/.codex/auth.json` to `~/.codex/auth.json` on the headless machine. » (méthodes SSH et Docker incluses) | OpenAI documente la **copie de `auth.json` vers une autre machine**. Le motif technique du projet — lire ce fichier et l'utiliser hors du client interactif — n'est donc pas en soi un détournement. |
| « This is useful when you access OpenAI models through an LLM proxy server. » | OpenAI prévoit explicitement le passage par un proxy (§3.3). |

### 8.2 Élément défavorable au projet sur la même page

| Extrait officiel | Portée |
| --- | --- |
| « If you use file-based storage, treat `~/.codex/auth.json` like a password: it contains access tokens. **Don't commit it, paste it into tickets, or share it in chat.** » | La même documentation exige de traiter le fichier **comme un mot de passe**. Cela pèse directement sur le scénario B : transmettre la clé du serveur à un tiers revient à lui donner accès au contenu de ce fichier. Cet extrait manquait en version 1 et va dans le sens d'une lecture stricte. |

### 8.3 Contrat applicable

- L'article d'aide rattache explicitement Codex au contrat ChatGPT quand on y accède avec un compte ChatGPT (citation au §6).
- Les Service terms (12/06/2026) sont incorporés **à la fois** aux conditions grand public et au Services Agreement ; leur §4 « Codex and Code Generation » ne traite que des licences tierces sur les sorties — **aucune interdiction de client tiers**.
- La **Sharing & Publication Policy** est citée comme contraignante par les conditions elles-mêmes et n'a pas été relue ; elle devient pertinente dès qu'une publication est envisagée (§5.2).
- Les **Usage Policies** (source déclarée en version 1 mais jamais citée) contiennent la seule description publique de la sanction (§6).

### 8.4 Contexte : identité ChatGPT vers des applications tierces

La page d'aide « Sign in with ChatGPT » documente ChatGPT comme fournisseur d'identité vers des applications externes partenaires (Airtable, GitLab, HubSpot, Notion, Supabase, Vercel, entre autres). Cela n'autorise pas l'accès au backend Codex, mais nuance tout raisonnement qui ferait du « client tiers » une faute en soi.

### 8.5 Question distincte : la redistribution du catalogue de routes

Le catalogue servi (`codex-contract-atlas/snapshot/openapi.json`) est un **snapshot d'un dépôt OpenAI** (`openai/openai-openapi`). Si la variante 5.2 publiait la « partie neutre » en incluant ce fichier, la conformité ne se limiterait plus à la session Codex : elle toucherait aussi la **redistribution d'un artefact dérivé d'OpenAI**, sous sa propre licence. Ce point n'existait pas en version 1 et doit être tranché séparément.

---

## 9. Journal des corrections apportées en version 2

Contre-audit source : `01b-contre-audit-conformite.md` (20/09/2026, 109 lignes, lecture seule).

| Correction | Ce qui était faux |
| --- | --- |
| Citation §3.3 remplacée par le texte exact (`We recommend…`) | Une paraphrase était présentée entre guillemets comme une citation, transformant une recommandation en instruction. |
| Version légale applicable corrigée (§6, tableau des sources) | La version 1 citait `openai.com/terms` (hors EEE) et affirmait à tort que la version Europe était « identique sur les points utilisés ». La version Europe existe, en anglais et en français, et ses listes d'interdictions sont rédigées différemment. |
| Deux formulations citées pour chaque clause du §3 | Un lecteur français ne retrouvait pas les guillemets du rapport sur la page qui le concerne. |
| Corps du 429 (§2) | La version 1 citait une structure et une valeur non retrouvables dans les artefacts du dépôt ; la structure réelle vient de `evidence.json`. |
| « à grande échelle » retiré (§3.2) | Le texte ne fixe aucun seuil. |
| « violation caractérisée » atténué (§4 scénario B) | Qualification juridique que ce document n'a pas les moyens de poser. |
| « usage explicitement prévu par OpenAI » atténué (§5.2) | Le droit d'intégration invoqué est au Services Agreement, contrat entreprises — pas dans les conditions grand public. |
| §8 ajouté | Le dossier favorable (jetons d'accès, copie de `auth.json`, proxy) et un élément défavorable manquant (« treat `auth.json` like a password ») sont désormais présentés. |
| §6 complété | Recherche d'interdiction explicite documentée ; sanction publique citée ; partenariat OpenCode déclaré non probant. |
