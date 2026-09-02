const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('./database');

const SECRET   = process.env.JWT_SECRET   || 'mactor-secret-2026';
const USERNAME = process.env.ADMIN_USER   || 'julio';
const PASSWORD = process.env.ADMIN_PASS   || 'mactor2026';

if (process.env.NODE_ENV === 'production' &&
    (!process.env.JWT_SECRET || !process.env.ADMIN_USER || !process.env.ADMIN_PASS)) {
  console.error('[SECURITY] JWT_SECRET/ADMIN_USER/ADMIN_PASS are not set in production — ' +
    'falling back to hardcoded defaults. Set them in the environment.');
}

// Simple in-memory brute-force guard for the login endpoint. Not meant to
// survive restarts or scale across instances — just enough to stop a bot
// hammering the single admin account.
const MAX_ATTEMPTS  = 5;
const WINDOW_MS     = 15 * 60 * 1000;
const attemptsByIp  = new Map();

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const rec = attemptsByIp.get(ip);
  if (!rec || now > rec.resetAt) {
    attemptsByIp.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return true;
  }
  return rec.count < MAX_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const rec = attemptsByIp.get(ip);
  if (!rec || now > rec.resetAt) {
    attemptsByIp.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count++;
  }
}

function clearLoginAttempts(ip) {
  attemptsByIp.delete(ip);
}

// Until the first real account is created via the Users page, fall back to
// the single env-var admin account so a fresh deploy isn't locked out.
// Once any User row exists, only DB-backed accounts can log in.
async function login(username, password) {
  const userCount = await prisma.user.count();

  if (userCount === 0) {
    if (username !== USERNAME || password !== PASSWORD) return null;
    return jwt.sign({ user: username }, SECRET, { expiresIn: '30d' });
  }

  const user = await prisma.user.findUnique({ where: { username: String(username || '').trim().toLowerCase() } });
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  return jwt.sign({ user: user.username, uid: user.id }, SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, SECRET); }
  catch { return null; }
}

function authMiddleware(req, res, next) {
  const auth   = req.headers.authorization || '';
  const header = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const query  = req.query.token || null;
  const token  = header || query;
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = {
  login, verifyToken, authMiddleware,
  checkLoginRateLimit, recordFailedLogin, clearLoginAttempts,
};
