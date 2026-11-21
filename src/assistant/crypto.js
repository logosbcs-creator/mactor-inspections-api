const crypto = require('crypto');
const cfg = require('./config');

function key() {
  if (!/^[0-9a-f]{64}$/i.test(cfg.encKey)) throw new Error('ASSISTANT_ENC_KEY must be 64 hex chars');
  return Buffer.from(cfg.encKey, 'hex');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// Constant-time string compare for bearer tokens.
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { encrypt, decrypt, safeEqual };
