require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const WebSocket = require('ws');
const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('redis');

const path = require('path');

const app = express();
app.disable('x-powered-by');
// En-têtes de sécurité (HTTPS/WSS actif via Traefik). Pas de CSP ici pour ne pas
// casser le frontend (styles/scripts inline) ; HSTS n'a d'effet qu'en HTTPS.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '1mb' }));
// Sert le frontend statique (index.html + images) à la racine
app.use(express.static(path.join(__dirname, 'public')));
const httpServer = createServer(app);

// ── Frontend WebSocket (audio + text streaming vers le navigateur) ──────────
const wss = new WebSocket.Server({ server: httpServer });
const frontendClients = new Set();

wss.on('connection', (ws) => {
  frontendClients.add(ws);
  console.log(`[WS] Client connecté. Total : ${frontendClients.size}`);
  ws.on('close', () => {
    frontendClients.delete(ws);
    console.log(`[WS] Client déconnecté. Total : ${frontendClients.size}`);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  frontendClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ── Sessions stoppées par l'utilisateur (arrêt à chaud d'un débat) ──────────
// Une session ajoutée ici fait court-circuiter tous ses tours /speak restants
// (le tour en cours s'interrompt aussi), ce qui libère immédiatement pour
// relancer un autre débat. Nettoyage auto après 5 min.
const stoppedSessions = new Set();

// ── Redis ───────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[Redis]', err));
redis.connect().then(loadTtsConfig);

// ── Mistral ─────────────────────────────────────────────────────────────────
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ── Config TTS (provider + modèles), persistée dans Redis ───────────────────
// Modifiable à chaud via /tts/config (page d'admin) ; survit aux redémarrages.
const DEFAULT_TTS = {
  enabled: !(process.env.skipTts === 'true'), // rétro-compat : skipTts=true → audio off
  provider: 'openai',                          // 'openai' | 'elevenlabs' | 'voxtral'
  openaiModel: 'gpt-4o-mini-tts',              // moins cher / multilingue
  elevenModel: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
  voxtralModel: 'voxtral-mini-tts-2603',       // TTS Mistral (même clé API que le LLM)
  voxtralVoices: {},                           // { MC, Stratège, Créatif, Critique } -> voice_id
};
const ttsConfig = { ...DEFAULT_TTS };
const TTS_CONFIG_KEY = 'bridge:tts:config';

async function loadTtsConfig() {
  if (!redis.isReady) return;
  try {
    const raw = await redis.get(TTS_CONFIG_KEY);
    if (raw) {
      Object.assign(ttsConfig, JSON.parse(raw));
      console.log('[Bridge] Config TTS chargée depuis Redis :', ttsConfig);
    }
  } catch (e) { console.error('[Bridge] loadTtsConfig :', e.message); }
}
async function saveTtsConfig() {
  if (!redis.isReady) return; // Redis indisponible → on garde la config en mémoire sans bloquer
  try { await redis.set(TTS_CONFIG_KEY, JSON.stringify(ttsConfig)); }
  catch (e) { console.error('[Bridge] saveTtsConfig :', e.message); }
}

// ── Sécurité : auth par token sur les endpoints coûteux ─────────────────────
// Rétro-compatible : tant que BRIDGE_TOKEN n'est pas défini, /speak reste ouvert
// (le pipeline n8n actuel continue de fonctionner). Définis BRIDGE_TOKEN en prod
// ET ajoute l'en-tête `Authorization: Bearer <token>` dans le nœud "Appeler Bridge".
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
if (!BRIDGE_TOKEN) {
  console.warn('[Bridge] ⚠️  BRIDGE_TOKEN non défini — /speak est OUVERT (aucune authentification).');
}
function requireToken(req, res, next) {
  if (!BRIDGE_TOKEN) return next(); // pas de token configuré → ouvert (rétro-compat)
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-bridge-token'];
  if (token !== BRIDGE_TOKEN) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ── Rate limiting en mémoire (fenêtre glissante par IP) ─────────────────────
// n8n appelle via le réseau Docker interne (IP dédiée) ; le trafic externe passe
// par Traefik (IP partagée), donc une rafale externe est plafonnée sans gêner n8n.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 40;
const rlHits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (recent.length >= RL_MAX) return res.status(429).json({ error: 'Trop de requêtes' });
  recent.push(now);
  if (recent.length) rlHits.set(ip, recent); else rlHits.delete(ip);
  next();
}

// ── Config agents (modèle Mistral + voix ElevenLabs + voix OpenAI) ──────────
// Voix OpenAI dispo : alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse
const AGENTS = {
  MC:        { model: 'mistral-small-latest', voiceId: process.env.VOICE_MC,       openaiVoice: process.env.VOICE_OPENAI_MC       || 'onyx' },
  Stratège:  { model: 'mistral-large-latest', voiceId: process.env.VOICE_STRATEGE, openaiVoice: process.env.VOICE_OPENAI_STRATEGE || 'echo' },
  Créatif:   { model: 'mistral-large-latest', voiceId: process.env.VOICE_CREATIF,  openaiVoice: process.env.VOICE_OPENAI_CREATIF  || 'nova' },
  Critique:  { model: 'mistral-large-latest', voiceId: process.env.VOICE_CRITIQUE, openaiVoice: process.env.VOICE_OPENAI_CRITIQUE || 'fable' },
};

// ── OpenAI TTS : texte → MP3 base64 (un appel par phrase) ───────────────────
async function openAITTS(text, voice, model) {
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`OpenAI TTS ${resp.status}: ${errTxt.slice(0, 200)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString('base64');
}

// ── Voxtral TTS (Mistral) : texte → MP3 base64 (un appel par phrase) ─────────
// Endpoint POST /v1/audio/speech ; réponse JSON { audio_data: base64 }.
async function voxtralTTS(text, voiceId, model) {
  const resp = await fetch('https://api.mistral.ai/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: text, voice_id: voiceId, response_format: 'mp3' }),
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Voxtral TTS ${resp.status}: ${errTxt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.audio_data; // déjà en base64
}

// ── Liste des voix Voxtral du compte Mistral (cache 5 min) ──────────────────
let _voxVoices = { at: 0, list: [] };
async function getVoxtralVoices(force) {
  const fresh = Date.now() - _voxVoices.at < 5 * 60 * 1000;
  if (!force && fresh && _voxVoices.list.length) return _voxVoices.list;
  const resp = await fetch('https://api.mistral.ai/v1/audio/voices', {
    headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Voxtral voices ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  // L'API Mistral renvoie { items: [...] } (préréglages + voix clonées du compte)
  const list = Array.isArray(data) ? data : (data.items || data.data || data.voices || []);
  _voxVoices = { at: Date.now(), list };
  return list;
}

// Résout la voix Voxtral d'un rôle : config explicite → sinon auto-assignation
// déterministe depuis la liste du compte (une voix distincte par rôle).
function resolveVoxtralVoice(speaker) {
  const fromCfg = (ttsConfig.voxtralVoices || {})[speaker];
  if (fromCfg) return fromCfg;
  const list = _voxVoices.list;
  if (!list.length) return null;
  const roles = ['MC', 'Stratège', 'Créatif', 'Critique'];
  const idx = Math.max(0, roles.indexOf(speaker)) % list.length;
  const v = list[idx];
  return v && (v.id || v.voice_id || v.name) || null;
}

// ── Ouvre un stream ElevenLabs WebSocket ────────────────────────────────────
function openElevenLabsStream(voiceId, sessionId, speaker) {
  return new Promise((resolve, reject) => {
    // Modèle lu depuis la config (Flash v2.5 = le moins cher, multilingue FR)
    const model = ttsConfig.elevenModel || process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=${model}&output_format=mp3_44100_128`;

    const ws = new WebSocket(url, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });

    let finishResolve;
    const finishPromise = new Promise((r) => (finishResolve = r));

    ws.on('open', () => {
      // Begin-Of-Stream avec paramètres vocaux
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.80,
            style: 0.30,
            use_speaker_boost: true,
          },
          generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
        })
      );
      resolve({ ws, finishPromise });
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.audio) {
          // Diffuse les chunks audio (base64 MP3) au frontend
          broadcast({ type: 'audio', speaker, sessionId, data: msg.audio });
        }
        if (msg.isFinal) finishResolve();
      } catch (e) {
        console.error('[ElevenLabs] parse error:', e.message);
      }
    });

    ws.on('error', (err) => {
      console.error('[ElevenLabs] WS error:', err.message);
      finishResolve();
      reject(err);
    });

    ws.on('close', () => finishResolve());
  });
}

// ── POST /speak — point d'entrée appelé par n8n ──────────────────────────────
app.post('/speak', rateLimit, requireToken, async (req, res) => {
  const { system_prompt, messages, speaker, session_id } = req.body;

  if (!system_prompt || !messages || !speaker || !session_id) {
    return res.status(400).json({ error: 'Champs manquants : system_prompt, messages, speaker, session_id' });
  }

  const agent = AGENTS[speaker];
  if (!agent) return res.status(400).json({ error: `Agent inconnu : ${speaker}` });

  // Débat arrêté par l'utilisateur → on ne génère rien pour cette session
  if (stoppedSessions.has(session_id)) {
    broadcast({ type: 'speaker_end', speaker, sessionId: session_id });
    return res.json({ text: '', speaker, session_id, stopped: true });
  }

  const ttsOn = ttsConfig.enabled;
  const provider = ttsConfig.provider;

  // Vérifs de config selon le provider choisi
  if (ttsOn && provider === 'elevenlabs' && !agent.voiceId) {
    return res.status(500).json({ error: `VOICE_${speaker.toUpperCase()} non configuré` });
  }
  if (ttsOn && provider === 'openai' && !process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY non configuré' });
  }
  if (ttsOn && provider === 'voxtral') {
    if (!process.env.MISTRAL_API_KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY non configuré' });
    try { await getVoxtralVoices(); } catch (e) { return res.status(500).json({ error: 'Voxtral (voix) : ' + e.message }); }
    if (!resolveVoxtralVoice(speaker)) return res.status(500).json({ error: 'Aucune voix Voxtral configurée/disponible' });
  }

  // Lock Redis anti-chevauchement
  const lockKey = `session:${session_id}:lock`;
  const locked = await redis.set(lockKey, speaker, { NX: true, EX: 120 });
  if (!locked) return res.status(409).json({ error: 'Un autre intervenant est actif' });

  let fullText = '';
  let elStream = null;
  let openaiChain = Promise.resolve();

  // Abstraction provider : sendSentence(text) NON bloquant + finish() + close()
  const tts = { sendSentence: () => {}, finish: async () => {}, close: () => {} };

  try {
    broadcast({ type: 'speaker_start', speaker, sessionId: session_id });

    if (ttsOn && provider === 'elevenlabs') {
      elStream = await openElevenLabsStream(agent.voiceId, session_id, speaker);
      tts.sendSentence = (t) => { if (t.trim()) elStream.ws.send(JSON.stringify({ text: t + ' ' })); };
      tts.finish = async () => { elStream.ws.send(JSON.stringify({ text: '' })); await elStream.finishPromise; };
      tts.close = () => { if (elStream?.ws?.readyState === WebSocket.OPEN) elStream.ws.close(); };
    } else if (ttsOn && provider === 'openai') {
      // Chaînage séquentiel → garantit l'ordre des segments audio, sans bloquer Mistral
      tts.sendSentence = (t) => {
        const text = t.trim();
        if (!text) return;
        openaiChain = openaiChain
          .then(() => openAITTS(text, agent.openaiVoice, ttsConfig.openaiModel))
          .then((b64) => broadcast({ type: 'audio', speaker, sessionId: session_id, data: b64 }))
          .catch((e) => console.error('[OpenAI TTS]', e.message));
      };
      tts.finish = async () => { await openaiChain; };
    } else if (ttsOn && provider === 'voxtral') {
      // Voxtral (Mistral) : même logique de chaînage séquentiel que OpenAI
      const voiceId = resolveVoxtralVoice(speaker);
      tts.sendSentence = (t) => {
        const text = t.trim();
        if (!text) return;
        openaiChain = openaiChain
          .then(() => voxtralTTS(text, voiceId, ttsConfig.voxtralModel))
          .then((b64) => { if (b64) broadcast({ type: 'audio', speaker, sessionId: session_id, data: b64 }); })
          .catch((e) => console.error('[Voxtral TTS]', e.message));
      };
      tts.finish = async () => { await openaiChain; };
    }

    // Stream Mistral
    const mistralStream = await mistral.chat.stream({
      model: agent.model,
      messages: [{ role: 'system', content: system_prompt }, ...messages],
      maxTokens: 220,
      temperature: 0.72,
    });

    let buffer = '';

    for await (const chunk of mistralStream) {
      if (stoppedSessions.has(session_id)) break; // arrêt à chaud → on coupe le tour
      const delta = chunk.data?.choices?.[0]?.delta?.content || '';
      if (!delta) continue;

      fullText += delta;
      buffer += delta;

      // Diffuse le texte brut au frontend (affichage live)
      broadcast({ type: 'text_chunk', speaker, sessionId: session_id, text: delta });

      if (ttsOn) {
        // Découpe par phrase complète (meilleure prosodie pour les 2 providers)
        const match = buffer.match(/^(.*?[.!?…]+)\s+/s);
        if (match) {
          tts.sendSentence(match[1]);
          buffer = buffer.slice(match[0].length);
        }
      }
    }

    if (ttsOn) {
      if (buffer.trim()) tts.sendSentence(buffer); // vide le reste
      await tts.finish();                          // attend la fin de l'audio
    }

    broadcast({ type: 'speaker_end', speaker, sessionId: session_id });

    // Répond à n8n avec le texte complet (pour la mémoire Redis)
    res.json({ text: fullText, speaker, session_id });

  } catch (err) {
    console.error(`[/speak] Erreur pour ${speaker}:`, err.message);
    broadcast({ type: 'error', speaker, sessionId: session_id, message: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    await redis.del(lockKey);
    tts.close();
  }
});

// ── POST /stop — arrête un débat en cours (libère pour en relancer un) ──────
app.post('/stop', rateLimit, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id requis' });
  stoppedSessions.add(session_id);
  try { await redis.del(`session:${session_id}:lock`); } catch (e) { /* best effort */ }
  broadcast({ type: 'stopped', sessionId: session_id });
  console.log(`[Bridge] Débat ${session_id} arrêté par l'utilisateur`);
  // Nettoyage pour éviter une croissance non bornée du Set
  setTimeout(() => stoppedSessions.delete(session_id), 5 * 60 * 1000);
  res.json({ stopped: session_id });
});

// ── GET /tts — état courant (compat : skip = audio désactivé) ───────────────
app.get('/tts', (_req, res) => {
  res.json({ skip: !ttsConfig.enabled });
});

// ── POST /tts — { skip: true|false } (compat, garde l'ancien toggle) ────────
app.post('/tts', rateLimit, async (req, res) => {
  const { skip } = req.body;
  if (typeof skip !== 'boolean') return res.status(400).json({ error: 'skip doit être un booléen' });
  ttsConfig.enabled = !skip;
  await saveTtsConfig();
  console.log(`[Bridge] TTS ${ttsConfig.enabled ? 'activé' : 'désactivé'} via API`);
  res.json({ skip: !ttsConfig.enabled });
});

// ── GET /tts/config — config complète + providers dispo (lecture ouverte) ───
app.get('/tts/config', (_req, res) => {
  res.json({
    enabled: ttsConfig.enabled,
    provider: ttsConfig.provider,
    openaiModel: ttsConfig.openaiModel,
    elevenModel: ttsConfig.elevenModel,
    voxtralModel: ttsConfig.voxtralModel,
    voxtralVoices: ttsConfig.voxtralVoices || {},
    providers: {
      openai: { available: !!process.env.OPENAI_API_KEY, models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
      elevenlabs: { available: !!process.env.ELEVENLABS_API_KEY, models: ['eleven_flash_v2_5', 'eleven_multilingual_v2'] },
      voxtral: { available: !!process.env.MISTRAL_API_KEY, models: ['voxtral-mini-tts-2603'] },
    },
    tokenRequired: !!BRIDGE_TOKEN,
  });
});

// ── GET /tts/voices — liste les voix Voxtral du compte Mistral (proxy) ──────
app.get('/tts/voices', async (_req, res) => {
  if (!process.env.MISTRAL_API_KEY) return res.status(400).json({ error: 'MISTRAL_API_KEY non configuré' });
  try {
    const list = await getVoxtralVoices(true);
    // Normalise : { id, name, lang, gender }
    const voices = list.map((v) => ({
      id: v.id || v.voice_id || v.name,
      name: v.name || v.slug || v.id,
      lang: (v.languages || []).join(','),
      gender: v.gender || '',
    })).filter((v) => v.id);
    res.json({ voices });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── POST /tts/config — met à jour la config (écriture protégée par token) ───
app.post('/tts/config', rateLimit, requireToken, async (req, res) => {
  const { enabled, provider, openaiModel, elevenModel, voxtralModel, voxtralVoices } = req.body;
  if (typeof enabled === 'boolean') ttsConfig.enabled = enabled;
  if (provider === 'openai' || provider === 'elevenlabs' || provider === 'voxtral') ttsConfig.provider = provider;
  if (typeof openaiModel === 'string' && openaiModel) ttsConfig.openaiModel = openaiModel;
  if (typeof elevenModel === 'string' && elevenModel) ttsConfig.elevenModel = elevenModel;
  if (typeof voxtralModel === 'string' && voxtralModel) ttsConfig.voxtralModel = voxtralModel;
  if (voxtralVoices && typeof voxtralVoices === 'object') {
    const allowed = ['MC', 'Stratège', 'Créatif', 'Critique'];
    const clean = {};
    for (const r of allowed) if (typeof voxtralVoices[r] === 'string' && voxtralVoices[r]) clean[r] = voxtralVoices[r];
    ttsConfig.voxtralVoices = clean;
  }
  await saveTtsConfig();
  console.log('[Bridge] Config TTS mise à jour :', ttsConfig);
  res.json(ttsConfig);
});

// ── GET /transcript/:session_id — historique complet du débat (lecture Redis) ──
app.get('/transcript/:session_id', requireToken, async (req, res) => {
  try {
    const raw = await redis.get(`session:${req.params.session_id}:history`);
    const turns = raw ? JSON.parse(raw) : [];
    res.json({ session_id: req.params.session_id, turns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', frontendClients: frontendClients.size });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🎙  Bridge Table Ronde démarré`);
  console.log(`   HTTP  → http://localhost:${PORT}/speak`);
  console.log(`   WS    → ws://localhost:${PORT}`);
  console.log(`   Admin → http://localhost:${PORT}/admin.html`);
  console.log(`   Redis → ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
  console.log(`   TTS   → ${ttsConfig.enabled ? ttsConfig.provider : 'désactivé'}\n`);
});
