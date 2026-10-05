# Responses — livraison du sprint

Fenêtre demandée : 17:22:22–17:37:22 UTC le 20 septembre 2026. Finalisation légèrement après l’échéance pour corriger et revalider un défaut du résultat terminal SSE observé pendant l’activation. Aucun nouveau chantier ajouté après l’échéance. Rappel chaque minute créé puis supprimé.

## Implémenté et activé
- HTTP Responses via WebSocket natif : première réponse puis previous_response_id sur la même connexion, JSON et SSE, erreurs natives conservées, expiration/limites explicites, refus d’un compte différent.
- Stockage local en mémoire pour store:true : création JSON et capture SSE sans bloquer le flux, récupération, suppression, input_items paginés. 256 réponses, 32 Mio total, 4 Mio/réponse, TTL une heure ; effacé au redémarrage/changement de compte.
- Normalisation web_search_preview vers web_search, y compris sélecteurs.
- Route publique compact vers compaction native, enveloppe SDK et véritable item chiffré.
- Cache du sprint précédent désormais chargé avec ces changements.

## Preuves
- Suite globale : 198 tests passés, zéro échec, 21 747 assertions, 33 fichiers. Après l’ajout final de conservation des erreurs natives, suite bridge ciblée 3/3 ; après correction terminale SSE, intégration/agrégation ciblées 8/8. Pas de prétention que les 199 tests actuels ont tous été relancés après ces derniers changements.
- TypeScript, build et lint réussis. git diff --check réussi.
- Revue Terra rapide : PASS sur les blocages identifiés et corrigés (compte, SSE live, limites, fermeture de connexions, IDs invalides).
- Sept appels natifs de QA : voir qa-result.json. Continuité secrète sans répétition dans le second input, stockage/relecture/input_items/suppression, recherche web avec appel et citation, compaction puis replay exact réussis.
- Le premier contrôle DELETE était un faux échec du script : le SDK retourne None ; HTTP200 puis GET404 prouvent la suppression.
- Le premier replay ajoutait created_by:null via model_dump. Avec exclude_none=True, compact et replay retournent200 et le secret exact. Cette contrainte de sérialisation reste documentée.
- Contrôle personnel root sur le service actif : SDK streaming store:true, 14 événements, texte exact SPRINT_OK, store:true, relecture réussie, puis suppression. Voir activation.json ; l’échec initial du terminal sans output est conservé dans activation-before-stream-fix.json.

## Déploiement
Le processus auxiliaire sur127.0.0.1:8788 a été arrêté. Le gestionnaire a révélé une seconde instance du même projet sur son adresse configurée100.64.0.1:8788. Après vérification que chacune n’avait aucune requête active, cette instance configurée a été redémarrée, puis testée. URL active : http://100.64.0.1:8788. Les serveurs QA temporaires et leurs clés ont été supprimés. Aucun commit ni push effectué.

## Restant explicite
L’API n’est pas universellement complète : background/cancel comme jobs, conversations persistantes, stockage durable, comptage exact avant génération, paramètres natifs rejetés, Code Interpreter et ressources File Search/MCP restent hors de cette livraison. Le stockage implémenté est local et éphémère ; aucune de ces limites n’est masquée par un faux succès.

## Intégration au banc API
Le script ponctuel `qa.py` a été remplacé par les scénarios du lanceur existant :
`oai-codex test responses --scenario previous-response|retrieve|delete|compact|store-json|web-search`
(choisir un seul nom par invocation). Scripts dans `api-tests/responses/`, nouveaux
rapports dans `api-tests/responses/results/`. Les JSON de ce dossier restent des
preuves historiques du sprint.
