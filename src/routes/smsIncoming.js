const express = require('express');
const twilio = require('twilio');
const { sendSms } = require('../services/sms');

const router = express.Router();
const PUBLIC_URL = (process.env.PUBLIC_API_URL || 'https://mactor-inspections-api-production.up.railway.app').replace(/\/$/, '');

// POST /api/sms/incoming — Twilio's inbound-message webhook (set as the
// "A message comes in" URL on the shared Messaging Service). This number
// is shared with RentMyTools, so a reply could be about either business —
// the From number is included so Julio can tell which. Just relays to his
// own phone; doesn't try to match it to a specific client/job.
router.post('/', async (req, res, next) => {
  // Only Twilio may hit this: it signs each request with the auth token.
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (token && !twilio.validateRequest(token, req.get('X-Twilio-Signature') || '', PUBLIC_URL + req.originalUrl, req.body || {})) {
    console.warn('[SMS Incoming] rejected request with bad Twilio signature');
    return res.status(403).send('Forbidden');
  }

  const from = req.body.From || 'unknown';
  const body = req.body.Body || '';

  // WhatsApp messages land here too when the WhatsApp sender belongs to the
  // shared Messaging Service — those go to the personal assistant instead.
  if (String(from).startsWith('whatsapp:')) {
    req.url = '/whatsapp';
    return require('../assistant/routes')(req, res, next);
  }

  try {
    await sendSms('6475173343', `Reply from ${from}: ${body}`);
  } catch (err) {
    console.error('[SMS Incoming] Failed to relay reply:', err.message);
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

module.exports = router;
