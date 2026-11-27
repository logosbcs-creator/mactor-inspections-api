// Messages between Mac and third parties (suppliers, clients, crew) on Julio's
// behalf. Outbound only ever runs after Julio confirms a send_message action.
// Inbound replies are logged and forwarded to Julio; they never start an agent
// turn on their own (third-party text is data, not instructions).
const prisma = require('../services/database');
const { toE164, sendSms } = require('../services/sms');
const cfg = require('./config');
const { client, waBase, chunks, sendToOwner } = require('./whatsapp');

const WINDOW_MS = 23.5 * 3600 * 1000;

async function lastInbound(phone) {
  return prisma.assistantEvent.findFirst({
    where: { direction: 'contact_in', channel: 'whatsapp', meta: { path: ['phone'], equals: phone } },
    orderBy: { createdAt: 'desc' },
  });
}

async function knownName(phone) {
  const e = await prisma.assistantEvent.findFirst({
    where: { direction: { in: ['contact_out', 'contact_in'] }, meta: { path: ['phone'], equals: phone } },
    orderBy: { createdAt: 'desc' },
  });
  return e?.meta?.name || null;
}

const flat = s => String(s).replace(/\s*\n+\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim();

// WhatsApp to a third party. Inside the 24h window (they wrote to us) free text
// goes through; otherwise WhatsApp requires the approved contact template.
async function sendWhatsApp(rawPhone, text, { name, lang = 'es' } = {}) {
  if (!client) throw new Error('Twilio is not configured');
  const phone = toE164(rawPhone);
  if (phone === cfg.ownerPhone) throw new Error('Ese es el número de Julio');
  const base = { ...waBase(), to: `whatsapp:${phone}` };
  const last = await lastInbound(phone);
  let sids = [];
  if (last && Date.now() - last.createdAt.getTime() < WINDOW_MS) {
    for (const body of chunks(text)) sids.push((await client.messages.create({ ...base, body })).sid);
  } else {
    const sid = lang === 'en' ? cfg.waContactTemplateEn : cfg.waContactTemplateEs;
    if (!sid) throw new Error('La plantilla de WhatsApp para contactos todavía no está aprobada por Meta; mándalo por SMS');
    const body = flat(text);
    if (body.length > 900) throw new Error('Para un primer WhatsApp el mensaje debe tener menos de 900 caracteres');
    const greet = flat(name || (lang === 'en' ? 'there' : '')).slice(0, 60) || (lang === 'en' ? 'there' : 'buen día');
    sids.push((await client.messages.create({ ...base, contentSid: sid, contentVariables: JSON.stringify({ 1: greet, 2: body }) })).sid);
  }
  await log('contact_out', 'whatsapp', phone, text, { name, sids });
  return { phone, channel: 'whatsapp', template: !(last && Date.now() - last.createdAt.getTime() < WINDOW_MS) };
}

async function sendText(rawPhone, text, { name } = {}) {
  const phone = toE164(rawPhone);
  if (phone === cfg.ownerPhone) throw new Error('Ese es el número de Julio');
  await sendSms(phone, text);
  await log('contact_out', 'sms', phone, text, { name });
  return { phone, channel: 'sms' };
}

function log(direction, channel, phone, text, meta = {}) {
  return prisma.assistantEvent.create({
    data: { direction, channel, text: String(text || '').slice(0, 10000), meta: { phone, ...meta } },
  }).catch(err => console.error('[Assistant] contact log failed:', err.message));
}

// A WhatsApp from someone other than Julio: log it and forward it to him.
async function handleInbound(body, { saveImage } = {}) {
  const phone = String(body.From || '').replace(/^whatsapp:/, '');
  const text = (body.Body || '').trim();
  const name = (await knownName(phone)) || (body.ProfileName || '').trim() || null;
  const n = Number(body.NumMedia || 0);
  const photoIds = [];
  if (saveImage) {
    for (let i = 0; i < Math.min(n, 5); i++) {
      const type = body[`MediaContentType${i}`] || '';
      if (!/^image\//.test(type)) continue;
      const id = await saveImage(body[`MediaUrl${i}`], type, `De ${name || phone}`).catch(() => null);
      if (id) photoIds.push(id);
    }
  }
  await log('contact_in', 'whatsapp', phone, text || '(sin texto)', { name, media: n, photoIds, sid: body.MessageSid });
  const who = name ? `*${name}* (${phone})` : `*${phone}*`;
  const media = n ? `\n📎 ${n} archivo(s)${photoIds.length ? ' — fotos guardadas, Mac puede usarlas' : ''}` : '';
  await sendToOwner(`📩 WhatsApp de ${who}:\n${text ? `"${text.slice(0, 1200)}"` : '(sin texto)'}${media}\n\nDime si quieres que Mac le responda.`, { kind: 'system' });
  return { phone, name };
}

async function recent({ phone, limit = 20 } = {}) {
  const where = { direction: { in: ['contact_in', 'contact_out'] } };
  if (phone) where.meta = { path: ['phone'], equals: toE164(phone) };
  const rows = await prisma.assistantEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 50) });
  return rows.map(r => ({
    when: r.createdAt.toISOString(), direction: r.direction === 'contact_in' ? 'recibido' : 'enviado',
    channel: r.channel, phone: r.meta?.phone, name: r.meta?.name || null, text: r.text,
    photo_ids: r.meta?.photoIds?.length ? r.meta.photoIds : undefined,
  }));
}

module.exports = { sendWhatsApp, sendText, handleInbound, recent };
