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
 * GET    /api/crons/tasks        — tarefas personalizadas (silver.cron_task)
 * POST   /api/crons/tasks        — cria tarefa personalizada
 * PATCH  /api/crons/tasks/:id    — edita tarefa personalizada
 * DELETE /api/crons/tasks/:id    — remove (bloqueia se alguma cron usa)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const cronManager = require('../scripts/cron-manager');

const VALID_TASKS = ['ouvidoria', 'gcc', 'geral', 'incremental', 'full'];

router.use(authMiddleware, requireRole('admin', 'supervisor'));

// Tarefa válida = uma das fixas ou 'custom:<id>' de uma tarefa que existe.
async function tarefaValida(task) {
  if (VALID_TASKS.includes(task)) return true;
  const customId = cronManager.customTaskId(task);
  if (!customId) return false;
  const { rows } = await db.query('SELECT 1 FROM silver.cron_task WHERE id = $1', [customId]);
  return rows.length > 0;
}

// ── Tarefas personalizadas ──────────────────────────────────────────────
function normalizarTarefa(body = {}) {
  const txt = v => (v === undefined || v === null) ? null : (String(v).trim() || null);
  const int = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };
  return {
    name:           txt(body.name),
    owner_team:     txt(body.owner_team),
    classification: txt(body.classification),
    only_open:      !!body.only_open,
    recent_days:    int(body.recent_days),
    year:           int(body.year),
  };
}
function validarTarefa(t) {
  if (!t.name) return 'Nome é obrigatório';
  if (t.year && (t.year < 2000 || t.year > new Date().getFullYear() + 1)) return 'Ano inválido';
  if (!t.owner_team && !t.classification && !t.year && !t.only_open && !t.recent_days) {
    return 'Defina ao menos um filtro: equipe, classificação, ano, "só em aberto" ou últimos N dias';
  }
  return null;
}

// Opções pros selects do modal de tarefa: equipes, classificações e anos que
// existem de fato nos tickets. Cache em memória — são consultas de DISTINCT
// em tabelas grandes e a lista quase não muda.
const CF_CLASSIFICACAO = 23946;
let _taskOptionsCache = null;
let _taskOptionsAt = 0;
router.get('/task-options', async (req, res) => {
  try {
    if (!_taskOptionsCache || Date.now() - _taskOptionsAt > 10 * 60 * 1000) {
      const [equipes, classes, anos] = await Promise.all([
        db.query(`SELECT DISTINCT ownerteam AS v FROM silver.ticket WHERE NULLIF(TRIM(ownerteam), '') IS NOT NULL ORDER BY 1`),
        db.query(`SELECT DISTINCT valor_texto AS v FROM silver.ticket_campo_customizado WHERE custom_field_id = $1 AND NULLIF(TRIM(valor_texto), '') IS NOT NULL ORDER BY 1`, [CF_CLASSIFICACAO]),
        db.query(`SELECT DISTINCT EXTRACT(YEAR FROM createddate)::int AS v FROM silver.ticket WHERE createddate IS NOT NULL ORDER BY 1 DESC`),
      ]);
      _taskOptionsCache = {
        teams: equipes.rows.map(r => r.v),
        classifications: classes.rows.map(r => r.v),
        years: anos.rows.map(r => r.v),
      };
      _taskOptionsAt = Date.now();
    }
    res.json(_taskOptionsCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM silver.cron_task ORDER BY name');
    res.json({ tasks: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const t = normalizarTarefa(req.body);
    const erro = validarTarefa(t);
    if (erro) return res.status(400).json({ error: erro });
    const { rows } = await db.query(
      `INSERT INTO silver.cron_task (name, owner_team, classification, only_open, recent_days, year)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [t.name, t.owner_team, t.classification, t.only_open, t.recent_days, t.year]
    );
    res.json({ task: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/tasks/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const t = normalizarTarefa(req.body);
    const erro = validarTarefa(t);
    if (erro) return res.status(400).json({ error: erro });
    const { rows } = await db.query(
      `UPDATE silver.cron_task
       SET name = $1, owner_team = $2, classification = $3, only_open = $4, recent_days = $5, year = $6, updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [t.name, t.owner_team, t.classification, t.only_open, t.recent_days, t.year, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tarefa não encontrada' });
    res.json({ task: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows: usos } = await db.query('SELECT name FROM silver.cron_job WHERE task = $1', [`custom:${id}`]);
    if (usos.length) {
      return res.status(409).json({ error: `Tarefa em uso pelas crons: ${usos.map(u => u.name).join(', ')}. Troque a tarefa delas ou exclua-as antes.` });
    }
    await db.query('DELETE FROM silver.cron_task WHERE id = $1', [id]);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    if (!(await tarefaValida(task))) return res.status(400).json({ error: 'Tarefa inválida' });
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
    if (!(await tarefaValida(task))) return res.status(400).json({ error: 'Tarefa inválida' });
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
