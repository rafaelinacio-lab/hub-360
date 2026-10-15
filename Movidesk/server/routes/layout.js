'use strict';
// Layout dos cards de cada aba (ordem, largura, altura, ocultar) — configurado pelo admin direto na aba (Configurações → Layout das abas).
//   GET /api/layout   configuração atual — qualquer usuário logado (quem monta a tela precisa dela)
//   PUT /api/layout   salva — só admin. Tudo é validado contra listas fechadas: nada digitado vira CSS/HTML.
// Guarda um JSON na tabela config (chave ui_layout_abas): { <aba>: { ordem: [idCartao…], cartoes: { <idCartao>: { l, h, o } } } }
//   l = largura em colunas de 12 (3, 4, 6, 8, 12) · h = altura (auto | p | m | g) · o = oculto.
// Quem aplica é js/layout.js (e o modo de edição, na própria aba).
const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');

const CHAVE = 'ui_layout_abas';
const ABAS = ['geral'];                       // abas com layout configurável (cresce conforme js/layout.js é ligado nas telas)
const LARGURAS = [3, 4, 6, 8, 12];
const ALTURAS = ['auto', 'p', 'm', 'g'];
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_CARTOES = 80;

function sanear(b) {
  const out = {};
  const x = b && typeof b === 'object' ? b : {};
  for (const aba of ABAS) {
    const a = x[aba];
    if (!a || typeof a !== 'object') continue;
    const ordem = [], vistos = new Set();
    for (const id of Array.isArray(a.ordem) ? a.ordem : []) {
      if (typeof id === 'string' && ID.test(id) && !vistos.has(id) && ordem.length < MAX_CARTOES) { vistos.add(id); ordem.push(id); }
    }
    const cartoes = {};
    for (const [id, c] of Object.entries(a.cartoes && typeof a.cartoes === 'object' ? a.cartoes : {})) {
      if (!ID.test(id) || Object.keys(cartoes).length >= MAX_CARTOES || !c || typeof c !== 'object') continue;
      const o = {};
      if (LARGURAS.includes(Number(c.l))) o.l = Number(c.l);
      if (ALTURAS.includes(c.h) && c.h !== 'auto') o.h = c.h;
      if (c.o === true) o.o = true;
      if (Object.keys(o).length) cartoes[id] = o;
    }
    if (ordem.length || Object.keys(cartoes).length) out[aba] = { ordem, cartoes };
  }
  return out;
}

async function ler() {
  try {
    const r = await db.query(`SELECT value FROM config WHERE key = $1`, [CHAVE]);
    return r.rows[0] ? sanear(JSON.parse(r.rows[0].value)) : {};
  } catch (_) { return {}; }
}

router.get('/', authMiddleware, async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await ler());
});

// Salva o layout de UMA aba (body: { aba, layout }); layout vazio/ausente = volta ao padrão daquela aba.
router.put('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const aba = String((req.body && req.body.aba) || '');
    if (!ABAS.includes(aba)) return res.status(400).json({ error: 'Aba sem layout configurável.' });
    const atual = await ler();
    const novo = sanear({ [aba]: req.body.layout });
    if (novo[aba]) atual[aba] = novo[aba]; else delete atual[aba];
    await db.query(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [CHAVE, JSON.stringify(atual)]);
    res.json(atual);
  } catch (e) {
    console.error('PUT /layout:', e.message);
    res.status(500).json({ error: 'Erro ao salvar o layout' });
  }
});

module.exports = router;
