'use strict';
// GET /api/frescor/:aba — data/hora em que os dados daquela aba foram atualizados (ver utils/frescor.js). Qualquer usuário logado.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('./auth');
const { frescor } = require('../utils/frescor');

router.get('/:aba', authMiddleware, async (req, res) => {
  const r = await frescor(String(req.params.aba || ''));
  if (!r) return res.status(404).json({ error: 'Aba desconhecida' });
  res.json(r);
});

module.exports = router;
