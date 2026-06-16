const jwt = require('jsonwebtoken');

const SECRET   = process.env.JWT_SECRET   || 'mactor-secret-2026';
const USERNAME = process.env.ADMIN_USER   || 'julio';
const PASSWORD = process.env.ADMIN_PASS   || 'mactor2026';

function login(username, password) {
  if (username !== USERNAME || password !== PASSWORD) return null;
  return jwt.sign({ user: username }, SECRET, { expiresIn: '30d' });
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

module.exports = { login, verifyToken, authMiddleware };
