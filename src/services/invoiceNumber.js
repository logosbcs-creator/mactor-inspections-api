const prisma = require('./database');

// Invoices and estimates are different documents with independent folios —
// converting one to the other, or the property-inspection approval flow
// (approve.js) creating an estimate, must not consume numbers from the
// other type's sequence.
const FIELD_BY_TYPE = { estimate: 'lastEstimateNum', task: 'lastTaskNum', invoice: 'lastInvoiceNum' };
const PREFIX_BY_TYPE = { estimate: 'EST', task: 'TASK', invoice: 'INV' };

async function nextInvoiceNumber(type) {
  const field = FIELD_BY_TYPE[type] || 'lastInvoiceNum';
  const counter = await prisma.invoiceCounter.upsert({
    where:  { id: 1 },
    update: { [field]: { increment: 1 } },
    create: { id: 1, lastInvoiceNum: 199, lastEstimateNum: 199, lastTaskNum: 0 },
  });
  const prefix = PREFIX_BY_TYPE[type] || 'INV';
  return `${prefix}${String(counter[field]).padStart(4, '0')}`;
}

module.exports = { nextInvoiceNumber };
