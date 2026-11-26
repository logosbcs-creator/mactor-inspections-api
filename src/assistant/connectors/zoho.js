// Zoho Mail (the shared business mailbox + its mactor.ca / rentmytools.ca aliases).
// The org lives in Zoho's Canadian datacenter, so every URL is *.zohocloud.ca.
// Register a "Server-based Application" at https://api-console.zohocloud.ca
// with redirect URI <PUBLIC_API_URL>/api/assistant/oauth/zoho/callback.
const { getConnection, markError, redirectUri } = require('./store');

const ACCOUNTS = 'https://accounts.zohocloud.ca';
const API = 'https://mail.zohocloud.ca/api';
const SCOPES = 'ZohoMail.messages.ALL,ZohoMail.accounts.READ,ZohoMail.folders.READ';

const tokenCache = new Map(); // connection id → { token, exp }

function creds() {
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) throw new Error('ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET not set');
  return { id: ZOHO_CLIENT_ID, secret: ZOHO_CLIENT_SECRET };
}

function authUrl(state) {
  const p = new URLSearchParams({
    scope: SCOPES, client_id: creds().id, response_type: 'code', access_type: 'offline',
    prompt: 'consent', redirect_uri: redirectUri('zoho'), state,
  });
  return `${ACCOUNTS}/oauth/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const { id, secret } = creds();
  const res = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Zoho token: ${data.error || res.status}`);
  return data;
}

async function call(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoho ${res.status}: ${data?.data?.errorCode || data?.status?.description || ''}`);
  return data.data;
}

async function exchangeCode(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri('zoho') });
  if (!t.refresh_token) throw new Error('Zoho did not return a refresh token');
  const accounts = await call(t.access_token, '/accounts');
  const acct = accounts[0];
  return {
    account: acct.primaryEmailAddress || acct.mailboxAddress,
    refreshToken: t.refresh_token, scopes: SCOPES,
    meta: { accountId: acct.accountId, aliases: (acct.emailAddress || []).map(e => e.mailId) },
  };
}

async function session(label) {
  const conn = await getConnection(label);
  const cached = tokenCache.get(conn.id);
  if (cached && cached.exp > Date.now()) return { conn, token: cached.token };
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refreshToken });
    tokenCache.set(conn.id, { token: t.access_token, exp: Date.now() + (t.expires_in - 120) * 1000 });
    return { conn, token: t.access_token };
  } catch (err) { await markError(conn.id, err.message); throw err; }
}

const row = (label, m) => ({
  account: label, id: m.messageId, folderId: m.folderId, from: m.fromAddress || m.sender, to: m.toAddress,
  subject: m.subject, date: m.receivedTime ? new Date(Number(m.receivedTime)).toISOString() : undefined,
  snippet: m.summary, unread: m.status === '0' || m.status2 === '0',
});

// `q` is free text; "unread" lists unread messages instead of searching.
async function search(label, q, max = 10) {
  const { conn, token } = await session(label);
  const id = conn.meta.accountId;
  const limit = Math.min(max, 25);
  const list = q === 'unread'
    ? await call(token, `/accounts/${id}/messages/view?status=unread&limit=${limit}`)
    : await call(token, `/accounts/${id}/messages/search?searchKey=${encodeURIComponent(`entire:${q}`)}&limit=${limit}`);
  return (list || []).map(m => row(label, m));
}

async function read(label, messageId, folderId) {
  const { conn, token } = await session(label);
  const id = conn.meta.accountId;
  const content = await call(token, `/accounts/${id}/folders/${folderId}/messages/${messageId}/content`);
  const html = content?.content || '';
  return {
    account: label, id: messageId, folderId,
    body: html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 12000),
  };
}

// Zoho needs attachments uploaded first; the send call then references them.
async function uploadAttachment(token, accountId, a) {
  const form = new FormData();
  form.append('attach', new Blob([a.content], { type: a.mime }), a.filename);
  const res = await fetch(`${API}/accounts/${accountId}/messages/attachments?uploadType=multipart`, {
    method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoho attachment ${res.status}: ${data?.data?.errorCode || ''}`);
  const d = Array.isArray(data.data) ? data.data[0] : data.data;
  return { storeName: d.storeName, attachmentPath: d.attachmentPath, attachmentName: d.attachmentName };
}

async function send(label, { to, cc, subject, body, from, replyToMessageId, attachments = [] }) {
  const { conn, token } = await session(label);
  const id = conn.meta.accountId;
  const payload = { fromAddress: from || conn.account, toAddress: to, ccAddress: cc, subject, content: body, mailFormat: 'plaintext' };
  if (attachments.length) payload.attachments = await Promise.all(attachments.map(a => uploadAttachment(token, id, a)));
  const path = replyToMessageId ? `/accounts/${id}/messages/${replyToMessageId}` : `/accounts/${id}/messages`;
  if (replyToMessageId) payload.action = 'reply';
  const data = await call(token, path, { method: 'POST', body: JSON.stringify(payload) });
  return { id: data?.messageId };
}

module.exports = { authUrl, exchangeCode, search, read, send };
