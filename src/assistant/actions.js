// Confirm-before-act. The agent can only PROPOSE an action; this module
// stores it, asks Julio on WhatsApp, and executes it in code after he
// replies "sí". The model never holds a path to execute anything directly,
// so a prompt injection in an email can at most produce a proposal Julio sees.
const prisma = require('../services/database');
const { signServiceToken } = require('../services/auth');
const cfg = require('./config');
const { sendToOwner } = require('./whatsapp');
const email = require('./connectors/email');
const { upsertCatalogItem } = require('../services/catalog');

const PORT = process.env.PORT || 3002;

// Calls this API's own admin routes so actions behave exactly like the
// buttons in /invoices (same validation, SendLog rows, translation…).
async function selfApi(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signServiceToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// kind → { validate(payload) → error|null, run(payload) → result }
const KINDS = {
  payment_reminder: {
    run: p => selfApi('POST', `/api/invoices/${p.invoiceId}/payment-reminder`, { phone: p.phone, message: p.message }),
  },
  job_reminder: {
    run: p => selfApi('POST', `/api/invoices/${p.invoiceId}/remind`, {
      sendEmail: !!p.sendEmail, email: p.email, sendSms: !!p.sendSms, phone: p.phone,
    }),
  },
  send_document: {
    run: p => selfApi('POST', `/api/invoices/${p.invoiceId}/send`, {
      sendEmail: p.sendEmail !== false, email: p.email, sms: !!p.sms, phone: p.phone, bcc: !!p.bcc,
    }),
  },
  create_task: {
    run: async p => {
      const inv = await selfApi('POST', '/api/invoices', {
        type: 'task', clientName: p.clientName, clientPhone: p.clientPhone, clientEmail: p.clientEmail,
        clientAddress: p.clientAddress, scheduledDate: p.scheduledDate,
        lineItems: [{ description: p.description, rate: 0, qty: 1, amount: 0 }],
      });
      return { id: inv.id, number: inv.invoiceNumber };
    },
  },
  send_email: {
    run: p => email.send(p),
  },

  // New estimate or invoice (draft), optionally sent right away.
  create_document: {
    run: async p => {
      const doc = await selfApi('POST', '/api/invoices', {
        type: p.type, clientName: p.clientName, companyName: p.companyName, clientEmail: p.clientEmail,
        clientPhone: p.clientPhone, clientAddress: p.clientAddress, lineItems: p.lineItems,
        notes: p.notes, discount: p.discount || 0, hstEnabled: p.hstEnabled !== false,
        dueDate: p.dueDate, scheduledDate: p.scheduledDate, nickname: p.nickname,
        photos: p.photos || [],
      });
      // Feed the price catalog so Mac (and the admin UI) learn from it.
      for (const l of p.lineItems || []) {
        await upsertCatalogItem(
          { name: l.description, price: l.rate, unit: l.unit || 'lump sum', description: l.notes || null },
          doc.invoiceNumber, p.clientName, new Date(),
        ).catch(() => {});
      }
      let sent = null;
      if (p.send && (p.send.email || p.send.sms)) {
        sent = await selfApi('POST', `/api/invoices/${doc.id}/send`, {
          sendEmail: !!p.send.email, email: p.clientEmail, sms: !!p.send.sms, phone: p.clientPhone,
        });
      }
      return { id: doc.id, number: doc.invoiceNumber, total: doc.total, sent };
    },
    done: r => `${r.number} creado (CAD $${Number(r.total).toFixed(2)})${r.sent ? ' y enviado' : ''}. Ver: https://inspector.fixmyproperty.ca/invoices/${r.id}`,
  },
  update_document: {
    run: async p => {
      const changes = { ...(p.changes || {}) };
      // Photos are merged at execution time, so several pending proposals for
      // the same document never overwrite each other.
      if (p.addPhotos?.length || p.removeAllPhotos) {
        const cur = await prisma.invoice.findUnique({ where: { id: p.invoiceId }, select: { photos: true } });
        const have = p.removeAllPhotos ? [] : (cur?.photos || []);
        const urls = new Set(have.map(x => (typeof x === 'string' ? x : x.url)));
        changes.photos = [...have, ...(p.addPhotos || []).filter(x => !urls.has(x.url))];
      }
      const d = await selfApi('PUT', `/api/invoices/${p.invoiceId}`, changes);
      return { id: d.id, number: d.invoiceNumber, total: d.total, photos: Array.isArray(d.photos) ? d.photos.length : undefined };
    },
    done: r => `${r.number} actualizado (total CAD $${Number(r.total).toFixed(2)}${r.photos !== undefined ? `, ${r.photos} fotos` : ''}).`,
  },
  convert_document: {
    run: p => selfApi('POST', `/api/invoices/${p.invoiceId}/convert`).then(d => ({ id: d.id, number: d.invoiceNumber, total: d.total })),
    done: r => `Creado ${r.number} (borrador, CAD $${Number(r.total).toFixed(2)}). Ver: https://inspector.fixmyproperty.ca/invoices/${r.id}`,
  },
  mark_paid: {
    run: p => selfApi('PUT', `/api/invoices/${p.invoiceId}`, { status: 'paid' }).then(d => ({ number: d.invoiceNumber })),
    done: r => `${r.number} marcada como pagada.`,
  },
  create_client: {
    run: async p => {
      const dupe = await prisma.client.findFirst({ where: { name: { equals: p.name.trim(), mode: 'insensitive' } } });
      if (dupe) throw new Error(`Ya existe un cliente llamado "${dupe.name}"`);
      const c = await prisma.client.create({ data: {
        name: p.name.trim(), email: p.email || null, phone: p.phone || null, address: p.address || null, notes: p.notes || null,
      } });
      return { name: c.name };
    },
    done: r => `Cliente "${r.name}" creado.`,
  },
  update_client: {
    run: async p => {
      const c = await prisma.client.findFirst({ where: { name: { equals: p.name.trim(), mode: 'insensitive' } } });
      if (!c) throw new Error(`No encuentro el cliente "${p.name}"`);
      const data = {};
      for (const k of ['email', 'phone', 'address', 'notes']) if (p[k] !== undefined) data[k] = p[k] || null;
      await prisma.client.update({ where: { id: c.id }, data });
      return { name: c.name };
    },
    done: r => `Cliente "${r.name}" actualizado.`,
  },
  create_catalog_item: {
    run: p => selfApi('POST', '/api/catalog', p).then(s => ({ name: s.name })),
    done: r => `Servicio "${r.name}" agregado al catálogo.`,
  },
  update_catalog_item: {
    run: async p => {
      const s = await prisma.serviceCatalog.findFirst({ where: { name: { equals: p.name, mode: 'insensitive' } } });
      if (!s) throw new Error(`No encuentro el servicio "${p.name}" en el catálogo`);
      await selfApi('PATCH', `/api/catalog/${s.id}`, p.changes);
      return { name: s.name };
    },
    done: r => `Servicio "${r.name}" actualizado en el catálogo.`,
  },
};

const KIND_NAMES = Object.keys(KINDS);

async function propose({ kind, summary, payload, sessionId }) {
  if (!KINDS[kind]) throw new Error(`Unknown action kind: ${kind}`);
  const action = await prisma.assistantAction.create({ data: { kind, summary, payload, sessionId } });
  await sendToOwner(
    `🟡 *Acción #${action.shortCode}* — necesito tu OK\n\n${summary}\n\nResponde *sí ${action.shortCode}* para ejecutar o *no ${action.shortCode}* para cancelar (vence en ${cfg.actionTtlMinutes} min).`,
    { kind: 'system', sessionId },
  );
  return { actionId: action.shortCode, status: 'pending_confirmation' };
}

async function expireOld() {
  await prisma.assistantAction.updateMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - cfg.actionTtlMinutes * 60000) } },
    data: { status: 'expired' },
  });
}

// Strict: the whole message must be the word plus optional action numbers:
// "sí", "sí 12", "si12", "sí 9 a 14", "sí 9-14", "sí 9, 10 y 12", "sí a todas".
// Anything else ("sí, pero cambia…", "para mañana…") goes to the agent.
const YES_W = '(?:s[ií]|yes|ok|okay|dale|confirmo|confirmado|adelante|hazlo|env[ií]alo|apl[ií]calo|aplica)';
const NO_W = '(?:no|cancela|cancelar|cancelalo|canc[eé]lalo|cancelalas|canc[eé]lalas)';
const LEAD = new RegExp(`^(${YES_W}|${NO_W})(?=$|[\\s#\\d,:;])(.*)$`, 'i');
const IS_YES = new RegExp(`^${YES_W}$`, 'i');

function parseDecision(text) {
  const t = String(text || '').trim().replace(/^[¡¿]+|[!.?]+$/g, '').trim();
  const m = t.match(LEAD);
  if (!m) return null;
  const yes = IS_YES.test(m[1]);
  const rest = m[2].trim().replace(/^[,:;]\s*/, '');
  if (!rest) return { yes, codes: null };
  if (/^(a\s+)?(tod[oa]s?|all)$/i.test(rest)) return { yes, codes: 'all' };
  const parts = rest.replace(/#/g, ' ').split(/(\d+)/); // [sep, num, sep, num, …, sep]
  if (parts.length < 3 || parts[0].trim() || parts[parts.length - 1].trim()) return null;
  const codes = [];
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    const sep = i > 1 ? parts[i - 1].trim().toLowerCase() : '';
    if (i > 1 && /^[,;]?\s*(a|al|hasta|to|-|–)$/.test(sep)) {
      const from = codes[codes.length - 1];
      if (n < from || n - from > 30) return null;
      for (let k = from + 1; k <= n; k++) codes.push(k);
    } else if (i === 1 || /^([,;]|y|e|and|,\s*y)?$/.test(sep)) {
      codes.push(n);
    } else return null;
  }
  return { yes, codes: [...new Set(codes)] };
}

// If the inbound WhatsApp text is a yes/no about a pending action, handle it
// and return true; otherwise return false so it goes to the agent.
// Returns false if the text isn't a confirmation; otherwise a short note of
// what happened (passed to the agent so it knows what Julio approved).
async function handleConfirmation(text) {
  const d = parseDecision(text);
  if (!d) return false;

  await expireOld();
  const pending = await prisma.assistantAction.findMany({ where: { status: 'pending' }, orderBy: { shortCode: 'asc' } });
  if (!pending.length) return false;

  let chosen;
  if (d.codes === 'all') chosen = pending;
  else if (!d.codes) {
    if (pending.length === 1) chosen = pending;
    else {
      await sendToOwner(`Tengo ${pending.length} acciones pendientes (${pending.map(a => '#' + a.shortCode).join(', ')}). Dime cuáles, ej: *sí ${pending[0].shortCode}* o *sí a todas*`, { kind: 'system' });
      return 'Julio respondió sin número y hay varias acciones pendientes; se le pidió cuáles.';
    }
  } else {
    chosen = pending.filter(a => d.codes.includes(a.shortCode));
    const missing = d.codes.filter(c => !chosen.some(a => a.shortCode === c));
    if (missing.length) await sendToOwner(`No encuentro pendiente(s): ${missing.map(c => '#' + c).join(', ')} (pueden haber vencido o ya estar hechas).`, { kind: 'system' });
    if (!chosen.length) return `Julio respondió a ${missing.map(c => '#' + c).join(', ')}, pero no estaban pendientes.`;
  }

  const lines = [];
  for (const action of chosen) {
    if (d.yes) lines.push(await execute(action, { quiet: true }));
    else {
      await prisma.assistantAction.update({ where: { id: action.id }, data: { status: 'cancelled' } });
      lines.push(`❌ #${action.shortCode} cancelada.`);
    }
  }
  const msg = lines.filter(Boolean).join('\n');
  if (msg) await sendToOwner(msg, { kind: 'system' });
  return `Julio ${d.yes ? 'confirmó' : 'canceló'} desde WhatsApp: ${msg.replace(/\n/g, ' · ')}`;
}

async function execute(action, { quiet = false } = {}) {
  // Claim it atomically so a double "sí" can't run it twice.
  const claimed = await prisma.assistantAction.updateMany({ where: { id: action.id, status: 'pending' }, data: { status: 'running' } });
  if (!claimed.count) return null;
  let line;
  try {
    const result = await KINDS[action.kind].run(action.payload || {});
    await prisma.assistantAction.update({ where: { id: action.id }, data: { status: 'executed', executedAt: new Date(), result: result ?? {} } });
    const detail = KINDS[action.kind].done ? ` ${KINDS[action.kind].done(result)}` : '';
    line = `✅ #${action.shortCode} ejecutada.${detail}`;
  } catch (err) {
    await prisma.assistantAction.update({ where: { id: action.id }, data: { status: 'failed', result: { error: err.message } } });
    line = `⚠️ #${action.shortCode} falló: ${err.message}`;
  }
  if (!quiet) await sendToOwner(line, { kind: 'system' });
  return line;
}

async function recent(limit = 10) {
  const rows = await prisma.assistantAction.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map(a => ({ id: a.shortCode, kind: a.kind, status: a.status, summary: a.summary, created: a.createdAt, result: a.result }));
}

module.exports = { propose, handleConfirmation, execute, recent, KIND_NAMES, parseDecision };
