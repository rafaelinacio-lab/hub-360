'use strict';
/**
 * scripts/cron-manager.js
 *
 * Cargas automáticas configuráveis — tabela silver.cron_job + um
 * setInterval em memória por job habilitado. Não é cron de verdade (sem
 * parser de expressão cron): cada job roda a cada N minutos, contados a
 * partir de quando o timer foi (re)criado — mesmo modelo que já era usado
 * pelos setInterval fixos em server.js antes disso virar configurável.
 *
 * Ativar/desativar ou mudar o intervalo de um job pelas rotas de API
 * reinicia o timer dele na hora, sem precisar reiniciar o servidor.
 */

const db = require('../db/remote');
const movideskLoader = require('./movidesk-loader');

const TASK_LABELS = {
  ouvidoria:   'Ouvidoria — em aberto',
  gcc:         'GCC — em aberto',
  geral:       'Painel Geral — ano vigente',
  incremental: 'Incremental (todos os tickets)',
  full:        'Full (por ano/classificação/equipe)',
};

const timers = new Map(); // job id -> { intervalHandle, timeoutHandle }

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS silver.cron_job (
      id               serial PRIMARY KEY,
      name             text NOT NULL,
      task             varchar(20) NOT NULL,
      interval_minutes int NOT NULL,
      enabled          boolean NOT NULL DEFAULT true,
      params           jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_run_at      timestamptz,
      last_status      varchar(20),
      last_error       text,
      created_at       timestamptz NOT NULL DEFAULT NOW(),
      updated_at       timestamptz NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  // Tarefas personalizadas criadas pelo usuário — uma cron aponta pra elas
  // com task = 'custom:<id>'.
  await db.query(`
    CREATE TABLE IF NOT EXISTS silver.cron_task (
      id             serial PRIMARY KEY,
      name           text NOT NULL,
      owner_team     text,
      classification text,
      only_open      boolean NOT NULL DEFAULT false,
      recent_days    int,
      year           int,
      created_at     timestamptz NOT NULL DEFAULT NOW(),
      updated_at     timestamptz NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
}

function customTaskId(task) {
  const m = /^custom:(\d+)$/.exec(String(task || ''));
  return m ? Number(m[1]) : null;
}

function taskLabel(task) {
  return TASK_LABELS[task] || task;
}

async function runTask(job) {
  const { id, task, params } = job;
  if (task === 'ouvidoria') return movideskLoader.runOuvidoria(id);
  if (task === 'gcc') return movideskLoader.runGcc(id);
  if (task === 'geral') return movideskLoader.runGeral(id);
  if (task === 'incremental') return movideskLoader.runIncremental(id);
  if (task === 'full') {
    const p = params || {};
    return movideskLoader.runFull({
      years: Array.isArray(p.years) ? p.years : [],
      classification: p.classification || '',
      ownerTeam: p.ownerTeam || '',
      cronJobId: id,
    });
  }
  const customId = customTaskId(task);
  if (customId) {
    const t = (await db.query('SELECT * FROM silver.cron_task WHERE id = $1', [customId])).rows[0];
    if (!t) throw new Error(`Tarefa personalizada #${customId} não existe mais`);
    return movideskLoader.runCustom(t, id);
  }
  throw new Error(`Tarefa de cron desconhecida: ${task}`);
}

async function executeJob(jobId) {
  const row = (await db.query('SELECT * FROM silver.cron_job WHERE id = $1', [jobId]).catch(() => ({ rows: [] }))).rows[0];
  if (!row || !row.enabled) return;
  console.log(`⏱️  [${new Date().toLocaleTimeString('pt-BR')}] Cron "${row.name}" (${taskLabel(row.task)}) iniciando...`);
  await db.query(`UPDATE silver.cron_job SET last_status = 'running' WHERE id = $1`, [jobId]).catch(() => {});
  try {
    await runTask(row);
    await db.query(
      `UPDATE silver.cron_job SET last_run_at = NOW(), last_status = 'done', last_error = NULL WHERE id = $1`,
      [jobId]
    ).catch(() => {});
    console.log(`✔ Cron "${row.name}" concluída.`);
  } catch (e) {
    await db.query(
      `UPDATE silver.cron_job SET last_run_at = NOW(), last_status = 'error', last_error = $2 WHERE id = $1`,
      [jobId, e.message]
    ).catch(() => {});
    console.error(`✘ Cron "${row.name}" falhou: ${e.message}`);
  }
}

function stopJob(jobId) {
  const t = timers.get(jobId);
  if (!t) return;
  clearTimeout(t.timeoutHandle);
  clearInterval(t.intervalHandle);
  timers.delete(jobId);
}

function startJob(job) {
  stopJob(job.id);
  if (!job.enabled) return;
  const ms = Math.max(1, Number(job.interval_minutes) || 60) * 60 * 1000;
  // primeira execução 15s depois de (re)agendar — dá tempo do servidor
  // terminar de subir / da rota de update responder antes de disparar carga
  const timeoutHandle = setTimeout(() => executeJob(job.id), 15 * 1000);
  const intervalHandle = setInterval(() => executeJob(job.id), ms);
  timers.set(job.id, { timeoutHandle, intervalHandle });
}

// Chamado no boot do servidor — carrega todos os jobs habilitados do banco
// e agenda cada um.
async function loadAndStartAll() {
  await ensureTable();
  const rows = (await db.query('SELECT * FROM silver.cron_job').catch(() => ({ rows: [] }))).rows;
  rows.forEach(startJob);
  console.log(`[cron-manager] ${rows.filter(r => r.enabled).length}/${rows.length} cron(s) automática(s) ativa(s)`);
}

// Chamado pelas rotas de API depois de criar/editar/ativar/desativar um job
// — reagenda (ou para) o timer dele sem precisar reiniciar o servidor.
async function reloadJob(jobId) {
  const row = (await db.query('SELECT * FROM silver.cron_job WHERE id = $1', [jobId]).catch(() => ({ rows: [] }))).rows[0];
  if (!row) { stopJob(jobId); return; }
  startJob(row);
}

function stopAndRemove(jobId) {
  stopJob(jobId);
}

module.exports = { ensureTable, loadAndStartAll, reloadJob, stopAndRemove, executeJob, customTaskId, TASK_LABELS };
