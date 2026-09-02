const express = require('express');
const Stripe  = require('stripe');
const prisma  = require('../services/database');

const router = express.Router();

// GET /api/pay/:id  → public (no auth) redirect into a fresh Stripe Checkout
// Session for this invoice's current balance. No token/session in the URL
// (unlike the PDF/admin routes) since this link is meant to be clicked
// straight out of the client's email. Regenerated on every click instead of
// reusing one Checkout Session URL, since those expire — a link that still
// works whenever the client gets around to paying, days or weeks later.
router.get('/:id', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).send('Online payment is not configured yet.');
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).send('Invoice not found.');
  if (invoice.type !== 'invoice') return res.status(400).send('Estimates cannot be paid online.');
  if (invoice.status === 'paid') return res.redirect('https://www.mactor.ca/?paid=' + encodeURIComponent(invoice.invoiceNumber));

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'cad',
        product_data: { name: `${invoice.invoiceNumber} — MacTor Construction` },
        unit_amount: Math.round(invoice.total * 100),
      },
      quantity: 1,
    }],
    // Tags these charges as MacTor Construction so they're distinguishable
    // from RentMyTools activity if this ever shares a Stripe account.
    metadata: { business: 'mactor_construction', invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    payment_intent_data: {
      metadata: { business: 'mactor_construction', invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
      statement_descriptor_suffix: 'MACTOR CONSTR',
    },
    success_url: `https://www.mactor.ca/?paid=${encodeURIComponent(invoice.invoiceNumber)}`,
    cancel_url:  `https://www.mactor.ca/?payment_cancelled=${encodeURIComponent(invoice.invoiceNumber)}`,
  });

  res.redirect(303, session.url);
});

module.exports = router;
