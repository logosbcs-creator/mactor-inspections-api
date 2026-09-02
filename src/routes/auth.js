const express = require('express');
const { login, checkLoginRateLimit, recordFailedLogin, clearLoginAttempts } = require('../services/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const ip = req.ip;
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  const { username, password } = req.body;
  const token = await login(username, password);
  if (!token) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  clearLoginAttempts(ip);
  res.json({ token });
});

module.exports = router;
