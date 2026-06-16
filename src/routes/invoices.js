const express = require('express');
const prisma   = require('../services/database');
const { authMiddleware }    = require('../services/auth');
const { generateInvoicePDF } = require('../services/pdf');
const { Resend } = require('resend');

const router  = express.Router();
const resend  = new Resend(process.env.RESEND_API_KEY);

// All invoice routes require auth
router.use(authMiddleware);

// ── Helpers ────────────────────────────────────────────────────

async function nextInvoiceNumber(type) {
  // Upsert counter row (id=1 always)
  const counter = await prisma.invoiceCounter.upsert({
    where:  { id: 1 },
    update: { lastNum: { increment: 1 } },
    create: { id: 1, lastNum: 200 },
  });
  const prefix = type === 'estimate' ? 'EST' : 'INV';
  return `${prefix}${String(counter.lastNum).padStart(4, '0')}`;
}

function calcTotals(lineItems) {
  const subtotal = lineItems.reduce((s, i) => s + Number(i.amount || 0), 0);
  const hst      = Math.round(subtotal * 0.13 * 100) / 100;
  const total    = Math.round((subtotal + hst) * 100) / 100;
  return { subtotal: Math.round(subtotal * 100) / 100, hst, total };
}

// ── Routes ────────────────────────────────────────────────────

// GET /api/invoices
router.get('/', async (req, res) => {
  const { type, status } = req.query;
  const where = {};
  if (type)   where.type   = type;
  if (status) where.status = status;
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, invoiceNumber: true, type: true, status: true,
      clientName: true, clientEmail: true,
      total: true, invoiceDate: true, sentAt: true, paidAt: true,
    },
  });
  res.json(invoices);
});

// POST /api/invoices
router.post('/', async (req, res) => {
  const { type = 'invoice', clientName, clientEmail, clientPhone,
          clientAddress, lineItems = [], notes, photos = [],
          invoiceDate, dueDate, inspectionId } = req.body;

  if (!clientName) return res.status(400).json({ error: 'clientName required' });

  const invoiceNumber = await nextInvoiceNumber(type);
  const { subtotal, hst, total } = calcTotals(lineItems);

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber, type,
      clientName, clientEmail, clientPhone, clientAddress,
      lineItems, notes, photos,
      subtotal, hst, total,
      invoiceDate: invoiceDate ? new Date(invoiceDate) : new Date(),
      dueDate:     dueDate || 'On Receipt',
      inspectionId,
    },
  });
  res.json(invoice);
});

// GET /api/invoices/:id
router.get('/:id', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  res.json(invoice);
});

// PUT /api/invoices/:id
router.put('/:id', async (req, res) => {
  const { lineItems, clientName, clientEmail, clientPhone, clientAddress,
          notes, photos, status, invoiceDate, dueDate } = req.body;

  const data = {};
  if (clientName)    data.clientName    = clientName;
  if (clientEmail)   data.clientEmail   = clientEmail;
  if (clientPhone)   data.clientPhone   = clientPhone;
  if (clientAddress) data.clientAddress = clientAddress;
  if (notes !== undefined) data.notes   = notes;
  if (photos)        data.photos        = photos;
  if (status)        data.status        = status;
  if (invoiceDate)   data.invoiceDate   = new Date(invoiceDate);
  if (dueDate)       data.dueDate       = dueDate;
  if (lineItems) {
    data.lineItems = lineItems;
    Object.assign(data, calcTotals(lineItems));
  }
  if (status === 'paid' && !data.paidAt) data.paidAt = new Date();

  const invoice = await prisma.invoice.update({
    where: { id: req.params.id },
    data,
  });
  res.json(invoice);
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res) => {
  await prisma.invoice.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// GET /api/invoices/:id/pdf  → returns PDF buffer
router.get('/:id/pdf', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Not found' });

  const pdf = await generateInvoicePDF(invoice);
  res.set({
    'Content-Type':        'application/pdf',
    'Content-Disposition': `inline; filename="${invoice.invoiceNumber}.pdf"`,
    'Content-Length':      pdf.length,
  });
  res.send(pdf);
});

// POST /api/invoices/:id/send  → email PDF to client
router.post('/:id/send', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  if (!invoice.clientEmail) return res.status(400).json({ error: 'No client email' });

  const pdf    = await generateInvoicePDF(invoice);
  const isEst  = invoice.type === 'estimate';
  const label  = isEst ? 'Estimate' : 'Invoice';

  await resend.emails.send({
    from:    `MACTOR Construction <inspector@fixmyproperty.ca>`,
    to:      [invoice.clientEmail],
    subject: `${label} ${invoice.invoiceNumber} — MACTOR Construction`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#0a0f1e;padding:24px 32px">
          <h1 style="color:#fff;margin:0;font-size:22px">MACTOR Construction</h1>
          <p style="color:#9ca3af;margin:4px 0 0">Professional Property Services · Toronto GTA</p>
        </div>
        <div style="padding:32px;background:#f9fafb">
          <p style="font-size:16px;color:#111">Dear <strong>${invoice.clientName}</strong>,</p>
          <p style="color:#374151">Please find your ${label.toLowerCase()} attached. Total amount due:
            <strong style="color:#e63946">CAD $${invoice.total.toFixed(2)}</strong></p>
          <div style="background:#fff;border-radius:8px;padding:20px;margin:20px 0;border:1px solid #e5e7eb">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${label.toUpperCase()} NUMBER</p>
            <p style="margin:0;font-size:20px;font-weight:700;color:#111">${invoice.invoiceNumber}</p>
          </div>
          <p style="color:#374151"><strong>Payment options:</strong><br>
            • PayPal: payments@mactor.ca<br>
            • Cheque: Mactor Construction or Julio Cesar Macias Aguilar</p>
          <p style="color:#6b7280;font-size:13px">Thank you for your business!</p>
        </div>
        <div style="background:#0a0f1e;padding:16px 32px;text-align:center">
          <p style="color:#6b7280;margin:0;font-size:12px">MACTOR Construction · 647-517-3343 · julio@mactor.ca</p>
        </div>
      </div>`,
    attachments: [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf }],
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data:  { sentAt: new Date(), status: invoice.status === 'draft' ? 'sent' : invoice.status },
  });

  res.json({ success: true });
});

module.exports = router;
