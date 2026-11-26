// Gmail (Julio's personal and MacTor Construction Gmail accounts) via the Gmail API.
// Requires a Google Cloud OAuth client (Web application) whose redirect URI is
// <PUBLIC_API_URL>/api/assistant/oauth/google/callback, with the app published
// "In production" (Testing-mode refresh tokens expire after 7 days).
const { google } = require('googleapis');
const { getConnection, markError, redirectUri } = require('./store');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose', // drafts + send
];

function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri('google'));
}

function authUrl(state) {
  return oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}

async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token — remove the app at myaccount.google.com/permissions and retry');
  client.setCredentials(tokens);
  const profile = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
  return { account: profile.data.emailAddress, refreshToken: tokens.refresh_token, scopes: SCOPES.join(' ') };
}

async function api(label) {
  const conn = await getConnection(label);
  const client = oauthClient();
  client.setCredentials({ refresh_token: conn.refreshToken });
  return { gmail: google.gmail({ version: 'v1', auth: client }), conn };
}

const header = (msg, name) => (msg.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function bodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const part of payload.parts || []) {
    const t = bodyText(part);
    if (t) return t;
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8')
      .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

async function search(label, q, max = 10) {
  const { gmail, conn } = await api(label);
  try {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: Math.min(max, 25) });
    const ids = (list.data.messages || []).map(m => m.id);
    const msgs = await Promise.all(ids.map(id => gmail.users.messages.get({
      userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    })));
    return msgs.map(({ data: m }) => ({
      account: label, id: m.id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'),
      subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet,
      unread: (m.labelIds || []).includes('UNREAD'),
    }));
  } catch (err) { await markError(conn.id, err.message); throw err; }
}

async function read(label, id) {
  const { gmail } = await api(label);
  const { data: m } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return {
    account: label, id: m.id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'), cc: header(m, 'Cc'),
    subject: header(m, 'Subject'), date: header(m, 'Date'), messageIdHeader: header(m, 'Message-ID'),
    body: bodyText(m.payload).slice(0, 12000),
    attachments: (m.payload?.parts || []).filter(p => p.filename).map(p => p.filename),
  };
}

function rawMessage({ from, to, cc, subject, body, inReplyTo, attachments = [] }) {
  const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
  const headers = [
    from && `From: ${from}`, `To: ${to}`, cc && `Cc: ${cc}`, `Subject: ${enc(subject || '')}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`, inReplyTo && `References: ${inReplyTo}`, 'MIME-Version: 1.0',
  ].filter(Boolean);
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(body || ''))];
  let lines;
  if (!attachments.length) {
    lines = [...headers, ...textPart];
  } else {
    const boundary = `mac_${Date.now().toString(36)}`;
    lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...textPart];
    for (const a of attachments) {
      lines.push(`--${boundary}`, `Content-Type: ${a.mime}; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, 'Content-Transfer-Encoding: base64', '', b64(a.content));
    }
    lines.push(`--${boundary}--`);
  }
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function send(label, msg) {
  const { gmail, conn } = await api(label);
  const res = await gmail.users.messages.send({
    userId: 'me', requestBody: { raw: rawMessage({ ...msg, from: conn.account }), threadId: msg.threadId },
  });
  return { id: res.data.id, threadId: res.data.threadId };
}

async function draft(label, msg) {
  const { gmail, conn } = await api(label);
  const res = await gmail.users.drafts.create({
    userId: 'me', requestBody: { message: { raw: rawMessage({ ...msg, from: conn.account }), threadId: msg.threadId } },
  });
  return { draftId: res.data.id };
}

module.exports = { authUrl, exchangeCode, search, read, send, draft };
