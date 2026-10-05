# Sécurité

Signalez une vulnérabilité via [le signalement privé de GitHub](https://github.com/sofianbll/oai-codex-server/security/advisories/new), jamais dans une issue publique.

Ce proxy manipule la session ChatGPT de Codex (`auth.json`). Points d'attention :

- `auth.json` contient un refresh token : traitez-le comme un mot de passe. Il n'entre jamais dans l'image Docker (liste blanche `.dockerignore`) et n'est jamais relayé au dashboard.
- Ne transmettez que la clé locale du proxy (`oai-codex token`) à vos clients, jamais les identifiants Codex.
- N'exposez pas le serveur hors de `127.0.0.1` ou de votre tailnet.
