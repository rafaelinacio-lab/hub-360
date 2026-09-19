'use strict';
/**
 * routes/loader.js
 *
 * Rotas de controle do sistema de carga do datalake Movidesk → silver.*
 *
 * POST /api/loader/full          — dispara carga completa
 * POST /api/loader/incremental   — dispara carga incremental
 * GET  /api/loader/status        — estado atual + histórico recente
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { getToken } = require('./config');
const { runFull, runIncremental, runOuvidoria, runGcc, cancelLoad, state: loaderState } = require('../scripts/movidesk-loader');
const loader  = { runFull, runIncremental, runOuvidoria, runGcc, cancelLoad, state: loaderState };

// ── POST /api/loader/full ─────────────────────────────────────────────────────
router.post('/full', authMiddleware, requireRole('admin', 'supervisor'), (req, res) => {
  if (loader.state.running) {
    return res.status(409).json({
      error: 'Já existe uma carga em andamento',
      state: sanitizeState(loader.state),
    });
  }

  // years: array de inteiros enviado pelo front ([] = todos os anos)
  const years = Array.isArray(req.body?.years) ? req.body.years : [];
  // classification: filtra pelo campo "Classificação de Ticket" (CF 23946); vazio = todas
  const classification = typeof req.body?.classification === 'string' ? req.body.classification.trim() : '';
  // ownerTeam: filtra direto pelo campo "Equipe" (ownerTeam) — mais barato pra
  // API do que o filtro por Classificação; vazio = usa o mapeamento fixo (se houver)
  const ownerTeam = typeof req.body?.ownerTeam === 'string' ? req.body.ownerTeam.trim() : '';

  // Roda em background — não bloqueia o HTTP
  loader.runFull({ years, classification, ownerTeam }).catch(e => console.error('[loader/full] erro:', e.message));

  res.json({ started: true, mode: loader.state.mode, years, classification, ownerTeam, startedAt: loader.state.startedAt });
});

// ── POST /api/loader/incremental ─────────────────────────────────────────────
router.post('/incremental', authMiddleware, requireRole('admin', 'supervisor'), (req, res) => {
  if (loader.state.running) {
    return res.status(409).json({
      error: 'Já existe uma carga em andamento',
      state: sanitizeState(loader.state),
    });
  }

  loader.runIncremental().catch(e => console.error('[loader/incremental] erro:', e.message));

  res.json({ started: true, mode: 'incremental', startedAt: loader.state.startedAt });
});

// ── POST /api/loader/ouvidoria ────────────────────────────────────────────────
// Carga leve: só tickets classificados como "Ouvidoria" (CF 23946). Usada pela
// cron de 2h e pelo botão "Sincronizar tickets" da aba Ouvidoria.
router.post('/ouvidoria', authMiddleware, requireRole('admin', 'supervisor'), (req, res) => {
  if (loader.state.running) {
    return res.status(409).json({
      error: 'Já existe uma carga em andamento',
      state: sanitizeState(loader.state),
    });
  }

  loader.runOuvidoria().catch(e => console.error('[loader/ouvidoria] erro:', e.message));

  res.json({ started: true, mode: 'ouvidoria', startedAt: loader.state.startedAt });
});

// ── POST /api/loader/gcc ──────────────────────────────────────────────────────
// Carga leve: só tickets classificados como "Gestão de Combate ao Churn"
// (CF 23946). Usada pela cron de 2h e pelo botão "Sincronizar tickets" da aba GCC.
router.post('/gcc', authMiddleware, requireRole('admin', 'supervisor'), (req, res) => {
  if (loader.state.running) {
    return res.status(409).json({
      error: 'Já existe uma carga em andamento',
      state: sanitizeState(loader.state),
    });
  }

  loader.runGcc().catch(e => console.error('[loader/gcc] erro:', e.message));

  res.json({ started: true, mode: 'gcc', startedAt: loader.state.startedAt });
});

// ── POST /api/loader/cancel ───────────────────────────────────────────────────
router.post('/cancel', authMiddleware, requireRole('admin', 'supervisor'), (req, res) => {
  if (!loader.state.running) {
    return res.status(409).json({ error: 'Nenhuma carga em andamento' });
  }
  const ok = loader.cancelLoad();
  res.json({ cancelled: ok, state: sanitizeState(loader.state) });
});

// ── GET /api/loader/status ────────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const log = await db.query(`
      SELECT mode, started_at, finished_at, tickets_loaded, status, error_msg,
             years, classification, owner_team
      FROM silver.carga_log
      ORDER BY started_at DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    // token mascarado — mostra só os últimos 6 chars para diagnóstico
    let tokenSuffix = null;
    try {
      await new Promise((ok, fail) => getToken((e, t) => e ? fail(e) : ok(t)))
        .then(t => { tokenSuffix = t ? `...${t.slice(-6)}` : null; })
        .catch(() => {});
    } catch (_) {}

    res.json({
      current: sanitizeState(loader.state),
      history: log.rows || [],
      tokenSuffix,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function sanitizeState(s) {
  return {
    running:          s.running,
    cancelRequested:  s.cancelRequested || false,
    mode:             s.mode,
    phase:            s.phase,
    startedAt:        s.startedAt,
    endpoint:         s.endpoint,
    pagesDone:        s.pagesDone,
    ticketsDone:      s.ticketsDone,
    errors:           s.errors,
    lastFinish:       s.lastFinish,
    lastResult:       s.lastResult,
    // carga por anos
    years:            s.years       || [],
    currentYear:      s.currentYear || null,
    yearsTotal:       s.yearsTotal  || 0,
    yearsDone:        s.yearsDone   || 0,
  };
}

module.exports = router;
