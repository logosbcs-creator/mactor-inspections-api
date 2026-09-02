const twilio = require('twilio');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN   || '';
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || '';

const client = ACCOUNT_SID && AUTH_TOKEN ? twilio(ACCOUNT_SID, AUTH_TOKEN) : null;

function smsConfigured() {
  return !!(client && MESSAGING_SERVICE_SID);
}

// Shares the Twilio Messaging Service already paying for RentMyTools' SMS —
// the message body always names "MacTor Construction" explicitly so the
// recipient knows who's texting them regardless of which brand the
// underlying Twilio number is registered under.
async function sendSms(to, body) {
  if (!smsConfigured()) throw new Error('SMS is not configured yet.');
  await client.messages.create({ to, messagingServiceSid: MESSAGING_SERVICE_SID, body });
}

module.exports = { sendSms, smsConfigured };
