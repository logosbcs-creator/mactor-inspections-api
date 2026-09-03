const express = require('express');
const { sendSms } = require('../services/sms');

const router = express.Router();

// POST /api/sms/incoming — Twilio's inbound-message webhook (set as the
// "A message comes in" URL on the shared Messaging Service). This number
// is shared with RentMyTools, so a reply could be about either business —
// the From number is included so Julio can tell which. Just relays to his
// own phone; doesn't try to match it to a specific client/job.
router.post('/', async (req, res) => {
  const from = req.body.From || 'unknown';
  const body = req.body.Body || '';

  try {
    await sendSms('6475173343', `Reply from ${from}: ${body}`);
  } catch (err) {
    console.error('[SMS Incoming] Failed to relay reply:', err.message);
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

module.exports = router;
