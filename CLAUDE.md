# Instructions agent — Table Ronde IA (bridge)

**Lire `HANDOFF.md` en premier** pour le contexte complet (architecture, n8n, TTS, secrets, sécurité, TODO).

## Le projet en 1 phrase
Web-app de débat IA : 4 agents débattent un sujet (~17 tours), texte+audio en direct.
Frontend statique servi par ce bridge Node/Express ; orchestration dans n8n ; déployé via Coolify (Docker) sur OVH.

## Règles d'édition (IMPORTANT)
- **Frontend** : éditer `frontend/index.html` (miroir) PUIS `npm run sync-frontend`, OU éditer directement
  `public/index.html`. La copie **servie + commitée** est `public/`. Toujours sync avant de committer.
- Préserver les **IDs / classes / `data-role`** référencés par le JS (le front est un seul fichier avec
  beaucoup de câblage WebSocket/audio/réglages — ne pas casser les contrats).
- **Déploiement** : `git push` PUIS **Redeploy Coolify** (frontend + server.js sont dans l'image Docker).
  Un changement de **variable d'env Coolify n'est actif qu'après Redeploy**.

## Édition du workflow n8n (via MCP `n8n-mcp`)
- Workflow id `pK5XcTn3AT2sHUfY`. Utiliser `n8n_update_partial_workflow` (patchNodeField find/replace).
- Écrire les gros jsCode **sans guillemets doubles ni backslash** (guillemets français « » +
  `const NL = String.fromCharCode(10)`) pour minimiser l'encodage JSON.
- SplitInBatches v3 : sortie **0=done, 1=loop**.

## Pièges à connaître
- **Débats en SÉQUENTIEL uniquement** (≥2 en // → Mistral 429).
- **Audio ≫ génération** : l'illumination du locuteur suit la **lecture audio**, pas la génération.
- Secrets : jamais dans le repo (public). Voir `HANDOFF.md` §8 pour leur emplacement.
- Voxtral : compte sans voix FR (accent EN) ; `ref_audio` validé pour des clips FR.

## Vérifs rapides (prod)
- `curl https://tableronde.nebt.pro/health` → `{"status":"ok"}`
- `curl https://tableronde.nebt.pro/tts/config` → provider/voix actifs
- Aperçu local du front : `npm run sync-frontend` puis servir `frontend/` (ex. `npx serve frontend`).

## Commit
Branche `main`, push direct. Finir les messages de commit par :
`Co-Authored-By: Claude <noreply@anthropic.com>`
