require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const inspectionRoutes = require('./routes/inspection');
const approveRoutes    = require('./routes/approve');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/inspection', inspectionRoutes);
app.use('/api/approve',    approveRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'mactor-inspections-api' }));

// Temporary email diagnostics endpoint
app.get('/debug/email', async (_, res) => {
  const nodemailer = require('nodemailer');
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const to   = process.env.EMAIL_TO;
  const appUrl = process.env.APP_URL;

  if (!user || !pass) {
    return res.json({ ok: false, error: 'EMAIL_USER or EMAIL_PASS not set', user: !!user, pass: !!pass, to: !!to, appUrl });
  }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });

  try {
    await transporter.verify();
    await transporter.sendMail({
      from: `"Inspector Mactor Debug" <${user}>`,
      to: to || user,
      subject: '✅ Railway email test — Inspector Mactor',
      text: `Email working from Railway!\nAPP_URL=${appUrl}\nEMAIL_TO=${to}`,
    });
    res.json({ ok: true, sentTo: to || user, appUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message, code: err.code, user: !!user, pass: !!pass });
  }
});

app.use((err, req, res, _next) => {
  console.error('API Error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MacTor Inspections API running on port ${PORT}`);
});
