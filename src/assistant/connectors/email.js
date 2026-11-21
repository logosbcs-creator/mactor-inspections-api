// One email interface over all of Julio's mailboxes, addressed by label:
//   gmail_logos  → personal Gmail
//   gmail_mactor → MacTor Construction Gmail
//   zoho         → Zoho business mailbox (fixmyproperty.ca + mactor.ca / rentmytools.ca aliases)
// The real address of each is whatever account was connected via OAuth.
const prisma = require('../../services/database');
const gmail = require('./gmail');
const zoho = require('./zoho');

const ACCOUNTS = {
  gmail_logos: { provider: 'gmail', impl: gmail, hint: 'Gmail personal de Julio' },
  gmail_mactor: { provider: 'gmail', impl: gmail, hint: 'Gmail de MacTor Construction' },
  zoho: { provider: 'zoho', impl: zoho, hint: 'Zoho: FixMyProperty / MacTor / RentMyTools (aliases)' },
};
const LABELS = Object.keys(ACCOUNTS);

function impl(label) {
  const a = ACCOUNTS[label];
  if (!a) throw new Error(`Cuenta desconocida "${label}". Usa: ${LABELS.join(', ')}`);
  return a.impl;
}

async function connected() {
  const rows = await prisma.assistantConnection.findMany({ where: { provider: { in: ['gmail', 'zoho'] } } });
  return LABELS.map(label => {
    const r = rows.find(x => x.label === label);
    return {
      label, mailbox: ACCOUNTS[label].hint, address: r?.account, connected: !!r,
      status: r?.status, error: r?.lastError || undefined,
    };
  });
}

// Gmail takes Gmail search syntax; Zoho takes free text or "unread".
async function search(label, q, max) {
  if (label === 'zoho' && /\bis:unread\b/.test(q)) q = 'unread';
  return impl(label).search(label, q, max);
}

const read = (label, id, folderId) => impl(label).read(label, id, folderId);

// Called only by actions.js after Julio confirms.
async function send({ account, to, cc, subject, body, threadId, inReplyTo, replyToMessageId, from }) {
  if (!to || !subject || !body) throw new Error('to, subject y body son obligatorios');
  return impl(account).send(account, { to, cc, subject, body, threadId, inReplyTo, replyToMessageId, from });
}

// Drafts don't leave the mailbox, so they don't need confirmation (Gmail only).
async function draft({ account, ...msg }) {
  if (ACCOUNTS[account]?.provider !== 'gmail') throw new Error('Los borradores solo están disponibles en Gmail');
  return gmail.draft(account, msg);
}

// Unread, non-promotional mail from the last `hours` across every mailbox.
async function digest(hours = 24) {
  const out = [];
  for (const c of await connected()) {
    if (!c.connected) continue;
    try {
      const q = c.label === 'zoho' ? 'unread' : `is:unread newer_than:${Math.max(1, Math.ceil(hours / 24))}d -category:promotions -category:social -category:forums`;
      out.push(...await search(c.label, q, 15));
    } catch (err) {
      out.push({ account: c.label, error: err.message });
    }
  }
  return out;
}

module.exports = { LABELS, ACCOUNTS, connected, search, read, send, draft, digest };
