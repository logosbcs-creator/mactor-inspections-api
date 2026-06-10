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
  const { Resend } = require('resend');
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.EMAIL_TO;
  const from   = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  const appUrl = process.env.APP_URL;

  if (!apiKey) return res.json({ ok: false, error: 'RESEND_API_KEY not set', to: !!to, appUrl });

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: `Inspector Mactor Debug <${from}>`,
      to: to || 'mactor.maintenance@gmail.com',
      subject: '✅ Railway email test — Inspector Mactor (Resend)',
      text: `Email working via Resend from Railway!\nAPP_URL=${appUrl}\nEMAIL_TO=${to}`,
    });
    if (error) return res.json({ ok: false, error: error.message, apiKey: !!apiKey, to: !!to });
    res.json({ ok: true, id: data?.id, sentTo: to, from, appUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message, apiKey: !!apiKey });
  }
});

app.use((err, req, res, _next) => {
  console.error('API Error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MacTor Inspections API running on port ${PORT}`);
});
