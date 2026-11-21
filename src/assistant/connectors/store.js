// Persistence + OAuth state helpers shared by the Gmail / Zoho / Meta connectors.
const crypto = require('crypto');
const prisma = require('../../services/database');
const { encrypt, decrypt } = require('../crypto');
const cfg = require('../config');

async function saveConnection({ provider, account, label, refreshToken, scopes, meta = {} }) {
  const data = { label, encRefreshToken: encrypt(refreshToken), scopes, meta, status: 'active', lastError: null };
  return prisma.assistantConnection.upsert({
    where: { provider_account: { provider, account } },
    create: { provider, account, ...data },
    update: data,
  });
}

async function getConnection(label) {
  const c = await prisma.assistantConnection.findFirst({ where: { label } });
  if (!c) throw new Error(`La cuenta "${label}" no está conectada todavía (conéctala en /invoices/asistente).`);
  return { ...c, refreshToken: decrypt(c.encRefreshToken) };
}

async function markError(id, err) {
  await prisma.assistantConnection.update({ where: { id }, data: { status: 'error', lastError: String(err).slice(0, 500) } }).catch(() => {});
}

// Signed, expiring `state` for OAuth redirects (CSRF protection).
function signState(obj) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + 15 * 60000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.encKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  const good = crypto.createHmac('sha256', cfg.encKey).update(body || '').digest('base64url');
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) throw new Error('bad state');
  const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (obj.exp < Date.now()) throw new Error('state expired');
  return obj;
}

const redirectUri = provider => `${cfg.publicUrl}/api/assistant/oauth/${provider}/callback`;

module.exports = { saveConnection, getConnection, markError, signState, verifyState, redirectUri };
