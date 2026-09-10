#!/usr/bin/env node
/**
 * import-curadoria-do-banco.js
 *
 * Popula movidesk_curadoria.curadoria_chamados lendo os dados diretamente
 * da tabela `tickets` do banco principal (movidesk_painel) — sem nenhuma
 * chamada à API Movidesk.
 *
 * Uso:
 *   node scripts/import-curadoria-do-banco.js              (ano atual)
 *   node scripts/import-curadoria-do-banco.js 2026
 *   node scripts/import-curadoria-do-banco.js 2025
 *   node scripts/import-curadoria-do-banco.js 2025 2026    (dois anos)
 *   node scripts/import-curadoria-do-banco.js all          (tudo)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'server', 'db', 'remote'));

// ── Configuração ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ALL  = args[0] === 'all';
const ANOS = ALL ? [] : (args.length ? args.map(a => parseInt(a, 10)) : [new Date().getFullYear()]);

if (!ALL && ANOS.some(isNaN)) {
  console.error('Uso: node import-curadoria-do-banco.js [ano...] | all');
  process.exit(1);
}

const BATCH = 500; // registros por lote de INSERT

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${rs}s`;
}

// ── Leitura da tabela tickets (banco principal) ────────────────────────────

async function fetchFromTickets() {
  let whereClause = '';
  const params = [];

  if (!ALL) {
    const conditions = ANOS.map((ano, i) => {
      const ini = `${ano}-01-01`;
      const fim = `${ano}-12-31`;
      params.push(ini, fim);
      return `(createddate >= $${params.length - 1} AND createddate <= $${params.length})`;
    });
    whereClause = `WHERE ${conditions.join(' OR ')}`;
  }

  const sql = `
    SELECT
      id                    AS ticket_id,
      subject               AS servico,
      ownername             AS owner,
      owner_team,
      status,
      urgencia,
      clientname            AS solicitante,
      clientorganization    AS organizacao,
      actionsjson           AS actions,
      actionscount          AS total_acoes,
      createddate           AS aberto_em,
      slasolutiondate       AS resolvido_em
    FROM public.tickets
    ${whereClause}
    ORDER BY createddate ASC
  `;

  log('Consultando tabela tickets...');
  const result = await db.query(sql, params);
  return result.rows || [];
}

// ── Upsert em lotes no curadoria_chamados ────────────────────────────────

async function upsertBatch(rows) {
  if (!rows.length) return { inserted: 0, skipped: 0 };

  let inserted = 0, skipped = 0;

  for (const row of rows) {
    // Conta ações por tipo (agente vs cliente) a partir do JSON já armazenado
    let totalCliente = 0, totalAgente = 0, tempoResolDias = null;

    try {
      const actions = typeof row.actions === 'string'
        ? JSON.parse(row.actions)
        : (row.actions || []);

      totalAgente  = actions.filter(a => a.type === 1).length;
      totalCliente = actions.filter(a => a.type !== 1).length;
    } catch (_) {}

    if (row.aberto_em && row.resolvido_em) {
      const ms = new Date(row.resolvido_em) - new Date(row.aberto_em);
      if (ms > 0) tempoResolDias = Math.round(ms / 86400000 * 10) / 10;
    }

    try {
      const res = await db.queryDatabase(
        'movidesk_curadoria',
        `INSERT INTO public.curadoria_chamados
           (ticket_id, servico, owner, owner_team, status, urgencia,
            solicitante, organizacao, actions, total_acoes, total_cliente, total_agente,
            tempo_resol_dias, aberto_em, resolvido_em, processado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0)
         ON CONFLICT (ticket_id) DO UPDATE SET
           status       = EXCLUDED.status,
           owner_team   = EXCLUDED.owner_team,
           total_acoes  = EXCLUDED.total_acoes,
           aberto_em    = EXCLUDED.aberto_em,
           resolvido_em = EXCLUDED.resolvido_em,
           actions      = EXCLUDED.actions
         WHERE curadoria_chamados.processado = 0`,
        [
          row.ticket_id,
          row.servico      || '',
          row.owner        || '',
          row.owner_team   || '',
          row.status       || '',
          row.urgencia     || '',
          row.solicitante  || '',
          row.organizacao  || '',
          // actions column is TEXT — serialize to string if needed
          (typeof row.actions === 'string' ? row.actions : JSON.stringify(row.actions || [])) || '[]',
          row.total_acoes  || 0,
          totalCliente,
          totalAgente,
          // tempo_resol_dias column is TEXT
          tempoResolDias !== null ? String(tempoResolDias) : null,
          row.aberto_em    ? String(row.aberto_em) : null,
          row.resolvido_em ? String(row.resolvido_em) : null,
        ]
      );
      if ((res.rowCount || 0) > 0) inserted++;
      else skipped++;
    } catch (e) {
      log(`  ❌ ticket_id=${row.ticket_id}: ${e.message}`);
      skipped++;
    }
  }

  return { inserted, skipped };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const filtro = ALL ? 'todos os anos' : ANOS.join(', ');
  log(`🚀 import-curadoria-do-banco.js — período: ${filtro}`);
  log(`   Lendo de: tickets (banco principal) → curadoria_chamados (movidesk_curadoria)\n`);

  const rows = await fetchFromTickets();
  log(`📦 ${rows.length} chamado(s) encontrado(s) na tabela tickets.\n`);

  if (!rows.length) {
    log('Nenhum chamado no período. Encerrando.');
    return;
  }

  let totalInserted = 0, totalSkipped = 0, done = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { inserted, skipped } = await upsertBatch(batch);
    totalInserted += inserted;
    totalSkipped  += skipped;
    done          += batch.length;

    const elapsed   = Date.now() - startedAt;
    const remaining = rows.length - done;
    const eta       = done > 0 ? fmtDuration((elapsed / done) * remaining) : '–';
    const pct       = ((done / rows.length) * 100).toFixed(1);
    log(`  📊 ${done}/${rows.length} (${pct}%) | ✅ ${totalInserted} inseridos | ⏭️  ${totalSkipped} existentes | ETA: ${eta}`);
  }

  log(`\n✅ Concluído em ${fmtDuration(Date.now() - startedAt)}`);
  log(`   ✅ Inseridos: ${totalInserted}`);
  log(`   ⏭️  Já existiam (processado>0): ${totalSkipped}`);
  log(`\n💡 Próximo passo: POST /api/curadoria/full-load para iniciar análise de IA.\n`);
}

main()
  .then(async () => { await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error('\n💥 Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
