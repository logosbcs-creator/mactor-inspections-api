const prisma = require('./database');

async function upsertClient({ name, email, phone, address }, invoiceNumber, type, total, status, date) {
  if (!name || !String(name).trim()) return;

  const cleanName = String(name).trim();
  const entry = {
    date:   date instanceof Date ? date.toISOString().split('T')[0] : String(date).split('T')[0],
    type:   type   || 'invoice',
    number: invoiceNumber || '?',
    total:  Number(total) || 0,
    status: status || 'sent',
  };

  try {
    const existing = await prisma.client.findUnique({ where: { name: cleanName } });

    if (existing) {
      const history = Array.isArray(existing.history) ? existing.history : [];
      // Avoid duplicate entries for same invoice number
      if (!history.find(h => h.number === entry.number)) {
        history.push(entry);
      }

      const isPaid = status === 'paid';
      await prisma.client.update({
        where: { name: cleanName },
        data: {
          email:         email   || existing.email   || null,
          phone:         phone   || existing.phone   || null,
          address:       address || existing.address || null,
          invoiceCount:  type === 'invoice'  ? { increment: 1 } : existing.invoiceCount,
          estimateCount: type === 'estimate' ? { increment: 1 } : existing.estimateCount,
          totalInvoiced: type === 'invoice'  ? { increment: Number(total) || 0 } : existing.totalInvoiced,
          totalPaid:     isPaid && type === 'invoice' ? { increment: Number(total) || 0 } : existing.totalPaid,
          lastActivity:  date instanceof Date ? date : new Date(date),
          history,
        },
      });
    } else {
      const isPaid = status === 'paid';
      await prisma.client.create({
        data: {
          name:          cleanName,
          email:         email   || null,
          phone:         phone   || null,
          address:       address || null,
          invoiceCount:  type === 'invoice'  ? 1 : 0,
          estimateCount: type === 'estimate' ? 1 : 0,
          totalInvoiced: type === 'invoice'  ? Number(total) || 0 : 0,
          totalPaid:     isPaid && type === 'invoice' ? Number(total) || 0 : 0,
          lastActivity:  date instanceof Date ? date : new Date(date),
          history:       [entry],
        },
      });
    }
  } catch (err) {
    console.error(`[Clients] Failed to upsert "${cleanName}":`, err.message);
  }
}

module.exports = { upsertClient };
