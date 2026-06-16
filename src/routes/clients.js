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
