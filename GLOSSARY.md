# Compatibilité OpenAI avec Codex

Vocabulaire du proxy : distinguer ce qui peut être transporté, ce que Codex fournit et ce qui a réellement été vérifié.

## Langage

**Route relayable** : route que le proxy peut transmettre à Codex. Sa présence ne garantit ni l’acceptation par le backend ni les droits du compte.
_Éviter_ : route compatible, route vérifiée.

**Capacité Codex native** : comportement fourni par Codex, distinct d’un comportement recréé par le proxy. Sa présence dans un client officiel ne prouve pas son accessibilité au compte utilisé.
_Éviter_ : compatibilité OpenAI complète.

**Adaptation locale explicite** : traduction ou comportement fourni par le proxy pour satisfaire fidèlement un contrat OpenAI, annoncé comme distinct du natif Codex.
_Éviter_ : support natif, équivalence supposée.

**Compatibilité vérifiée** : correspondance observée avec un contrat client et son résultat attendu, pour une cible, une version et des conditions identifiées.
_Éviter_ : route présente, requête acceptée, succès de transport.

**Continuité Codex** : possibilité de poursuivre un échange dans son contexte natif. Elle est distincte de la conservation durable de réponses ou de conversations.
_Éviter_ : historique persistant, stockage durable.

**Réponse stockée** : objet Response conservé pour sa consultation ultérieure. Sa conservation est distincte de celle des items rattachés à une Conversation.
_Éviter_ : conversation, continuité Codex.

**Conversation OpenAI** : objet durable regroupant des items de conversation. Elle est distincte d’un thread Codex et de la chaîne d’une réponse précédente.
_Éviter_ : thread Codex, session native.

**Réponse en arrière-plan** : réponse dont l’exécution ne dépend pas du maintien de la connexion cliente, avec un état consultable et une annulation explicite.
_Éviter_ : flux déconnecté, automatisation Desktop.
