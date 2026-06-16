const express = require('express');
const prisma   = require('../services/database');
const { authMiddleware } = require('../services/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/catalog?q=masonry&category=Masonry
router.get('/', async (req, res) => {
  const { q, category } = req.query;
  const where = {};
  if (q)        where.name     = { contains: q, mode: 'insensitive' };
  if (category) where.category = category;

  const services = await prisma.serviceCatalog.findMany({
    where,
    orderBy: { useCount: 'desc' },
  });
  res.json(services);
});

// GET /api/catalog/categories
router.get('/categories', async (req, res) => {
  const cats = await prisma.serviceCatalog.groupBy({
    by: ['category'],
    _count: { category: true },
    orderBy: { _count: { category: 'desc' } },
  });
  res.json(cats.map(c => ({ category: c.category || 'General', count: c._count.category })));
});

// POST /api/catalog  → create service manually
router.post('/', async (req, res) => {
  const { upsertCatalogItem } = require('../services/catalog');
  const { name, price, unit, description, category } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nombre requerido' });
  if (!price || isNaN(Number(price)) || Number(price) <= 0) return res.status(400).json({ error: 'Precio inválido' });
  const existing = await prisma.serviceCatalog.findUnique({ where: { name: String(name).trim() } });
  if (existing) return res.status(409).json({ error: 'Ya existe un servicio con ese nombre' });
  await upsertCatalogItem(
    { name: String(name).trim(), price: Number(price), unit: unit || 'lump sum', description: description || null },
    'MANUAL', 'Manual', new Date()
  );
  if (category) {
    await prisma.serviceCatalog.update({ where: { name: String(name).trim() }, data: { category } });
  }
  const created = await prisma.serviceCatalog.findUnique({ where: { name: String(name).trim() } });
  res.status(201).json(created);
});

// GET /api/catalog/:id
router.get('/:id', async (req, res) => {
  const service = await prisma.serviceCatalog.findUnique({ where: { id: req.params.id } });
  if (!service) return res.status(404).json({ error: 'Not found' });
  res.json(service);
});

// POST /api/catalog/backfill  → seed catalog from all existing invoice/estimate line items
router.post('/backfill', async (req, res) => {
  const { upsertCatalogItem } = require('../services/catalog');
  const invoices = await prisma.invoice.findMany({
    select: { invoiceNumber: true, type: true, clientName: true, invoiceDate: true, lineItems: true },
  });

  let processed = 0;
  let skipped = 0;
  for (const inv of invoices) {
    const items = Array.isArray(inv.lineItems) ? inv.lineItems : [];
    for (const item of items) {
      const name = item.description || item.name;
      // Use rate (unit price) first; fall back to amount / qty
      const price = item.rate || (item.qty > 0 ? item.amount / item.qty : item.amount);
      if (!name || !price || price <= 0) { skipped++; continue; }
      await upsertCatalogItem(
        { name, price, unit: item.unit || 'lump sum', description: item.notes || null },
        inv.invoiceNumber, inv.clientName, inv.invoiceDate
      );
      processed++;
    }
  }

  res.json({ success: true, processed, skipped });
});

module.exports = router;
