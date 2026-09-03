const express = require('express');
const multer  = require('multer');
const prisma   = require('../services/database');
const { authMiddleware }    = require('../services/auth');
const { generateInvoicePDF } = require('../services/pdf');
const { uploadPhoto }        = require('../services/cloudinary');
const { upsertCatalogItem }  = require('../services/catalog');
const { upsertClient, removeFromClient } = require('../services/clients');
const { sendSms, smsConfigured } = require('../services/sms');
const { toEnglish } = require('../services/translate');
const { nextInvoiceNumber } = require('../services/invoiceNumber');
const { Resend } = require('resend');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router  = express.Router();
const resend  = new Resend(process.env.RESEND_API_KEY);

// All invoice routes require auth
router.use(authMiddleware);

// ── Helpers ────────────────────────────────────────────────────

function calcTotals(lineItems, discount = 0, hstEnabled = true) {
  const subtotal = Math.round(lineItems.reduce((s, i) => s + Number(i.amount || 0), 0) * 100) / 100;
  const taxable  = Math.max(0, Math.round((subtotal - Number(discount || 0)) * 100) / 100);
  const hst      = hstEnabled ? Math.round(taxable * 0.13 * 100) / 100 : 0;
  const total    = Math.round((taxable + hst) * 100) / 100;
  return { subtotal, hst, total };
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
      clientName: true, companyName: true, clientEmail: true, clientPhone: true, clientAddress: true,
      total: true, invoiceDate: true, sentAt: true, paidAt: true, scheduledDate: true,
    },
  });
  res.json(invoices);
});

// POST /api/invoices
router.post('/', async (req, res) => {
  const { type = 'invoice', clientName, companyName, clientEmail, clientPhone,
          clientAddress, lineItems = [], notes, photos = [],
          invoiceDate, dueDate, inspectionId,
          discount = 0, hstEnabled = true, scheduledDate } = req.body;

  if (!clientName) return res.status(400).json({ error: 'clientName required' });

  // Quick tasks are often typed in Spanish for speed — the description
  // ends up client-facing (reminder, and later the estimate/invoice PDF
  // if converted), so translate it to English right at creation.
  if (type === 'task') {
    for (const item of lineItems) {
      if (item.description) item.description = await toEnglish(item.description);
    }
  }

  const invoiceNumber = await nextInvoiceNumber(type);
  const { subtotal, hst, total } = calcTotals(lineItems, discount, hstEnabled);

  const invDate = invoiceDate ? new Date(invoiceDate) : new Date();
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber, type,
      clientName, companyName, clientEmail, clientPhone, clientAddress,
      lineItems, notes, photos,
      subtotal, discount, hstEnabled, hst, total,
      invoiceDate: invDate,
      dueDate:     dueDate || 'On Receipt',
      inspectionId,
      scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
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

// GET /api/invoices/:id  → lookup by internal id, falling back to invoiceNumber
// (client history entries and old links reference the invoiceNumber, e.g. "INV0200")
router.get('/:id', async (req, res) => {
  let invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) {
    invoice = await prisma.invoice.findUnique({ where: { invoiceNumber: req.params.id.toUpperCase() } });
  }
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  res.json(invoice);
});

// PUT /api/invoices/:id
router.put('/:id', async (req, res) => {
  const { lineItems, clientName, companyName, clientEmail, clientPhone, clientAddress,
          notes, photos, status, invoiceDate, dueDate,
          discount, hstEnabled, scheduledDate } = req.body;

  const data = {};
  if (clientName)    data.clientName    = clientName;
  if (companyName !== undefined) data.companyName = companyName;
  if (clientEmail)   data.clientEmail   = clientEmail;
  if (clientPhone)   data.clientPhone   = clientPhone;
  if (clientAddress) data.clientAddress = clientAddress;
  if (notes !== undefined) data.notes   = notes;
  if (photos)        data.photos        = photos;
  if (status)        data.status        = status;
  if (invoiceDate)   data.invoiceDate   = new Date(invoiceDate);
  if (dueDate)       data.dueDate       = dueDate;
  if (discount !== undefined)   data.discount   = discount;
  if (hstEnabled !== undefined) data.hstEnabled = hstEnabled;
  if (scheduledDate !== undefined) data.scheduledDate = scheduledDate ? new Date(scheduledDate) : null;
  if (lineItems) {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id }, select: { type: true, discount: true, hstEnabled: true } });
    if (existing?.type === 'task') {
      for (const item of lineItems) {
        if (item.description) item.description = await toEnglish(item.description);
      }
    }
    data.lineItems = lineItems;
    Object.assign(data, calcTotals(
      lineItems,
      discount !== undefined ? discount : existing?.discount,
      hstEnabled !== undefined ? hstEnabled : existing?.hstEnabled
    ));
  }
  if (status === 'paid' && !data.paidAt) data.paidAt = new Date();

  const invoice = await prisma.invoice.update({
    where: { id: req.params.id },
    data,
  });

  // Keep the client aggregate (totals, paid status, history) in sync with this edit
  upsertClient(
    { name: invoice.clientName, email: invoice.clientEmail, phone: invoice.clientPhone, address: invoice.clientAddress },
    invoice.invoiceNumber, invoice.type, invoice.total, invoice.status, invoice.invoiceDate
  ).catch(() => {});

  res.json(invoice);
});

// POST /api/invoices/:id/convert  → create an invoice from an estimate, or
// an estimate from an invoice — whichever the source isn't already. Leaves
// the source record as-is (delete it separately if it was a mistake).
router.post('/:id/convert', async (req, res) => {
  const src = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!src) return res.status(404).json({ error: 'Not found' });

  const targetType = src.type === 'estimate' ? 'invoice' : 'estimate';
  const number = await nextInvoiceNumber(targetType);
  const date   = new Date();
  const created = await prisma.invoice.create({
    data: {
      invoiceNumber: number,
      type:          targetType,
      status:        'draft',
      clientName:    src.clientName,
      companyName:   src.companyName,
      clientEmail:   src.clientEmail,
      clientPhone:   src.clientPhone,
      clientAddress: src.clientAddress,
      lineItems:     src.lineItems,
      notes:         src.notes,
      photos:        src.photos,
      subtotal:      src.subtotal,
      discount:      src.discount,
      hstEnabled:    src.hstEnabled,
      hst:           src.hst,
      total:         src.total,
      invoiceDate:   date,
      dueDate:       src.dueDate || 'On Receipt',
      scheduledDate: src.scheduledDate,
    },
  });

  upsertClient(
    { name: src.clientName, email: src.clientEmail, phone: src.clientPhone, address: src.clientAddress },
    number, targetType, src.total, 'draft', date
  ).catch(() => {});

  res.json(created);
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Not found' });

  await prisma.invoice.delete({ where: { id: req.params.id } });
  removeFromClient(invoice.clientName, invoice.invoiceNumber).catch(() => {});

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

      // ── Line items — recalculate amount if missing. When an item has
      // subItems (a ChatGPT-style itemized breakdown), expand each one into
      // its own visible priced line instead of collapsing them under one
      // parent row — that's the whole point of having them.
      const lineItems = [];
      for (const item of (inv.lineItems || [])) {
        if (Array.isArray(item.subItems) && item.subItems.length > 0) {
          for (const sub of item.subItems) {
            const rate = Number(sub.price) || 0;
            lineItems.push({
              description: sub.name || item.description || '',
              notes:       [sub.unit ? `Unit: ${sub.unit}` : null, sub.description || null].filter(Boolean).join(' — ') || null,
              rate, qty: 1, amount: rate,
            });
          }
        } else {
          const rate   = Number(item.rate)   || 0;
          const qty    = Number(item.qty)    || 1;
          const amount = Number(item.amount) || Math.round(rate * qty * 100) / 100;
          lineItems.push({
            description: item.description || '',
            notes:       item.notes       || null,
            rate, qty, amount,
          });
        }
      }

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
          companyName:   inv.companyName   || null,
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

      // ── Extract sub-items into service catalog (estimates only) — read
      // from the original inv.lineItems, since the transformed lineItems
      // above no longer carries subItems once expanded.
      if (type === 'estimate') {
        for (const item of (inv.lineItems || [])) {
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

  // Advance each type's own counter to the max number seen in this batch —
  // but never move it backward, or a later re-import of an older batch
  // would rewind it and cause future manually-created invoices/estimates
  // to collide with numbers that already exist. Invoices and estimates
  // are separate documents with independent folios, so each gets its own
  // max computed from its own prefix.
  const maxOf = (prefix) => Math.max(0, ...[...seenInBatch]
    .filter(n => n.startsWith(prefix))
    .map(n => parseInt(n.replace(/\D/g, '')) || 0));
  const maxInvoice  = maxOf('INV');
  const maxEstimate = maxOf('EST');
  if (maxInvoice > 0 || maxEstimate > 0) {
    const counter = await prisma.invoiceCounter.findUnique({ where: { id: 1 } });
    const newLastInvoiceNum  = Math.max(maxInvoice,  counter?.lastInvoiceNum  || 0, 199);
    const newLastEstimateNum = Math.max(maxEstimate, counter?.lastEstimateNum || 0, 199);
    await prisma.invoiceCounter.upsert({
      where:  { id: 1 },
      update: { lastInvoiceNum: { set: newLastInvoiceNum }, lastEstimateNum: { set: newLastEstimateNum } },
      create: { id: 1, lastInvoiceNum: newLastInvoiceNum, lastEstimateNum: newLastEstimateNum },
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
// Body (optional): { email } to send to an address other than the invoice's
// stored clientEmail for this send only, { bcc: true } to also copy
// billing@mactor.ca so Julio has a record the send went out.
router.post('/:id/send', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  const toEmail = String(req.body?.email || invoice.clientEmail || '').trim();
  if (!toEmail) return res.status(400).json({ error: 'No client email' });

  const pdf    = await generateInvoicePDF(invoice);
  const isEst  = invoice.type === 'estimate';
  const label  = isEst ? 'Estimate' : 'Invoice';

  const fromAddress = isEst ? 'estimates@mactor.ca' : 'billing@mactor.ca';

  // Estimates aren't payable, and a fresh Checkout link only makes sense
  // while there's still a balance owing.
  const showPayButton = !isEst && invoice.status !== 'paid' && !!process.env.STRIPE_SECRET_KEY;
  const payUrl     = `https://www.mactor.ca/pay/${invoice.id}`;
  const approveUrl = `https://www.mactor.ca/approve/${invoice.id}`;

  const { data: sent, error: sendError } = await resend.emails.send({
    from:    `MacTor Construction <${fromAddress}>`,
    to:      [toEmail],
    bcc:     req.body?.bcc ? ['billing@mactor.ca'] : undefined,
    subject: `${label} ${invoice.invoiceNumber} — MACTOR Construction`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#0a0f1e;padding:24px 32px">
          <h1 style="color:#fff;margin:0;font-size:22px">MACTOR Construction</h1>
          <p style="color:#9ca3af;margin:4px 0 0">Professional Property Services · Toronto GTA</p>
        </div>
        <div style="padding:32px;background:#f9fafb">
          <p style="font-size:16px;color:#111">Dear <strong>${invoice.clientName}</strong>,</p>
          <p style="color:#374151">Please find your ${label.toLowerCase()} attached. ${isEst ? 'Total estimated cost' : 'Total amount due'}:
            <strong style="color:#e63946">CAD $${invoice.total.toFixed(2)}</strong></p>
          <div style="background:#fff;border-radius:8px;padding:20px;margin:20px 0;border:1px solid #e5e7eb">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${label.toUpperCase()} NUMBER</p>
            <p style="margin:0;font-size:20px;font-weight:700;color:#111">${invoice.invoiceNumber}</p>
          </div>
          ${showPayButton ? `
          <div style="text-align:center;margin:24px 0">
            <a href="${payUrl}" style="display:inline-block;background:#635bff;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Pay Online Now</a>
          </div>` : ''}
          ${isEst ? `
          <div style="text-align:center;margin:24px 0">
            <a href="${approveUrl}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px">Approve This Estimate</a>
          </div>
          <p style="color:#374151">Approving lets us know you'd like to move forward — we'll follow up to schedule the work and send your invoice.</p>
          ` : `
          <p style="color:#374151"><strong>Payment options:</strong><br>
            ${showPayButton ? '• Pay online: click the button above (Visa/Mastercard/Amex)<br>' : ''}
            • E-Transfer: payments@mactor.ca<br>
            • Cheque: Mactor Construction or Julio Cesar Macias Aguilar</p>
          `}
          <p style="color:#6b7280;font-size:13px">Thank you for your business!</p>
        </div>
        <div style="background:#0a0f1e;padding:16px 32px;text-align:center">
          <p style="color:#6b7280;margin:0;font-size:12px">MACTOR Construction · 647-517-3343 · julio@mactor.ca</p>
        </div>
      </div>`,
    attachments: [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf }],
  });

  if (sendError) {
    console.error(`[Resend] Failed to send ${invoice.invoiceNumber}:`, sendError);
    return res.status(502).json({ error: sendError.message || 'Failed to send email' });
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data:  { sentAt: new Date(), status: invoice.status === 'draft' ? 'sent' : invoice.status },
  });

  // SMS is optional and additional to the email — a failure here shouldn't
  // undo the email that already went out, so it's reported separately
  // rather than turning the whole request into an error.
  let smsError = null;
  if (req.body?.sms) {
    const toPhone = String(req.body?.phone || invoice.clientPhone || '').trim();
    if (!toPhone) {
      smsError = 'No phone number on file';
    } else {
      const viewUrl = isEst ? `https://www.mactor.ca/estimates/${invoice.id}` : `https://www.mactor.ca/billing/${invoice.id}`;
      const smsBody = isEst
        ? `MacTor Construction: your estimate ${invoice.invoiceNumber} (CAD $${invoice.total.toFixed(2)}) is ready. View: ${viewUrl}\nApprove: ${approveUrl}`
        : `MacTor Construction: invoice ${invoice.invoiceNumber} (CAD $${invoice.total.toFixed(2)}) is ready. View: ${viewUrl}`;
      try {
        await sendSms(toPhone, smsBody);
      } catch (err) {
        console.error(`[Twilio] Failed to text ${invoice.invoiceNumber}:`, err.message);
        smsError = err.message;
      }
    }
  }

  res.json({ success: true, smsError });
});

// POST /api/invoices/:id/remind  → job-day reminder/confirmation, separate
// from /send: leads with the work details (date, what, where), never
// mentions the total — that's what the invoice/estimate itself is for.
// Body: { sendEmail, email?, sendSms, phone? } — email/phone override the
// stored client contact for this message only.
router.post('/:id/remind', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  if (!invoice.scheduledDate) return res.status(400).json({ error: 'This job has no scheduled date yet' });

  const { sendEmail = false, email, sendSms: wantSms = false, phone } = req.body || {};
  if (!sendEmail && !wantSms) return res.status(400).json({ error: 'Choose email, SMS, or both' });

  const when = new Date(invoice.scheduledDate).toLocaleString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  // Julio often types task/line-item descriptions in Spanish for his own
  // notes — the reminder itself must always read in English to the client.
  const rawSummary = (invoice.lineItems || []).map(i => i.description).filter(Boolean).join(', ') || 'your scheduled job';
  const workSummary = await toEnglish(rawSummary);

  let emailError = null;
  if (sendEmail) {
    const toEmail = String(email || invoice.clientEmail || '').trim();
    if (!toEmail) {
      emailError = 'No email on file';
    } else {
      const { error } = await resend.emails.send({
        from:    'MacTor Construction <billing@mactor.ca>',
        to:      [toEmail],
        subject: `Reminder: we're coming ${when}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#0a0f1e;padding:24px 32px">
              <h1 style="color:#fff;margin:0;font-size:22px">MACTOR Construction</h1>
            </div>
            <div style="padding:32px;background:#f9fafb">
              <p style="font-size:16px;color:#111">Hi <strong>${invoice.clientName}</strong>,</p>
              <p style="color:#374151">Just a reminder that we'll be at your place for <strong>${workSummary}</strong>:</p>
              <div style="background:#fff;border-radius:8px;padding:16px 20px;margin:16px 0;border:1px solid #e5e7eb">
                <p style="margin:0 0 8px;font-size:15px"><strong>📅 ${when}</strong></p>
                ${invoice.clientAddress ? `<p style="margin:0;font-size:15px">📍 ${invoice.clientAddress}</p>` : ''}
              </div>
              <p style="color:#374151">Please have the area ready for us. Need to reschedule or cancel? Just call us at 647-517-3343.</p>
            </div>
            <div style="background:#0a0f1e;padding:16px 32px;text-align:center">
              <p style="color:#6b7280;margin:0;font-size:12px">MACTOR Construction · 647-517-3343 · julio@mactor.ca</p>
            </div>
          </div>`,
      });
      if (error) emailError = error.message;
    }
  }

  let smsError = null;
  if (wantSms) {
    const toPhone = String(phone || invoice.clientPhone || '').trim();
    if (!toPhone) {
      smsError = 'No phone number on file';
    } else {
      const smsBody = `MacTor Construction: reminder — we're coming ${when}${invoice.clientAddress ? ` to ${invoice.clientAddress}` : ''} for ${workSummary}. Please be ready. To reschedule, call 647-517-3343.`;
      try {
        await sendSms(toPhone, smsBody);
      } catch (err) {
        console.error(`[Twilio] Failed to text reminder for ${invoice.invoiceNumber}:`, err.message);
        smsError = err.message;
      }
    }
  }

  res.json({ success: true, emailError, smsError });
});

module.exports = router;
