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
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const cronManager = require('../scripts/cron-manager');

const VALID_TASKS = ['ouvidoria', 'gcc', 'incremental', 'full'];

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

module.exports = router;
