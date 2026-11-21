const twilio = require('twilio');
const prisma = require('../services/database');
const cfg = require('./config');

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const MSG_SERVICE = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const client = SID && TOKEN ? twilio(SID, TOKEN) : null;

const MAX_LEN = 1500; // Twilio caps WhatsApp bodies at 1600 chars

function chunks(text) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf('\n', MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = rest.lastIndexOf(' ', MAX_LEN);
    if (cut <= 0) cut = MAX_LEN;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function inWindow() {
  const st = await prisma.assistantState.findUnique({ where: { id: 1 } });
  return !!(st?.lastInboundAt && Date.now() - st.lastInboundAt.getTime() < 23.5 * 3600 * 1000);
}

// Send a message to Julio only — the assistant never WhatsApps anyone else.
// Inside the 24h customer-service window free text is allowed; outside it
// WhatsApp requires an approved template, so the text goes in as {{1}}.
async function sendToOwner(text, { kind = 'out', sessionId = null } = {}) {
  if (!client) throw new Error('Twilio is not configured');
  const base = { to: `whatsapp:${cfg.ownerPhone}` };
  if (cfg.waFrom) base.from = cfg.waFrom; else base.messagingServiceSid = MSG_SERVICE;

  const free = await inWindow();
  const parts = chunks(text);
  if (!free && cfg.waTemplateSid) {
    // Templates take one short variable; send the first chunk, the rest
    // becomes available once Julio replies (which reopens the window).
    const first = parts[0].slice(0, 1000);
    await client.messages.create({ ...base, contentSid: cfg.waTemplateSid, contentVariables: JSON.stringify({ 1: first }) });
  } else {
    for (const body of parts) await client.messages.create({ ...base, body });
  }
  await prisma.assistantEvent.create({ data: { direction: kind, text: String(text).slice(0, 10000), sessionId } }).catch(() => {});
}

// Twilio signs every webhook; reject anything that isn't from Twilio.
function validTwilioRequest(req) {
  if (!TOKEN) return false;
  const signature = req.get('X-Twilio-Signature') || '';
  const url = cfg.publicUrl + req.originalUrl;
  return twilio.validateRequest(TOKEN, signature, url, req.body || {});
}

// Downloads media (voice notes, photos) from Twilio — requires basic auth.
async function fetchMedia(url) {
  const res = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64') } });
  if (!res.ok) throw new Error(`media ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
}

module.exports = { sendToOwner, validTwilioRequest, fetchMedia, chunks };
