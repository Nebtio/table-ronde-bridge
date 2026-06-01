# Table Ronde IA — Handoff / Contexte projet

> Document de reprise. À lire en premier sur une nouvelle machine.
> Dernière mise à jour : 2026-05-31.

## 1. C'est quoi

« Table Ronde IA » : web-app de **débat IA en direct**. Un sujet posé par l'utilisateur est débattu
par **4 agents** (MC animateur, Stratège, Créatif, Critique) sur **~17 interventions** /
3 manches. Texte streamé en direct + **audio (voix TTS)** façon podcast.

Cible visée : grand public curieux. Job critique : explorer un sujet sous plusieurs angles.

## 2. Architecture

```
Navigateur (frontend statique)
   │  1. POST sujet ──────────────► n8n webhook (orchestrateur)
   │                                   │  (boucle 17 tours)
   │                                   ▼
   │                                 Bridge /speak  (Node/Express)
   │                                   │  Mistral (LLM, streaming) + TTS
   │  2. WebSocket (texte + audio) ◄───┘  + Redis (lock + historique)
```

- **Frontend** : `bridge/public/index.html` (page unique, HTML/CSS/JS vanilla). Servi par le
  bridge via `express.static('public')`. Page d'admin secondaire : `public/admin.html`.
- **Bridge** : `bridge/server.js` (Node 20 / Express). Sert le frontend, expose `/speak` (appelé
  par n8n), diffuse texte+audio aux navigateurs par **WebSocket**, parle à Mistral + au provider TTS,
  gère le **lock Redis** anti-chevauchement et l'historique de session.
- **n8n** : orchestrateur (cloud `n8nmvp.nebt.pro`). Workflow id `pK5XcTn3AT2sHUfY`. Boucle sur la
  séquence de 17 tours, appelle le bridge à chaque tour. Détails §5.
- **Redis** : lock par session + historique du débat (`session:<id>:history`, sans TTL). Conteneur Coolify.
- **Coolify** : déploiement du bridge (Docker, depuis ce dépôt GitHub). Reverse-proxy (Traefik ou Caddy).
- **OVH** : VPS, IP `137.74.119.127`. DNS `*.nebt.pro` (wildcard) → cette IP.

## 3. URLs & accès

| Quoi | URL |
|---|---|
| App (prod) | **https://tableronde.nebt.pro/** (HTTPS/WSS, cert Let's Encrypt auto-renew) |
| Webhook n8n | `https://n8nmvp.nebt.pro/webhook/debate/start` (POST `{topic, session_id}`) |
| Bridge interne (n8n→bridge) | `http://table-ronde-bridge:3001` (réseau Docker Coolify) |
| Dépôt | `github.com/Nebtio/table-ronde-bridge` (PUBLIC — aucun secret dedans) |

## 4. Structure & workflow d'édition

```
C:\Sanbox\Débat\
├── bridge\        ← LE dépôt git (server.js, public/, Dockerfile, …)
│   └── public\    ← frontend SERVI + COMMITÉ (index.html, admin.html, Image/)
├── frontend\      ← miroir d'édition du frontend (HORS dépôt, optionnel)
└── bench\         ← golden set + rapports de tests (HORS dépôt)
```

**Éditer le frontend** : modifier `frontend\index.html` PUIS `npm run sync-frontend` (dans `bridge/`)
pour recopier dans `public/`, puis commit. `public/` est la copie déployée (le Dockerfile la `COPY`).
On peut aussi éditer `public/index.html` directement. La source canonique = `public/` (toujours à jour).

**Déployer** : `git push` → **redéployer dans Coolify** (le frontend est dans l'image Docker, donc tout
changement de `public/` OU `server.js` exige un **Redeploy**). ⚠️ Un changement de **variable d'env Coolify
n'est pris en compte qu'après un Redeploy** (piège vécu : nouveau token ignoré tant que pas redéployé).

## 5. Workflow n8n (id `pK5XcTn3AT2sHUfY`, projet perso « Nebt io »)

Flux : Webhook → Préparer Session → Redis Init Historique → Redis Init Status → **Rechercher Contexte**
(Tavily) → **Construire Séquence** (Code) → **Boucle Intervenants** (SplitInBatches) → Lire Historique →
**Construire Prompt** (Code) → **Appeler Bridge** (HTTP) → Màj Historique → Stocker Historique → (loop) /
Marquer Terminé → Répondre.

- **Construire Séquence** (Code) : émet **17 tours** avec un `move` chacun (cadre_ouverture, ouvre, attaque,
  repond, nouvel_angle, challenge, pivot, rebondit, cloture) + un type de `ending` tiré au sort. Architecture
  « débat dialectique » : MC cadre → Stratège ouvre → Critique attaque → Stratège répond/concède → … → MC clôt.
- **Construire Prompt** (Code) : construit le `system_prompt` par tour — PERSONA (MC non-expert/bref ;
  Créatif bannit les métaphores recyclées ; Critique varie ; …), MOVES (consigne par move, **60-90 mots**),
  PARTICIPANTS (casting fermé MC/Stratège/Créatif/Critique), FACTUALITÉ (anti-hallucination), grounding
  (contexte Tavily), FORMAT (interdit didascalies `[…]`).
- **Appeler Bridge** : `POST http://table-ronde-bridge:3001/speak`, header `Authorization: Bearer <BRIDGE_TOKEN>`.
- **Rechercher Contexte** : `POST https://api.tavily.com/search` (grounding actualité), header Bearer `<TAVILY_KEY>`.

**Gotchas n8n :**
- **SplitInBatches v3** : sortie **0 = done**, **1 = loop** (contre-intuitif).
- Code en `runOnceForEachItem` : retourner `{...}`, jamais `[{json:{...}}]`.
- Redis `get` stocke sous `propertyName` (mettre `value`).
- **Édition des gros jsCode** : écrire le JS SANS guillemets doubles ni backslash (guillemets français « » +
  `const NL = String.fromCharCode(10)`), pour que le seul encodage JSON soit `\n` → bien plus sûr via
  `n8n_update_partial_workflow` (patchNodeField find/replace, `replaceAll:true` si N occurrences).
- Le débat (17 tours) tourne **synchroniquement**, le webhook répond à la fin. Le front doit fire-and-forget
  et s'appuyer sur le WebSocket pour le live.
- **Lancer les débats STRICTEMENT en séquentiel** : ≥2 en parallèle → Mistral HTTP 429 (`rate_limited`).

## 6. TTS (3 fournisseurs, config persistée dans Redis)

`ttsConfig` (clé Redis `bridge:tts:config`) : `{ enabled, provider, openaiModel, elevenModel, voxtralModel, voxtralVoices }`.
Modifiable à chaud via la **modale Réglages** du front (⚙) ou `POST /tts/config` (protégé token).

- **OpenAI** (`gpt-4o-mini-tts`) : voix FR correctes. Voix par rôle (env `VOICE_OPENAI_*`, défauts onyx/echo/nova/fable).
- **ElevenLabs** (`eleven_flash_v2_5`) : streaming WS. Coûteux → évité.
- **Voxtral** (Mistral, `voxtral-mini-tts-2603`) : réutilise `MISTRAL_API_KEY`. `POST /v1/audio/speech`,
  réponse JSON `{audio_data: base64}`. Voix listées par `GET /v1/audio/voices` (champ **`items`** !).
  **Le compte n'a que 10 voix EN (aucune FR)** → français à accent anglais. `ref_audio` (clip base64
  par requête, clonage zero-shot) **fonctionne** → piste pour de vraies voix FR sans Studio (non codé).
  Voix assignées par rôle dans `ttsConfig.voxtralVoices` (clés accentuées « Stratège »/« Créatif »).

**Synchro audio ↔ illumination** (important) : génération (~9s/tour) ≫ lecture (podcast lent). L'illumination
du siège qui parle est donc pilotée par la **position de lecture audio** (chunks étiquetés par locuteur,
frontières notées, handler `timeupdate`), pas par la génération. Sans audio → illumination immédiate sur
`speaker_start`. Transcript + barre de progression restent sur l'horloge de génération (volontaire).

## 7. Sécurité

- **TLS** : HTTPS/WSS sur `tableronde.nebt.pro`, cert Let's Encrypt (Traefik/Coolify, auto-renew ~90j).
- **Auth `/speak`** : Bearer `BRIDGE_TOKEN` (rétro-compat : ouvert si l'env n'est pas défini).
- **Rate-limit** : 40 req/min/IP (in-memory) sur `/speak`, `/stop`, `POST /tts`, `POST /tts/config`.
  `app.set('trust proxy', 1)` → vraie IP client derrière Traefik.
- **En-têtes** : HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy ; `x-powered-by` retiré ; pas de CSP (front inline). `express.json` limité à 1mb.
- **Carte d'auth des endpoints** :
  - 🔐 `POST /speak`, `POST /tts/config` → token + rate-limit
  - 🔐 `GET /transcript/:id` → token
  - 🌐 `POST /stop`, `POST /tts` → ouverts (rate-limit) — choix assumé (aucun coût possible)
  - 🌐 `GET /tts`, `GET /tts/config`, `GET /tts/voices`, `GET /health` → lecture seule
- Aucun secret n'est commité (vérifié). `.env` gitignoré.

## 8. Secrets — INDEX (valeurs HORS dépôt)

> ⚠️ Les VALEURS ne sont **pas** ici (repo public). Les récupérer aux emplacements indiqués.

| Secret | Où se trouve la valeur |
|---|---|
| `BRIDGE_TOKEN` | Coolify (env du bridge) **et** header du nœud n8n « Appeler Bridge » (doivent être identiques) |
| `MISTRAL_API_KEY` | Coolify (env) — sert LLM **et** Voxtral TTS |
| `OPENAI_API_KEY` | Coolify (env) |
| `ELEVENLABS_API_KEY` + `VOICE_*` | Coolify (env) |
| `TAVILY` (clé) | Header du nœud n8n « Rechercher Contexte » |
| `N8N_API_KEY` | Config du serveur MCP `n8n-mcp` (pour piloter le workflow) |
| `REDIS_URL` | Coolify (env), réseau interne |

Voir `.env.example` pour la liste complète des variables. Sur ce PC, les valeurs sont aussi dans la mémoire
Claude locale (`~/.claude/projects/C--Sanbox-D-bat/memory/`).

## 9. Benchmark qualité

`bench/` (HORS dépôt) : golden set figé (`golden-set.json`, 15 sujets), prompt générateur, rapport
(`rapport-tests.md`). Méthode : run headless via webhook (séquentiel, garder la connexion ~110s),
récupérer le transcript via `GET {BRIDGE}/transcript/<id>` (header token), noter en **LLM-as-judge**
(grille 8 critères). Score V2-dialectique ≈ **4,8/5** sur le pilote G01/G08/G14.

## 10. Reste à faire / idées

- Baseline complète : jouer les **12 sujets restants** du golden set (séquentiel).
- Refactor d'altitude : **registre de providers** TTS (au lieu de 4 if/else dupliqués) + dériver la liste
  des rôles de `Object.keys(AGENTS)` (codée en dur à 3 endroits).
- Voix FR Voxtral via upload `ref_audio` (mécanisme validé, UI à coder).
- Progression : faire remonter le **vrai total de tours** depuis n8n (au lieu de `TOTAL_TURNS=17` codé en dur).
- Étude TTS coût (déjà : OpenAI adopté ; Voxtral dispo ; ElevenLabs évité).

## 11. Diagnostic « connexion client » (mai 2026)

Un client (derrière VPN) n'arrivait pas à charger. Constat : site sain (200 partout depuis IP propre,
HTTPS OK, aucun filtre IP dans Coolify, aucune exécution n8n à l'heure de sa tentative = il n'a pas atteint
l'app). Cause la plus probable : **filtrage de la plage IP du VPN** (OVH anti-DDoS / datacenter), pas l'appli.
Test décisif : client **sans VPN / en 4G**. Le 403 d'un vérificateur externe = artefact (requête brute sans
bon Host ; le proxy retire l'en-tête `Server` via `caddy_0.header -Server`). Liens « Non OK » du link-checker
= les `preconnect` Google Fonts (faux positifs ; la vraie CSS de polices est OK ; fallback système prévu).

## 12. Setup d'une nouvelle machine (Claude Desktop)

1. `git clone https://github.com/Nebtio/table-ronde-bridge` → contient bridge + frontend (`public/`) + ce doc.
2. Copier `C:\Sanbox\Débat\bench\` (golden set + rapports) si besoin du benchmark — c'est HORS dépôt.
3. Configurer le serveur **MCP `n8n-mcp`** avec le `N8N_API_KEY` (même instance n8n) pour piloter le workflow.
4. Récupérer les secrets depuis Coolify / n8n (voir §8) — ne PAS les committer.
5. (Option) copier le dossier mémoire local pour l'historique conversationnel détaillé.
6. Lire `CLAUDE.md` (instructions agent) + ce `HANDOFF.md`.
