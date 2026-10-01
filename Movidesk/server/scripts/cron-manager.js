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
const cronSchedule = require('../utils/cronSchedule');
const pending = new Set(); // jobs na fila ou rodando agora
const cancelRequested = new Set(); // jobs que pediram pra parar enquanto estavam na fila
let runningJobId = null;           // job cuja carga está no loader agora
const QUEUE_POLL_MS = 20 * 1000;
const QUEUE_MAX_WAIT_MS = 3 * 60 * 60 * 1000;

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

// force = execução manual ("Rodar agora"): roda mesmo com a cron desativada —
// o "Ativa" só controla o agendamento automático.
async function executeJob(jobId, { force = false } = {}) {
  const row = (await db.query('SELECT * FROM silver.cron_job WHERE id = $1', [jobId]).catch(() => ({ rows: [] }))).rows[0];
  if (!row || (!row.enabled && !force)) return;
  // Janela de horário / dias da semana: a execução AGENDADA fora dela é pulada em silêncio
  // (o "Rodar agora" ignora a janela).
  if (!force && !cronSchedule.dentroDaJanela(row.params && row.params.schedule)) {
    console.log(`⏭  Cron "${row.name}" fora da janela de horário — execução pulada.`);
    return;
  }
  // Mesma cron já na fila/rodando (ex.: timer disparou de novo enquanto a
  // anterior esperava) — não empilha outra.
  if (pending.has(jobId)) return;
  pending.add(jobId);
  try {
    // Só uma carga roda por vez no loader. Antes, se outra cron (ou carga
    // manual) estivesse em andamento, esta falhava na hora com "Já existe uma
    // carga em andamento" — agora espera na fila até o loader liberar.
    if (movideskLoader.state.running) {
      await db.query(`UPDATE silver.cron_job SET last_status = 'queued' WHERE id = $1`, [jobId]).catch(() => {});
      const limite = Date.now() + QUEUE_MAX_WAIT_MS;
      while (movideskLoader.state.running) {
        if (cancelRequested.has(jobId)) throw Object.assign(new Error('Parado manualmente (estava na fila)'), { stopped: true });
        if (Date.now() > limite) throw new Error(`Outra carga (${movideskLoader.state.mode || '?'}) ficou em andamento por mais de ${QUEUE_MAX_WAIT_MS / 3600000}h — execução pulada`);
        await new Promise(r => setTimeout(r, QUEUE_POLL_MS));
      }
    }
    console.log(`⏱️  [${new Date().toLocaleTimeString('pt-BR')}] Cron "${row.name}" (${taskLabel(row.task)}) iniciando...`);
    if (cancelRequested.has(jobId)) throw Object.assign(new Error('Parado manualmente'), { stopped: true });
    await db.query(`UPDATE silver.cron_job SET last_status = 'running' WHERE id = $1`, [jobId]).catch(() => {});
    runningJobId = jobId;
    // Cargas canceladas não devolvem nada — o resultado fica em state.lastResult
    // (que cada carga sobrescreve ao terminar, então é o desta execução).
    const result = (await runTask(row)) || movideskLoader.state.lastResult;
    if (result?.cancelled) {
      await db.query(
        `UPDATE silver.cron_job SET last_run_at = NOW(), last_status = 'cancelled', last_error = 'Parado manualmente' WHERE id = $1`,
        [jobId]
      ).catch(() => {});
      console.log(`⏹ Cron "${row.name}" parada manualmente.`);
      return;
    }
    await db.query(
      `UPDATE silver.cron_job SET last_run_at = NOW(), last_status = 'done', last_error = NULL WHERE id = $1`,
      [jobId]
    ).catch(() => {});
    console.log(`✔ Cron "${row.name}" concluída.`);
  } catch (e) {
    await db.query(
      `UPDATE silver.cron_job SET last_run_at = NOW(), last_status = $3, last_error = $2 WHERE id = $1`,
      [jobId, e.message, e.stopped ? 'cancelled' : 'error']
    ).catch(() => {});
    console.error(`✘ Cron "${row.name}" falhou: ${e.message}`);
  } finally {
    pending.delete(jobId);
    cancelRequested.delete(jobId);
    if (runningJobId === jobId) runningJobId = null;
  }
}

// Botão "Parar" da tela de crons. Três casos:
// - a carga desta cron está rodando no loader → pede cancelamento (o loader
//   para no próximo ponto de checagem e grava o que já salvou);
// - está na fila esperando outra carga → sai da fila;
// - o status ficou "running" de uma execução que morreu (ex.: container
//   reiniciado no meio) → só corrige o status no banco.
async function stopJobRun(jobId) {
  if (runningJobId === jobId && movideskLoader.state.running) {
    const ok = movideskLoader.cancelLoad();
    return { action: ok ? 'cancelling' : 'too_early' };
  }
  if (pending.has(jobId)) {
    cancelRequested.add(jobId);
    return { action: 'dequeued' };
  }
  await markInterrupted(jobId, 'Parado manualmente (execução não estava mais ativa)');
  return { action: 'reset' };
}

async function markInterrupted(jobId, msg) {
  await db.query(
    `UPDATE silver.cron_job SET last_status = 'error', last_error = $2, last_run_at = COALESCE(last_run_at, NOW())
     WHERE id = $1 AND last_status IN ('running', 'queued')`,
    [jobId, msg]
  ).catch(() => {});
  await db.query(
    `UPDATE silver.carga_log SET status = 'error', error_msg = $2, finished_at = NOW()
     WHERE cron_job_id = $1 AND status = 'running'`,
    [jobId, msg]
  ).catch(() => {});
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
  const minutos = Math.min(cronSchedule.MAX_INTERVALO, Math.max(1, Number(job.interval_minutes) || 60));
  const ms = minutos * 60 * 1000;
  const anchor = cronSchedule.parseHM(job.params && job.params.schedule && job.params.schedule.anchor);
  const entry = { timeoutHandle: null, intervalHandle: null };
  if (anchor != null) {
    // Horário-âncora: nada de rodar 15 s depois do boot — espera o próximo horário alinhado
    // (âncora + k × intervalo) e dali em diante repete a cada intervalo.
    const atraso = cronSchedule.atrasoAteProximo(anchor, minutos);
    entry.timeoutHandle = setTimeout(() => {
      executeJob(job.id);
      entry.intervalHandle = setInterval(() => executeJob(job.id), ms);
    }, atraso);
  } else {
    // primeira execução 15s depois de (re)agendar — dá tempo do servidor
    // terminar de subir / da rota de update responder antes de disparar carga
    entry.timeoutHandle = setTimeout(() => executeJob(job.id), 15 * 1000);
    entry.intervalHandle = setInterval(() => executeJob(job.id), ms);
  }
  timers.set(job.id, entry);
}

// Chamado no boot do servidor — carrega todos os jobs habilitados do banco
// e agenda cada um.
async function loadAndStartAll() {
  await ensureTable();
  // Ao subir, nenhuma cron está rodando de verdade — se alguma ficou marcada
  // como "running"/"queued" é porque o processo morreu no meio (deploy,
  // restart). Sem isso ela aparecia "Executando..." pra sempre.
  const stale = await db.query(
    `UPDATE silver.cron_job SET last_status = 'error', last_error = 'Interrompida (reinício do servidor)'
     WHERE last_status IN ('running', 'queued') RETURNING id`
  ).catch(() => ({ rows: [] }));
  if (stale.rows.length) console.log(`[cron-manager] ${stale.rows.length} cron(s) interrompida(s) pelo reinício marcada(s) como erro`);
  await db.query(
    `UPDATE silver.carga_log SET status = 'error', error_msg = 'Interrompido (reinício do servidor)', finished_at = NOW() WHERE status = 'running'`
  ).catch(() => {});
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

module.exports = { ensureTable, loadAndStartAll, reloadJob, stopAndRemove, executeJob, stopJobRun, customTaskId, TASK_LABELS };
