'use strict';
/**
 * routes/crons.js
 *
 * CRUD das cargas automáticas configuráveis (silver.cron_job), usado pela
 * área "Cargas automáticas" em Configurações. Reativar/desativar/editar um
 * job aqui já reagenda o timer dele em cron-manager.js na hora, sem precisar
 * reiniciar o servidor.
 *
 * GET/PUT /api/crons/rapida — carga rápida de pendentes (tarefa + cron numa tela só)
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
const movideskLoader = require('../scripts/movidesk-loader');

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
    rapido:         !!body.rapido && !!body.only_open,   // modo rápido só faz sentido com "só em aberto"
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
      const [equipes, classes, anos, servicos] = await Promise.all([
        db.query(`SELECT DISTINCT ownerteam AS v FROM silver.ticket WHERE NULLIF(TRIM(ownerteam), '') IS NOT NULL ORDER BY 1`),
        db.query(`SELECT DISTINCT valor_texto AS v FROM silver.ticket_campo_customizado WHERE custom_field_id = $1 AND NULLIF(TRIM(valor_texto), '') IS NOT NULL ORDER BY 1`, [CF_CLASSIFICACAO]),
        db.query(`SELECT DISTINCT EXTRACT(YEAR FROM createddate)::int AS v FROM silver.ticket WHERE createddate IS NOT NULL ORDER BY 1 DESC`),
        db.query(`SELECT split_part(service_full, ' > ', 1) AS v, COUNT(*) AS n FROM silver.ticket WHERE service_full IS NOT NULL AND service_full <> '' AND createddate >= NOW() - INTERVAL '18 months' GROUP BY 1 ORDER BY 2 DESC LIMIT 300`),
      ]);
      _taskOptionsCache = {
        teams: equipes.rows.map(r => r.v),
        classifications: classes.rows.map(r => r.v),
        years: anos.rows.map(r => r.v),
        services: servicos.rows.map(r => r.v).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt')),
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
      `INSERT INTO silver.cron_task (name, owner_team, classification, only_open, recent_days, year, rapido)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [t.name, t.owner_team, t.classification, t.only_open, t.recent_days, t.year, t.rapido]
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
       SET name = $1, owner_team = $2, classification = $3, only_open = $4, recent_days = $5, year = $6, rapido = $7, updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [t.name, t.owner_team, t.classification, t.only_open, t.recent_days, t.year, t.rapido, id]
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

// Além do job, devolve pra previsão de término na tela:
//   avg_sec            — duração média das últimas 5 execuções concluídas
//                        (da própria cron; sem histórico dela, das cargas do
//                        mesmo tipo, inclusive manuais)
//   running_started_at — início da execução em andamento, se houver
const CRON_LIST_SQL = `
  SELECT j.*, est.avg_sec, est.n_amostras, cur.started_at AS running_started_at
  FROM silver.cron_job j
  LEFT JOIN LATERAL (
    SELECT AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))::float AS avg_sec, COUNT(*)::int AS n_amostras
    FROM (
      SELECT started_at, finished_at
      FROM silver.carga_log
      WHERE status = 'done' AND finished_at IS NOT NULL
        AND (cron_job_id = j.id OR (
              NOT EXISTS (SELECT 1 FROM silver.carga_log c2 WHERE c2.cron_job_id = j.id AND c2.status = 'done')
              AND mode = j.task))
      ORDER BY started_at DESC
      LIMIT 5
    ) ult
  ) est ON true
  LEFT JOIN LATERAL (
    SELECT started_at FROM silver.carga_log
    WHERE cron_job_id = j.id AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  ) cur ON true
  ORDER BY j.id`;

// ── Carga rápida de pendentes (tela própria em Configurações) ─────────────
// Uma única tarefa "rápida" (silver.cron_task.rapido) + a cron que a roda. GET devolve tudo para a tela; PUT cria/atualiza os dois.
const NOME_TAREFA_RAPIDA = 'Pendentes — carga rápida';
const NOME_CRON_RAPIDA = 'Pendentes rápidos (Painel TV)';
async function lerRapida() {
  const t = (await db.query(`SELECT * FROM silver.cron_task WHERE rapido = TRUE ORDER BY id LIMIT 1`).catch(() => ({ rows: [] }))).rows[0] || null;
  const job = t ? (await db.query(`SELECT * FROM silver.cron_job WHERE task = $1 ORDER BY id LIMIT 1`, [`custom:${t.id}`])).rows[0] || null : null;
  const historico = (await db.query(
    `SELECT id, started_at, finished_at, status, error_msg, tickets_loaded FROM silver.carga_log WHERE mode LIKE 'rapido:%' ORDER BY started_at DESC LIMIT 20`
  ).catch(() => ({ rows: [] }))).rows;
  let detalhes = null;
  try {
    const q = (await db.query(
      `SELECT COUNT(*) FILTER (WHERE detalhes_em IS NULL OR detalhes_em < last_update)::int AS faltam, COUNT(*)::int AS abertos
         FROM silver.ticket t WHERE t.basestatus IS NOT NULL AND NOT (t.basestatus = ANY($1::text[]))`, [movideskLoader.CLOSED_STATUSES])).rows[0];
    const e = movideskLoader.enriquecimentoPendentes || {};
    detalhes = { ...q, rodando: !!e.rodando, fila: e.fila || 0, feitos: e.feitos || 0, falhas: e.falhas || 0, terminadoEm: e.terminadoEm || null, ultimoErro: e.ultimoErro || null };
  } catch (_) { /* coluna detalhes_em ainda não existe */ }
  // quantos chamados o banco tem ABERTOS dentro do escopo da tarefa (para comparar com a contagem do Movidesk)
  let escopoAbertos = null, porStatus = null;
  if (t) {
    try {
      const { where, params } = movideskLoader.escopoSql({ ownerTeamVal: t.owner_team || '', servicoVal: t.service_first || '', classValue: t.classification || '' }, [movideskLoader.CLOSED_STATUSES]);
      escopoAbertos = (await db.query(`SELECT COUNT(*)::int AS n FROM silver.ticket t WHERE t.basestatus IS NOT NULL AND NOT (t.basestatus = ANY($1::text[])) ${where.length ? 'AND ' + where.join(' AND ') : ''}`, params)).rows[0].n;
      // por status, para comparar linha a linha com o Movidesk
      porStatus = (await db.query(`SELECT t.basestatus AS base, COUNT(*)::int AS n FROM silver.ticket t WHERE t.basestatus IS NOT NULL AND NOT (t.basestatus = ANY($1::text[])) ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY 1 ORDER BY 2 DESC`, params)).rows;
    } catch (_) { /* sem contagem */ }
  }
  return { tarefa: t, job, historico, detalhes, escopoAbertos, porStatus, carregando: !!movideskLoader.state?.running && String(movideskLoader.state?.mode || '').startsWith('rapido:') };
}
router.get('/rapida', async (req, res) => {
  try { res.json(await lerRapida()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/rapida', async (req, res) => {
  try {
    const b = req.body || {};
    const owner_team = (b.owner_team && String(b.owner_team).trim()) || null;
    const classification = (b.classification && String(b.classification).trim()) || null;
    const service_first = (b.service_first && String(b.service_first).trim()) || null;
    // sem nenhum filtro = TODOS os chamados pendentes (qualquer serviço, equipe ou classificação)
    let minutes;
    try { minutes = cronSchedule.validarIntervalo(b.interval_minutes || 1); } catch (e) { return res.status(400).json({ error: e.message }); }
    const enabled = b.enabled !== false;
    const atual = (await db.query(`SELECT id FROM silver.cron_task WHERE rapido = TRUE ORDER BY id LIMIT 1`)).rows[0];
    let tarefaId;
    if (atual) {
      tarefaId = atual.id;
      await db.query(`UPDATE silver.cron_task SET owner_team=$1, classification=$2, service_first=$3, only_open=TRUE, rapido=TRUE, updated_at=NOW() WHERE id=$4`, [owner_team, classification, service_first, tarefaId]);
    } else {
      tarefaId = (await db.query(
        `INSERT INTO silver.cron_task (name, owner_team, classification, service_first, only_open, rapido) VALUES ($1,$2,$3,$4,TRUE,TRUE) RETURNING id`,
        [NOME_TAREFA_RAPIDA, owner_team, classification, service_first])).rows[0].id;
    }
    const job = (await db.query(`SELECT id FROM silver.cron_job WHERE task = $1 ORDER BY id LIMIT 1`, [`custom:${tarefaId}`])).rows[0];
    if (job) {
      await db.query(`UPDATE silver.cron_job SET interval_minutes=$1, enabled=$2, updated_at=NOW() WHERE id=$3`, [minutes, enabled, job.id]);
      await cronManager.reloadJob(job.id);
    } else {
      const novo = (await db.query(
        `INSERT INTO silver.cron_job (name, task, interval_minutes, enabled, params) VALUES ($1,$2,$3,$4,'{}'::jsonb) RETURNING id`,
        [NOME_CRON_RAPIDA, `custom:${tarefaId}`, minutes, enabled])).rows[0];
      await cronManager.reloadJob(novo.id);
    }
    res.json(await lerRapida());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(CRON_LIST_SQL)
      .catch(() => db.query('SELECT * FROM silver.cron_job ORDER BY id'));
    res.json({ jobs: rows, taskLabels: cronManager.TASK_LABELS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const cronSchedule = require('../utils/cronSchedule');
// params pode trazer `schedule` (janela de horário, dias, âncora): valida e limpa; devolve o objeto de params final.
function comScheduleValidado(params) {
  const p = { ...(params && typeof params === 'object' ? params : {}) };
  const sch = cronSchedule.normalizarSchedule(p.schedule);
  if (sch) p.schedule = sch; else delete p.schedule;
  return p;
}

router.post('/', async (req, res) => {
  try {
    const { name, task, interval_minutes, enabled, params } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    if (!(await tarefaValida(task))) return res.status(400).json({ error: 'Tarefa inválida' });
    let minutes;
    try { minutes = cronSchedule.validarIntervalo(interval_minutes); } catch (e) { return res.status(400).json({ error: e.message }); }
    let paramsOk;
    try { paramsOk = comScheduleValidado(params); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { rows } = await db.query(
      `INSERT INTO silver.cron_job (name, task, interval_minutes, enabled, params)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [String(name).trim(), task, minutes, enabled !== false, JSON.stringify(paramsOk)]
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
    let minutes;
    try { minutes = cronSchedule.validarIntervalo(req.body?.interval_minutes !== undefined ? req.body.interval_minutes : existing.interval_minutes); } catch (e) { return res.status(400).json({ error: e.message }); }
    const enabled = req.body?.enabled !== undefined ? !!req.body.enabled : existing.enabled;
    let params;
    try { params = comScheduleValidado(req.body?.params !== undefined ? req.body.params : existing.params); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { rows } = await db.query(
      `UPDATE silver.cron_job
       SET name = $1, task = $2, interval_minutes = $3, enabled = $4, params = $5::jsonb, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [name, task, minutes, enabled, JSON.stringify(params), id]
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
    // Com outra carga em andamento, entra na fila (executeJob espera o loader
    // liberar) em vez de recusar.
    const queued = !!movideskLoader.state?.running;
    cronManager.executeJob(id, { force: true }).catch(e => console.error('[crons] execução manual falhou:', e.message));
    res.json({ started: true, queued });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Para a execução em andamento (ou na fila) dessa cron — ou corrige o status
// se ela ficou "Executando..." de uma execução que já morreu.
router.post('/:id/stop', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT id FROM silver.cron_job WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Cron não encontrada' });
    const r = await cronManager.stopJobRun(id);
    if (r.action === 'too_early') return res.status(409).json({ error: 'A carga acabou de começar — tente de novo em alguns segundos.' });
    res.json(r);
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

    const limit = Math.min(Number(req.query.limit) || 500, 100000);
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
