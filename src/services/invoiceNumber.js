const prisma = require('./database');

// Invoices and estimates are different documents with independent folios —
// converting one to the other, or the property-inspection approval flow
// (approve.js) creating an estimate, must not consume numbers from the
// other type's sequence.
async function nextInvoiceNumber(type) {
  const field = type === 'estimate' ? 'lastEstimateNum' : 'lastInvoiceNum';
  const counter = await prisma.invoiceCounter.upsert({
    where:  { id: 1 },
    update: { [field]: { increment: 1 } },
    create: { id: 1, lastInvoiceNum: 199, lastEstimateNum: 199 },
  });
  const prefix = type === 'estimate' ? 'EST' : 'INV';
  return `${prefix}${String(counter[field]).padStart(4, '0')}`;
}

module.exports = { nextInvoiceNumber };
