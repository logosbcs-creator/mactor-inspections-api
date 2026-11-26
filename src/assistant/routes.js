const express = require('express');
const OpenAI = require('openai');
const prisma = require('../services/database');
const { authMiddleware } = require('../services/auth');
const cfg = require('./config');
const { validTwilioRequest, fetchMedia, sendToOwner } = require('./whatsapp');
const actions = require('./actions');
const { handleOwnerMessage } = require('./agent');
const store = require('./connectors/store');
const gmail = require('./connectors/gmail');
const zoho = require('./connectors/zoho');
const email = require('./connectors/email');
const photos = require('./photos');

const router = express.Router();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ── WhatsApp inbound (Twilio webhook) ────────────────────────────

async function transcribe(buffer, type) {
  if (!openai) return null;
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mpeg') ? 'mp3' : type.includes('mp4') ? 'm4a' : 'ogg';
  const file = await OpenAI.toFile(buffer, `nota.${ext}`, { type });
  const res = await openai.audio.transcriptions.create({ file, model: 'gpt-4o-transcribe' });
  return res.text;
}

// Turns a Twilio WhatsApp payload into Claude content blocks.
async function toContent(body) {
  const blocks = [];
  const text = (body.Body || '').trim();
  const n = Number(body.NumMedia || 0);
  for (let i = 0; i < Math.min(n, 5); i++) {
    const url = body[`MediaUrl${i}`], type = body[`MediaContentType${i}`] || '';
    try {
      const media = await fetchMedia(url);
      if (type.startsWith('audio/')) {
        const said = await transcribe(media.buffer, type);
        blocks.push({ type: 'text', text: said ? `(Nota de voz de Julio, transcrita): ${said}` : '(Julio mandó una nota de voz que no pude transcribir)' });
      } else if (/^image\/(jpeg|png|gif|webp)$/.test(type)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: media.buffer.toString('base64') } });
        try {
          const saved = await photos.save(media.buffer, type, text);
          blocks.push({ type: 'text', text: `(Foto guardada, photo_id: ${saved.id})` });
        } catch (err) {
          console.error('[Assistant] photo save failed:', err.message);
          blocks.push({ type: 'text', text: '(No pude guardar esta foto; solo puedo verla)' });
        }
      } else {
        blocks.push({ type: 'text', text: `(Julio adjuntó un archivo ${type} que todavía no puedo abrir)` });
      }
    } catch (err) {
      console.error('[Assistant] media failed:', err.message);
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return { blocks, text: text || blocks.find(b => b.type === 'text')?.text || '' };
}

async function handleInbound(body) {
  await prisma.assistantState.upsert({
    where: { id: 1 }, create: { id: 1, lastInboundAt: new Date() }, update: { lastInboundAt: new Date() },
  });
  const { blocks, text } = await toContent(body);
  await prisma.assistantEvent.create({ data: { direction: 'in', text: text || '(media)', externalId: body.MessageSid || undefined } }).catch(() => {});
  if (!blocks.length) return;

  // "pausa" / "reanuda" switch the assistant off/on without touching Railway.
  const st = await prisma.assistantState.findUnique({ where: { id: 1 } });
  const cmd = text.trim().toLowerCase();
  if (/^(pausa|pausar|stop)$/.test(cmd) || /^(reanuda|reanudar|activa|resume)$/.test(cmd)) {
    const paused = /^(pausa|pausar|stop)$/.test(cmd);
    await prisma.assistantState.update({ where: { id: 1 }, data: { paused } });
    await sendToOwner(paused ? '⏸️ Asistente en pausa (no mando alertas ni brief). Escribe *reanuda* para activarlo.' : '▶️ Asistente activo de nuevo.', { kind: 'system' });
    return;
  }
  if (st?.paused) return;

  // "sí 12" / "no" about a pending action is handled in code, never by the model.
  if (text && await actions.handleConfirmation(text)) return;
  await handleOwnerMessage(blocks);
}

// POST /api/assistant/whatsapp
router.post('/whatsapp', async (req, res) => {
  if (!validTwilioRequest(req)) {
    console.warn('[Assistant] rejected WhatsApp webhook with bad signature');
    return res.status(403).send('Forbidden');
  }
  // Answer Twilio right away (it gives up after 15s); the work continues below.
  res.type('text/xml').send('<Response></Response>');

  const from = String(req.body.From || '').replace(/^whatsapp:/, '');
  if (from !== cfg.ownerPhone) {
    console.warn('[Assistant] ignored WhatsApp from non-owner number');
    prisma.assistantEvent.create({ data: { direction: 'system', text: 'Mensaje ignorado de un número no autorizado', meta: { from } } }).catch(() => {});
    return;
  }
  handleInbound(req.body).catch(async err => {
    console.error('[Assistant] inbound failed:', err);
    await sendToOwner(`⚠️ Error procesando tu mensaje: ${err.message}`, { kind: 'system' }).catch(() => {});
  });
});

// ── OAuth (connect Gmail / Zoho) ─────────────────────────────────

const PROVIDERS = {
  google: { impl: gmail, provider: 'gmail', labels: ['gmail_logos', 'gmail_mactor'] },
  zoho: { impl: zoho, provider: 'zoho', labels: ['zoho'] },
};

// GET /api/assistant/oauth/:provider/start?label=gmail_logos&token=<admin JWT>
router.get('/oauth/:provider/start', authMiddleware, (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p) return res.status(404).send('Unknown provider');
  const label = req.query.label || p.labels[0];
  if (!p.labels.includes(label)) return res.status(400).send('Unknown label');
  try {
    res.redirect(p.impl.authUrl(store.signState({ provider: req.params.provider, label })));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const page = (title, msg) => `<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;padding:32px;max-width:520px;margin:auto"><h2>${title}</h2><p>${msg}</p><p><a href="https://inspector.fixmyproperty.ca/invoices/asistente">Volver al panel del asistente</a></p>`;

// GET /api/assistant/oauth/:provider/callback
router.get('/oauth/:provider/callback', async (req, res) => {
  const p = PROVIDERS[req.params.provider];
  try {
    if (!p) throw new Error('Unknown provider');
    if (req.query.error) throw new Error(String(req.query.error));
    const st = store.verifyState(req.query.state);
    if (st.provider !== req.params.provider) throw new Error('state mismatch');
    const got = await p.impl.exchangeCode(String(req.query.code || ''));
    await store.saveConnection({ provider: p.provider, label: st.label, ...got });
    res.send(page('✅ Conectado', `La cuenta <b>${got.account}</b> quedó conectada como <code>${st.label}</code>.`));
  } catch (err) {
    console.error('[Assistant] OAuth callback failed:', err.message);
    res.status(400).send(page('No se pudo conectar', String(err.message).replace(/</g, '&lt;')));
  }
});

// ── Admin panel API (/invoices/asistente) ────────────────────────

router.get('/status', authMiddleware, async (req, res) => {
  const [st, mailboxes, pending, recentActions, events] = await Promise.all([
    prisma.assistantState.findUnique({ where: { id: 1 } }),
    email.connected(),
    prisma.assistantAction.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } }),
    prisma.assistantAction.findMany({ where: { status: { not: 'pending' } }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.assistantEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
  ]);
  res.json({
    configured: cfg.enabled(),
    whatsappFrom: !!cfg.waFrom, templateConfigured: !!cfg.waTemplateSid,
    paused: !!st?.paused, lastInboundAt: st?.lastInboundAt, sessionId: st?.currentSessionId,
    mailboxes, pending, recentActions, events,
  });
});

router.post('/actions/:code/:decision', authMiddleware, async (req, res) => {
  const a = await prisma.assistantAction.findFirst({ where: { shortCode: Number(req.params.code), status: 'pending' } });
  if (!a) return res.status(404).json({ error: 'No pending action' });
  if (req.params.decision === 'confirm') await actions.execute(a);
  else await prisma.assistantAction.update({ where: { id: a.id }, data: { status: 'cancelled' } });
  res.json(await prisma.assistantAction.findUnique({ where: { id: a.id } }));
});

router.post('/pause', authMiddleware, async (req, res) => {
  const paused = !!req.body?.paused;
  await prisma.assistantState.upsert({ where: { id: 1 }, create: { id: 1, paused }, update: { paused } });
  res.json({ paused });
});

module.exports = router;
