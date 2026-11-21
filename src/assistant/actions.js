// Confirm-before-act. The agent can only PROPOSE an action; this module
// stores it, asks Julio on WhatsApp, and executes it in code after he
// replies "sí". The model never holds a path to execute anything directly,
// so a prompt injection in an email can at most produce a proposal Julio sees.
const prisma = require('../services/database');
const { signServiceToken } = require('../services/auth');
const cfg = require('./config');
const { sendToOwner } = require('./whatsapp');
const email = require('./connectors/email');

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

// Strict: the whole message must be just the word plus an optional "#N".
// Anything longer ("para mañana agéndame…") goes to the agent instead.
const YES = /^(s[ií]|si|yes|ok|okay|dale|confirmo|confirmado|adelante|hazlo|env[ií]alo)(\s*#?\s*(\d+))?$/i;
const NO = /^(no|cancela|cancelar|cancelalo|cancélalo)(\s*#?\s*(\d+))?$/i;

// If the inbound WhatsApp text is a yes/no about a pending action, handle it
// and return true; otherwise return false so it goes to the agent.
async function handleConfirmation(text) {
  const t = String(text || '').trim().replace(/^[¡¿]+|[!.,?]+$/g, '').trim();
  const y = t.match(YES), n = y ? null : t.match(NO);
  if (!y && !n) return false;
  const yes = !!y, no = !!n;

  await expireOld();
  const num = (y || n)[3];
  const pending = await prisma.assistantAction.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } });
  if (!pending.length) return false;

  let action;
  if (num) action = pending.find(a => a.shortCode === Number(num));
  else if (pending.length === 1) action = pending[0];
  else {
    await sendToOwner(`Tengo ${pending.length} acciones pendientes (${pending.map(a => '#' + a.shortCode).join(', ')}). Dime cuál, ej: *sí ${pending[0].shortCode}*`, { kind: 'system' });
    return true;
  }
  if (!action) {
    await sendToOwner(`No encuentro la acción #${num} pendiente (puede haber vencido).`, { kind: 'system' });
    return true;
  }

  if (no) {
    await prisma.assistantAction.update({ where: { id: action.id }, data: { status: 'cancelled' } });
    await sendToOwner(`❌ Acción #${action.shortCode} cancelada.`, { kind: 'system' });
    return true;
  }
  await execute(action);
  return true;
}

async function execute(action) {
  // Claim it atomically so a double "sí" can't run it twice.
  const claimed = await prisma.assistantAction.updateMany({ where: { id: action.id, status: 'pending' }, data: { status: 'running' } });
  if (!claimed.count) return;
  try {
    const result = await KINDS[action.kind].run(action.payload || {});
    await prisma.assistantAction.update({ where: { id: action.id }, data: { status: 'executed', executedAt: new Date(), result: result ?? {} } });
    await sendToOwner(`✅ Listo — acción #${action.shortCode} ejecutada.`, { kind: 'system' });
  } catch (err) {
    await prisma.assistantAction.update({ where: { id: action.id }, data: { status: 'failed', result: { error: err.message } } });
    await sendToOwner(`⚠️ La acción #${action.shortCode} falló: ${err.message}`, { kind: 'system' });
  }
}

async function recent(limit = 10) {
  const rows = await prisma.assistantAction.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map(a => ({ id: a.shortCode, kind: a.kind, status: a.status, summary: a.summary, created: a.createdAt, result: a.result }));
}

module.exports = { propose, handleConfirmation, execute, recent, KIND_NAMES };
