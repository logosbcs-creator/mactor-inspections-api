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

// GET /api/catalog/:id
router.get('/:id', async (req, res) => {
  const service = await prisma.serviceCatalog.findUnique({ where: { id: req.params.id } });
  if (!service) return res.status(404).json({ error: 'Not found' });
  res.json(service);
});

module.exports = router;
