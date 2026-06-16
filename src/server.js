require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const inspectionRoutes = require('./routes/inspection');
const approveRoutes    = require('./routes/approve');
const invoiceRoutes    = require('./routes/invoices');
const authRoutes       = require('./routes/auth');
const catalogRoutes    = require('./routes/catalog');
const clientRoutes     = require('./routes/clients');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/inspection', inspectionRoutes);
app.use('/api/approve',    approveRoutes);
app.use('/api/invoices',   invoiceRoutes);
app.use('/api/auth',       authRoutes);
app.use('/api/catalog',    catalogRoutes);
app.use('/api/clients',    clientRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'mactor-inspections-api' }));


app.use((err, req, res, _next) => {
  console.error('API Error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MacTor Inspections API running on port ${PORT}`);
});
