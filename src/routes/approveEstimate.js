const express = require('express');
const prisma  = require('../services/database');
const { Resend } = require('resend');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

// GET /api/estimate-approve/:id  → public (no auth), clicked straight out
// of the client's email/PDF. Marks the estimate approved and notifies
// Julio so he knows to follow up and convert it to an invoice — separate
// path from /api/approve, which belongs to the unrelated Inspector MacTor
// AI-inspection flow.
router.get('/:id', async (req, res) => {
  const est = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!est) return res.status(404).send('Estimate not found.');
  if (est.type !== 'estimate') return res.status(400).send('This link is only for estimates.');

  if (est.status !== 'approved') {
    await prisma.invoice.update({ where: { id: est.id }, data: { status: 'approved' } });
    resend.emails.send({
      from:    'MacTor Construction <estimates@mactor.ca>',
      to:      ['estimates@mactor.ca'],
      subject: `✅ ${est.clientName} approved estimate ${est.invoiceNumber}`,
      html: `<p><strong>${est.clientName}</strong> just approved estimate <strong>${est.invoiceNumber}</strong> — CAD $${est.total.toFixed(2)}.</p>
             <p>Convert it to an invoice when you're ready to bill: https://inspector.fixmyproperty.ca/invoices/${est.id}</p>`,
    }).catch(() => {});
  }

  res.redirect(`https://www.mactor.ca/?estimate_approved=${encodeURIComponent(est.invoiceNumber)}`);
});

module.exports = router;
