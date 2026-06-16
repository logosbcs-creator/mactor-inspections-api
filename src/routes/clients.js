const express = require('express');
const prisma   = require('../services/database');
const { authMiddleware } = require('../services/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/clients?q=john
router.get('/', async (req, res) => {
  const { q } = req.query;
  const where = q ? { name: { contains: q, mode: 'insensitive' } } : {};
  const clients = await prisma.client.findMany({
    where,
    orderBy: { lastActivity: 'desc' },
  });
  res.json(clients);
});

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json(client);
});

// POST /api/clients/dedupe  → merge case-variant duplicates
router.post('/dedupe', async (req, res) => {
  const all = await prisma.client.findMany({ orderBy: { createdAt: 'asc' } });

  // Group by normalized name (lowercase + collapse spaces)
  const groups = {};
  for (const c of all) {
    const key = c.name.toLowerCase().trim().replace(/\s+/g, ' ');
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }

  let merged = 0;
  for (const [, group] of Object.entries(groups)) {
    if (group.length < 2) continue;

    // Keep the record with the most invoices (or oldest if tie)
    group.sort((a, b) => (b.invoiceCount + b.estimateCount) - (a.invoiceCount + a.estimateCount));
    const [primary, ...dupes] = group;

    // Merge all history and totals into primary
    let combinedHistory = [...(primary.history || [])];
    let addInvoices = 0, addEstimates = 0, addInvoiced = 0, addPaid = 0;

    for (const dupe of dupes) {
      const dupeHistory = dupe.history || [];
      // Add only entries not already in primary (by number)
      const existingNums = new Set(combinedHistory.map(h => h.number));
      for (const h of dupeHistory) {
        if (!existingNums.has(h.number)) {
          combinedHistory.push(h);
          existingNums.add(h.number);
        }
      }
      addInvoices   += dupe.invoiceCount;
      addEstimates  += dupe.estimateCount;
      addInvoiced   += dupe.totalInvoiced;
      addPaid       += dupe.totalPaid;
    }

    combinedHistory.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    await prisma.client.update({
      where: { id: primary.id },
      data: {
        email:         primary.email   || dupes.find(d => d.email)?.email   || null,
        phone:         primary.phone   || dupes.find(d => d.phone)?.phone   || null,
        address:       primary.address || dupes.find(d => d.address)?.address || null,
        invoiceCount:  primary.invoiceCount  + addInvoices,
        estimateCount: primary.estimateCount + addEstimates,
        totalInvoiced: primary.totalInvoiced + addInvoiced,
        totalPaid:     primary.totalPaid     + addPaid,
        history:       combinedHistory,
        lastActivity:  combinedHistory.length
          ? new Date(combinedHistory[combinedHistory.length - 1].date)
          : primary.lastActivity,
      },
    });

    for (const dupe of dupes) {
      await prisma.client.delete({ where: { id: dupe.id } });
    }
    merged++;
  }

  res.json({ success: true, mergedGroups: merged });
});

// POST /api/clients/backfill  → populate catalog from all existing invoices
router.post('/backfill', async (req, res) => {
  const { upsertClient } = require('../services/clients');
  const invoices = await prisma.invoice.findMany({
    select: {
      invoiceNumber: true, type: true, status: true, total: true, invoiceDate: true,
      clientName: true, clientEmail: true, clientPhone: true, clientAddress: true,
    },
  });

  let processed = 0;
  for (const inv of invoices) {
    await upsertClient(
      { name: inv.clientName, email: inv.clientEmail, phone: inv.clientPhone, address: inv.clientAddress },
      inv.invoiceNumber, inv.type, inv.total, inv.status, inv.invoiceDate
    );
    processed++;
  }

  res.json({ success: true, processed });
});

// POST /api/clients  → create client manually
router.post('/', async (req, res) => {
  const { name, email, phone, address, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const cleanName = String(name).trim();
  const existing = await prisma.client.findFirst({ where: { name: { equals: cleanName, mode: 'insensitive' } } });
  if (existing) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
  const client = await prisma.client.create({
    data: { name: cleanName, email: email || null, phone: phone || null, address: address || null, notes: notes || null },
  });
  res.status(201).json(client);
});

// PATCH /api/clients/:id  → update notes / contact info manually
router.patch('/:id', async (req, res) => {
  const { email, phone, address, notes } = req.body;
  const data = {};
  if (email   !== undefined) data.email   = email;
  if (phone   !== undefined) data.phone   = phone;
  if (address !== undefined) data.address = address;
  if (notes   !== undefined) data.notes   = notes;
  const client = await prisma.client.update({ where: { id: req.params.id }, data });
  res.json(client);
});

module.exports = router;
