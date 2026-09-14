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
const { authMiddleware } = require('./auth');
const loader  = require('../scripts/movidesk-loader');

// Apenas admins e supervisores podem disparar cargas
function requireAdmin(req, res, next) {
  const role = req.user?.role || req.user?.roleName || '';
  if (!['admin', 'supervisor'].includes(role)) {
    return res.status(403).json({ error: 'Sem permissão para disparar carga' });
  }
  next();
}

// ── POST /api/loader/full ─────────────────────────────────────────────────────
router.post('/full', authMiddleware, requireAdmin, (req, res) => {
  if (loader.state.running) {
    return res.status(409).json({
      error: 'Já existe uma carga em andamento',
      state: sanitizeState(loader.state),
    });
  }

  // years: array de inteiros enviado pelo front ([] = todos os anos)
  const years = Array.isArray(req.body?.years) ? req.body.years : [];

  // Roda em background — não bloqueia o HTTP
  loader.runFull({ years }).catch(e => console.error('[loader/full] erro:', e.message));

  res.json({ started: true, mode: loader.state.mode, years, startedAt: loader.state.startedAt });
});

// ── POST /api/loader/incremental ─────────────────────────────────────────────
router.post('/incremental', authMiddleware, requireAdmin, (req, res) => {
  if (loader.state.running) {
    return res.status(409).json({
      error: 'Já existe uma carga em andamento',
      state: sanitizeState(loader.state),
    });
  }

  loader.runIncremental().catch(e => console.error('[loader/incremental] erro:', e.message));

  res.json({ started: true, mode: 'incremental', startedAt: loader.state.startedAt });
});

// ── GET /api/loader/status ────────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const log = await db.query(`
      SELECT mode, started_at, finished_at, tickets_loaded, status, error_msg
      FROM silver.carga_log
      ORDER BY started_at DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    res.json({
      current: sanitizeState(loader.state),
      history: log.rows || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function sanitizeState(s) {
  return {
    running:      s.running,
    mode:         s.mode,
    phase:        s.phase,
    startedAt:    s.startedAt,
    endpoint:     s.endpoint,
    pagesDone:    s.pagesDone,
    ticketsDone:  s.ticketsDone,
    errors:       s.errors,
    lastFinish:   s.lastFinish,
    lastResult:   s.lastResult,
    // carga por anos
    years:        s.years       || [],
    currentYear:  s.currentYear || null,
    yearsTotal:   s.yearsTotal  || 0,
    yearsDone:    s.yearsDone   || 0,
  };
}

module.exports = router;
