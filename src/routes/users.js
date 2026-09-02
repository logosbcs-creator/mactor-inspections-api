const express = require('express');
const bcrypt  = require('bcryptjs');
const prisma  = require('../services/database');
const { authMiddleware } = require('../services/auth');

const router = express.Router();
router.use(authMiddleware);

const SALT_ROUNDS = 10;

// GET /api/users  → list accounts (never returns passwordHash)
router.get('/', async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, username: true, name: true, createdAt: true },
  });
  res.json(users);
});

// POST /api/users  → create an account
router.post('/', async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Usuario requerido' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const cleanUsername = String(username).trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { username: cleanUsername } });
  if (existing) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre' });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: { username: cleanUsername, passwordHash, name: name || null },
  });
  res.status(201).json({ id: user.id, username: user.username, name: user.name, createdAt: user.createdAt });
});

// PATCH /api/users/:id  → rename or change password
router.patch('/:id', async (req, res) => {
  const { name, password } = req.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    data.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  }
  const user = await prisma.user.update({ where: { id: req.params.id }, data });
  res.json({ id: user.id, username: user.username, name: user.name, createdAt: user.createdAt });
});

// DELETE /api/users/:id  → remove an account (never lets the last account be deleted)
router.delete('/:id', async (req, res) => {
  const count = await prisma.user.count();
  if (count <= 1) return res.status(400).json({ error: 'No puedes borrar el último usuario — te quedarías sin acceso' });
  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

module.exports = router;
