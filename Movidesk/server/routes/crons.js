'use strict';
/**
 * routes/crons.js
 *
 * CRUD das cargas automáticas configuráveis (silver.cron_job), usado pela
 * área "Cargas automáticas" em Configurações. Reativar/desativar/editar um
 * job aqui já reagenda o timer dele em cron-manager.js na hora, sem precisar
 * reiniciar o servidor.
 *
 * GET    /api/crons        — lista todos os jobs
 * POST   /api/crons        — cria um job novo
 * PATCH  /api/crons/:id    — edita (nome, tarefa, intervalo, params, enabled)
 * DELETE /api/crons/:id    — remove
 * POST   /api/crons/:id/run — dispara a tarefa agora, fora do agendamento
 * GET    /api/crons/:id/runs — histórico de execuções dessa cron (silver.carga_log)
 * GET    /api/crons/runs/:runId/changes — o que foi criado/alterado, chamado a chamado
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const cronManager = require('../scripts/cron-manager');

const VALID_TASKS = ['ouvidoria', 'gcc', 'geral', 'incremental', 'full'];

router.use(authMiddleware, requireRole('admin', 'supervisor'));

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM silver.cron_job ORDER BY id');
    res.json({ jobs: rows, taskLabels: cronManager.TASK_LABELS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, task, interval_minutes, enabled, params } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    if (!VALID_TASKS.includes(task)) return res.status(400).json({ error: `Tarefa inválida (use: ${VALID_TASKS.join(', ')})` });
    const minutes = Number(interval_minutes);
    if (!Number.isFinite(minutes) || minutes < 5) return res.status(400).json({ error: 'Intervalo mínimo é 5 minutos' });

    const { rows } = await db.query(
      `INSERT INTO silver.cron_job (name, task, interval_minutes, enabled, params)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [String(name).trim(), task, minutes, enabled !== false, JSON.stringify(params || {})]
    );
    const job = rows[0];
    await cronManager.reloadJob(job.id);
    res.json({ job });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows: existingRows } = await db.query('SELECT * FROM silver.cron_job WHERE id = $1', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Cron não encontrada' });
    const existing = existingRows[0];

    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const task = req.body?.task !== undefined ? req.body.task : existing.task;
    if (!VALID_TASKS.includes(task)) return res.status(400).json({ error: `Tarefa inválida (use: ${VALID_TASKS.join(', ')})` });
    const minutes = req.body?.interval_minutes !== undefined ? Number(req.body.interval_minutes) : existing.interval_minutes;
    if (!Number.isFinite(minutes) || minutes < 5) return res.status(400).json({ error: 'Intervalo mínimo é 5 minutos' });
    const enabled = req.body?.enabled !== undefined ? !!req.body.enabled : existing.enabled;
    const params = req.body?.params !== undefined ? req.body.params : existing.params;

    const { rows } = await db.query(
      `UPDATE silver.cron_job
       SET name = $1, task = $2, interval_minutes = $3, enabled = $4, params = $5::jsonb, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [name, task, minutes, enabled, JSON.stringify(params || {}), id]
    );
    await cronManager.reloadJob(id);
    res.json({ job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.query('DELETE FROM silver.cron_job WHERE id = $1', [id]);
    cronManager.stopAndRemove(id);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT * FROM silver.cron_job WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Cron não encontrada' });
    cronManager.executeJob(id).catch(e => console.error('[crons] execução manual falhou:', e.message));
    res.json({ started: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Histórico de execuções dessa cron — mais recentes primeiro.
router.get('/:id/runs', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const { rows } = await db.query(
      `SELECT id, mode, started_at, finished_at, status, error_msg,
              tickets_loaded, tickets_created, tickets_updated
       FROM silver.carga_log
       WHERE cron_job_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [id, limit]
    );
    res.json({ runs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detalhe do que foi criado/alterado em cada chamado numa execução específica.
router.get('/runs/:runId/changes', async (req, res) => {
  try {
    const runId = Number(req.params.runId);
    const { rows: runRows } = await db.query(
      `SELECT id, mode, started_at, finished_at, status, error_msg,
              tickets_loaded, tickets_created, tickets_updated
       FROM silver.carga_log WHERE id = $1`,
      [runId]
    );
    if (!runRows.length) return res.status(404).json({ error: 'Execução não encontrada' });

    const limit = Math.min(Number(req.query.limit) || 500, 3000);
    const { rows: changeRows } = await db.query(
      `SELECT ticket_id, change_type, changed_fields
       FROM silver.carga_log_ticket_change
       WHERE carga_log_id = $1
       ORDER BY ticket_id
       LIMIT $2`,
      [runId, limit]
    );
    res.json({ run: runRows[0], changes: changeRows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
