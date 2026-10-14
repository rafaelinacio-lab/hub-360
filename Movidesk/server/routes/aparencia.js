'use strict';
// Aparência do sistema (Configurações → Aparência), sem mexer em código.
//   GET /api/aparencia   configuração atual — pública (não é segredo e a tela de login/shell precisam dela antes de tudo)
//   PUT /api/aparencia   salva — só admin. Tudo é validado contra listas fechadas: nada digitado vira CSS/HTML.
// Guarda um JSON na tabela config (chave ui_aparencia). Quem aplica é js/aparencia.js (tokens de css/v2.css por cima).
const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');

const CHAVE = 'ui_aparencia';
const FONTES = ['manrope', 'inter', 'roboto', 'poppins', 'sistema'];
const RAIOS = ['reto', 'medio', 'redondo'];
const TEMAS = ['', 'claro', 'escuro'];
const ABAS = ['inicio', 'dashboard', 'movidesk', 'incidentes', 'reincidencias', 'chamados', 'ouvidoria', 'gcc', 'melhorias', 'jira', 'configuracoes'];
const PADRAO = { cor: '', temaPadrao: '', fonte: 'manrope', escala: 100, raio: 'redondo', menu: ABAS.map((v) => ({ v, on: true })) };

// Aceita só o que está nas listas; qualquer coisa fora vira o padrão. A cor é #rrggbb (nunca texto livre).
function sanear(b) {
  const x = b && typeof b === 'object' ? b : {};
  const cor = /^#[0-9a-fA-F]{6}$/.test(String(x.cor || '')) ? String(x.cor).toLowerCase() : '';
  const escala = Math.min(115, Math.max(85, Math.round(Number(x.escala) / 5) * 5 || 100));
  const vistas = new Set();
  const menu = [];
  for (const m of Array.isArray(x.menu) ? x.menu : []) {
    const v = m && m.v;
    if (ABAS.includes(v) && !vistas.has(v)) { vistas.add(v); menu.push({ v, on: v === 'configuracoes' ? true : m.on !== false }); }   // Configurações nunca some (o admin não se tranca para fora)
  }
  ABAS.forEach((v) => { if (!vistas.has(v)) menu.push({ v, on: true }); });
  return {
    cor,
    temaPadrao: TEMAS.includes(x.temaPadrao) ? x.temaPadrao : '',
    fonte: FONTES.includes(x.fonte) ? x.fonte : 'manrope',
    escala,
    raio: RAIOS.includes(x.raio) ? x.raio : 'redondo',
    menu,
  };
}

async function ler() {
  try {
    const r = await db.query(`SELECT value FROM config WHERE key = $1`, [CHAVE]);
    return r.rows[0] ? sanear(JSON.parse(r.rows[0].value)) : sanear(PADRAO);
  } catch (_) { return sanear(PADRAO); }
}

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await ler());
});

router.put('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const cfg = sanear(req.body);
    await db.query(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [CHAVE, JSON.stringify(cfg)]);
    res.json(cfg);
  } catch (e) {
    console.error('PUT /aparencia:', e.message);
    res.status(500).json({ error: 'Erro ao salvar a aparência' });
  }
});

module.exports = router;
