require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const WebSocket = require('ws');
const { Mistral } = require('@mistralai/mistralai');
const { createClient } = require('redis');

const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
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

// ── Redis ───────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[Redis]', err));
redis.connect();

// ── Mistral ─────────────────────────────────────────────────────────────────
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

let skipTts = process.env.skipTts === 'true';
if (skipTts) console.log('[Bridge] ⚠️  skipTts=true — ElevenLabs désactivé (mode dev)');

// ── Config agents (modèle + voice_id ElevenLabs) ────────────────────────────
const AGENTS = {
  MC:        { model: 'mistral-small-latest', voiceId: process.env.VOICE_MC },
  Stratège:  { model: 'mistral-large-latest', voiceId: process.env.VOICE_STRATEGE },
  Créatif:   { model: 'mistral-large-latest', voiceId: process.env.VOICE_CREATIF },
  Critique:  { model: 'mistral-large-latest', voiceId: process.env.VOICE_CRITIQUE },
};

// ── Ouvre un stream ElevenLabs WebSocket ────────────────────────────────────
function openElevenLabsStream(voiceId, sessionId, speaker) {
  return new Promise((resolve, reject) => {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=eleven_multilingual_v2&output_format=mp3_44100_128`;

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
app.post('/speak', async (req, res) => {
  const { system_prompt, messages, speaker, session_id } = req.body;

  if (!system_prompt || !messages || !speaker || !session_id) {
    return res.status(400).json({ error: 'Champs manquants : system_prompt, messages, speaker, session_id' });
  }

  const agent = AGENTS[speaker];
  if (!agent) return res.status(400).json({ error: `Agent inconnu : ${speaker}` });
  if (!skipTts && !agent.voiceId) return res.status(500).json({ error: `VOICE_${speaker.toUpperCase()} non configuré` });

  // Lock Redis anti-chevauchement
  const lockKey = `session:${session_id}:lock`;
  const locked = await redis.set(lockKey, speaker, { NX: true, EX: 120 });
  if (!locked) return res.status(409).json({ error: 'Un autre intervenant est actif' });

  let fullText = '';
  let elStream;

  try {
    broadcast({ type: 'speaker_start', speaker, sessionId: session_id });

    // Ouvre le stream ElevenLabs (sauf en mode skipTts)
    if (!skipTts) {
      elStream = await openElevenLabsStream(agent.voiceId, session_id, speaker);
    }

    // Stream Mistral
    const mistralStream = await mistral.chat.stream({
      model: agent.model,
      messages: [{ role: 'system', content: system_prompt }, ...messages],
      maxTokens: 400,
      temperature: 0.72,
    });

    let buffer = '';

    for await (const chunk of mistralStream) {
      const delta = chunk.data?.choices?.[0]?.delta?.content || '';
      if (!delta) continue;

      fullText += delta;
      buffer += delta;

      // Diffuse le texte brut au frontend (affichage live)
      broadcast({ type: 'text_chunk', speaker, sessionId: session_id, text: delta });

      if (!skipTts) {
        // Envoie à ElevenLabs par phrase complète (meilleure prosodie)
        const match = buffer.match(/^(.*?[.!?…]+)\s+/s);
        if (match) {
          elStream.ws.send(JSON.stringify({ text: match[1] + ' ' }));
          buffer = buffer.slice(match[0].length);
        }
      }
    }

    if (!skipTts) {
      // Vide le buffer restant
      if (buffer.trim()) {
        elStream.ws.send(JSON.stringify({ text: buffer + ' ' }));
      }
      // End-Of-Stream → ElevenLabs finalise l'audio
      elStream.ws.send(JSON.stringify({ text: '' }));
      // Attend que ElevenLabs ait envoyé tout l'audio
      await elStream.finishPromise;
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
    if (elStream?.ws?.readyState === WebSocket.OPEN) elStream.ws.close();
  }
});

// ── GET /tts  — état courant ─────────────────────────────────────────────────
app.get('/tts', (_req, res) => {
  res.json({ skip: skipTts });
});

// ── POST /tts — { skip: true|false } ────────────────────────────────────────
app.post('/tts', (req, res) => {
  const { skip } = req.body;
  if (typeof skip !== 'boolean') return res.status(400).json({ error: 'skip doit être un booléen' });
  skipTts = skip;
  console.log(`[Bridge] TTS ${skipTts ? 'désactivé' : 'activé'} via API`);
  res.json({ skip: skipTts });
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
  console.log(`   Redis → ${process.env.REDIS_URL || 'redis://localhost:6379'}\n`);
});
