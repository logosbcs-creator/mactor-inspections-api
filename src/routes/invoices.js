const express = require('express');
const multer  = require('multer');
const prisma   = require('../services/database');
const { authMiddleware }    = require('../services/auth');
const { generateInvoicePDF } = require('../services/pdf');
const { uploadPhoto }        = require('../services/cloudinary');
const { upsertCatalogItem }  = require('../services/catalog');
const { upsertClient }       = require('../services/clients');
const { Resend } = require('resend');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
    orderBy: { invoiceDate: 'desc' },
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

  const invDate = invoiceDate ? new Date(invoiceDate) : new Date();
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber, type,
      clientName, clientEmail, clientPhone, clientAddress,
      lineItems, notes, photos,
      subtotal, hst, total,
      invoiceDate: invDate,
      dueDate:     dueDate || 'On Receipt',
      inspectionId,
    },
  });

  // Feed client catalog
  upsertClient(
    { name: clientName, email: clientEmail, phone: clientPhone, address: clientAddress },
    invoiceNumber, type, total, 'draft', invDate
  ).catch(() => {});

  res.json(invoice);
});

// POST /api/invoices/upload-photo  → upload single photo to Cloudinary
router.post('/upload-photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await uploadPhoto(req.file.buffer, req.file.originalname, 'mactor-invoices');
    res.json({ url: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// POST /api/invoices/:id/convert  → create invoice from estimate
router.post('/:id/convert', async (req, res) => {
  const est = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!est) return res.status(404).json({ error: 'Not found' });
  if (est.type !== 'estimate') return res.status(400).json({ error: 'Not an estimate' });

  const invoiceNumber = await nextInvoiceNumber('invoice');
  const invDate = new Date();
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      type:          'invoice',
      status:        'draft',
      clientName:    est.clientName,
      clientEmail:   est.clientEmail,
      clientPhone:   est.clientPhone,
      clientAddress: est.clientAddress,
      lineItems:     est.lineItems,
      notes:         est.notes,
      photos:        est.photos,
      subtotal:      est.subtotal,
      hst:           est.hst,
      total:         est.total,
      invoiceDate:   invDate,
      dueDate:       est.dueDate || 'On Receipt',
    },
  });

  upsertClient(
    { name: est.clientName, email: est.clientEmail, phone: est.clientPhone, address: est.clientAddress },
    invoiceNumber, 'invoice', est.total, 'draft', invDate
  ).catch(() => {});

  res.json(invoice);
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res) => {
  await prisma.invoice.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// POST /api/invoices/import  → bulk import array of invoices
router.post('/import', async (req, res) => {
  const { invoices } = req.body;
  if (!Array.isArray(invoices) || invoices.length === 0)
    return res.status(400).json({ error: 'invoices array required' });

  const VALID_STATUSES = new Set(['draft', 'sent', 'paid', 'overdue']);
  const VALID_TYPES    = new Set(['invoice', 'estimate']);
  const results        = { created: 0, skipped: 0, errors: [] };
  const seenInBatch    = new Set();

  // Sort chronologically before inserting so DB order matches invoice dates
  const sorted = [...invoices].sort((a, b) =>
    new Date(a.invoiceDate || 0).getTime() - new Date(b.invoiceDate || 0).getTime()
  );

  for (const inv of sorted) {
    try {
      // ── Required fields ──────────────────────────────────────
      if (!inv.invoiceNumber || !String(inv.invoiceNumber).trim()) {
        results.errors.push({ invoiceNumber: '(missing)', error: 'invoiceNumber is required' });
        continue;
      }
      const invNum = String(inv.invoiceNumber).trim().toUpperCase();

      if (!inv.clientName || !String(inv.clientName).trim()) {
        results.errors.push({ invoiceNumber: invNum, error: 'clientName is required' });
        continue;
      }

      // ── Within-batch duplicate ───────────────────────────────
      if (seenInBatch.has(invNum)) {
        results.errors.push({ invoiceNumber: invNum, error: 'Duplicado en el batch — ignorado' });
        continue;
      }
      seenInBatch.add(invNum);

      // ── Already in DB ────────────────────────────────────────
      const exists = await prisma.invoice.findUnique({ where: { invoiceNumber: invNum } });
      if (exists) { results.skipped++; continue; }

      // ── Normalize type / status ──────────────────────────────
      const type   = VALID_TYPES.has(inv.type)     ? inv.type   : 'invoice';
      const status = VALID_STATUSES.has(inv.status) ? inv.status : 'sent';

      // ── Line items — recalculate amount if missing ───────────
      const lineItems = (inv.lineItems || []).map(item => {
        const rate   = Number(item.rate)   || 0;
        const qty    = Number(item.qty)    || 1;
        const amount = Number(item.amount) || Math.round(rate * qty * 100) / 100;
        return {
          description: item.description || '',
          notes:       item.notes       || null,
          rate, qty, amount,
        };
      });

      // ── Totals ───────────────────────────────────────────────
      const subtotal = Number(inv.subtotal) || lineItems.reduce((s, i) => s + i.amount, 0);
      const hst      = Number(inv.hst)      || Math.round(subtotal * 0.13 * 100) / 100;
      const total    = Number(inv.total)    || Math.round((subtotal + hst) * 100) / 100;

      // ── Dates ────────────────────────────────────────────────
      const invoiceDate = inv.invoiceDate ? new Date(inv.invoiceDate) : new Date();
      const sentAt      = (status === 'sent' || status === 'paid') ? invoiceDate : null;
      const paidAt      = status === 'paid' ? invoiceDate : null;

      await prisma.invoice.create({
        data: {
          invoiceNumber: invNum,
          type, status,
          clientName:    String(inv.clientName).trim(),
          clientEmail:   inv.clientEmail   || null,
          clientPhone:   inv.clientPhone   || null,
          clientAddress: inv.clientAddress || null,
          lineItems, subtotal, hst, total,
          notes:         inv.notes         || null,
          invoiceDate,
          dueDate:       inv.dueDate       || 'On Receipt',
          sentAt, paidAt,
        },
      });
      results.created++;

      // ── Feed client catalog ──────────────────────────────────────
      await upsertClient(
        { name: String(inv.clientName).trim(), email: inv.clientEmail, phone: inv.clientPhone, address: inv.clientAddress },
        invNum, type, total, status, invoiceDate
      );

      // ── Extract sub-items into service catalog (estimates only) ──
      if (type === 'estimate') {
        for (const item of lineItems) {
          if (Array.isArray(item.subItems)) {
            for (const sub of item.subItems) {
              await upsertCatalogItem(sub, invNum, String(inv.clientName).trim(), invoiceDate);
            }
          }
        }
      }
    } catch (err) {
      results.errors.push({ invoiceNumber: inv.invoiceNumber || '?', error: err.message });
    }
  }

  // Update shared counter to max number seen in this batch
  const nums = [...seenInBatch]
    .map(n => parseInt(n.replace(/\D/g, '')) || 0)
    .filter(n => n > 0);
  if (nums.length > 0) {
    const maxNum = Math.max(...nums);
    await prisma.invoiceCounter.upsert({
      where:  { id: 1 },
      update: { lastNum: { set: Math.max(maxNum, 199) } },
      create: { id: 1, lastNum: Math.max(maxNum, 199) },
    });
  }

  res.json({ success: true, ...results });
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
