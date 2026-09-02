const express = require('express');
const prisma  = require('../services/database');
const { generateInvoicePDF } = require('../services/pdf');

const router = express.Router();

// GET /api/view/:id  → public (no auth) PDF, for SMS links (can't carry a
// Bearer token the way the admin PDF route does). Same document either way.
router.get('/:id', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).send('Not found.');

  const pdf = await generateInvoicePDF(invoice);
  res.set({
    'Content-Type':        'application/pdf',
    'Content-Disposition': `inline; filename="${invoice.invoiceNumber}.pdf"`,
    'Content-Length':      pdf.length,
  });
  res.send(pdf);
});

module.exports = router;
