const prisma = require('./database');

function computeStats(history) {
  let invoiceCount = 0, estimateCount = 0, totalInvoiced = 0, totalPaid = 0;
  for (const h of history) {
    if (h.type === 'estimate') {
      estimateCount++;
    } else {
      invoiceCount++;
      totalInvoiced += Number(h.total) || 0;
      if (h.status === 'paid') totalPaid += Number(h.total) || 0;
    }
  }
  return {
    invoiceCount, estimateCount,
    totalInvoiced: Math.round(totalInvoiced * 100) / 100,
    totalPaid:     Math.round(totalPaid * 100) / 100,
  };
}

// Create/update the client record for one invoice or estimate. Safe to call
// repeatedly for the same invoiceNumber (e.g. on every edit) — stats are
// recomputed from the full history array rather than incremented, so it
// never double-counts.
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
    // Case-insensitive lookup to avoid duplicates from capitalization variations
    const existing = await prisma.client.findFirst({
      where: { name: { equals: cleanName, mode: 'insensitive' } },
    });

    if (existing) {
      const history = Array.isArray(existing.history) ? [...existing.history] : [];
      const idx = history.findIndex(h => h.number === entry.number);
      if (idx >= 0) history[idx] = entry; else history.push(entry);

      const stats = computeStats(history);
      await prisma.client.update({
        where: { id: existing.id },
        data: {
          email:        email   || existing.email   || null,
          phone:        phone   || existing.phone   || null,
          address:      address || existing.address || null,
          ...stats,
          lastActivity: date instanceof Date ? date : new Date(date),
          history,
        },
      });
    } else {
      const stats = computeStats([entry]);
      await prisma.client.create({
        data: {
          name:  cleanName,
          email: email   || null,
          phone: phone   || null,
          address: address || null,
          ...stats,
          lastActivity: date instanceof Date ? date : new Date(date),
          history: [entry],
        },
      });
    }
  } catch (err) {
    console.error(`[Clients] Failed to upsert "${cleanName}":`, err.message);
  }
}

// Remove one invoice/estimate's entry from its client and recompute stats.
// Call this when an invoice is deleted so the client aggregate doesn't drift.
async function removeFromClient(name, invoiceNumber) {
  if (!name || !invoiceNumber) return;
  const cleanName = String(name).trim();

  try {
    const existing = await prisma.client.findFirst({
      where: { name: { equals: cleanName, mode: 'insensitive' } },
    });
    if (!existing) return;

    const history = (Array.isArray(existing.history) ? existing.history : [])
      .filter(h => h.number !== invoiceNumber);
    const stats = computeStats(history);

    await prisma.client.update({
      where: { id: existing.id },
      data: {
        ...stats,
        history,
        lastActivity: history.length ? new Date(history[history.length - 1].date) : null,
      },
    });
  } catch (err) {
    console.error(`[Clients] Failed to remove "${invoiceNumber}" from "${cleanName}":`, err.message);
  }
}

module.exports = { upsertClient, removeFromClient };
