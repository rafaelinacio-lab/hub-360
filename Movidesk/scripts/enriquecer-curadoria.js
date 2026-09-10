#!/usr/bin/env node
/**
 * enriquecer-curadoria.js
 *
 * FASE 2 do pipeline de importação: lê os ticket_ids que estão em
 * movidesk_curadoria.curadoria_chamados sem dados (actions nulo ou vazio)
 * e vai buscar cada chamado na API Movidesk em LOTES DE 15 IDs por requisição,
 * atualizando o registro com os detalhes completos.
 *
 * Uso:
 *   node scripts/enriquecer-curadoria.js              (todos os sem dados)
 *   node scripts/enriquecer-curadoria.js 2026          (só os do ano 2026)
 *   node scripts/enriquecer-curadoria.js 2025 2026     (dois anos)
 *
 * Variáveis de ambiente (.env):
 *   MOVIDESK_TOKEN    — X-Gateway-Token (alternativa ao token do banco)
 *   MOVIDESK_API_BASE — URL base da API (default: https://apimovidesk.viasoftcloud.com.br)
 *   IMPORT_RATE_MS    — intervalo entre lotes (default: 2100ms → ≈28 req/min)
 *   ENRICH_BATCH      — IDs por lote (default: 15)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fetch = require('node-fetch');
const db    = require(path.join(__dirname, '..', 'server', 'db', 'remote'));
const { getToken } = require(path.join(__dirname, '..', 'server', 'routes', 'config'));

// ── Configuração ────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const ANOS  = args.length ? args.map(a => parseInt(a, 10)).filter(n => !isNaN(n)) : [];

const RATE_MS    = parseInt(process.env.IMPORT_RATE_MS || '2100', 10);
const BATCH_SIZE = parseInt(process.env.ENRICH_BATCH   || '15',   10);

const API_BASE    = (process.env.MOVIDESK_API_BASE || 'https://apimovidesk.viasoftcloud.com.br').replace(/\/$/, '');
const URL_CURRENT = `${API_BASE}/public/v1/tickets`;
const URL_PAST    = `${API_BASE}/public/v1/tickets/past`;

const SELECT_DETAILS = 'id,subject,status,baseStatus,createdDate,resolvedIn,ownerTeam,urgency';
const EXPAND_DETAILS = [
  'owner($select=businessName,email)',
  'actions($select=id,type,origin,status,createdDate,description;$orderby=createdDate asc)',
  'clients($select=businessName,email;$expand=organization($select=businessName))',
].join(',');

// ── Utilitários ─────────────────────────────────────────────────────────────

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

async function resolveToken() {
  if (process.env.MOVIDESK_TOKEN) {
    log(`Token lido de MOVIDESK_TOKEN (env). API: ${API_BASE}`);
    return process.env.MOVIDESK_TOKEN;
  }
  return new Promise((resolve, reject) => {
    getToken((err, t) => {
      if (err) return reject(new Error(`Não foi possível obter o token: ${err.message}`));
      log(`Token lido do banco. API: ${API_BASE}`);
      resolve(t);
    });
  });
}

// ── Busca IDs sem dados no banco ─────────────────────────────────────────────

async function fetchPendingIds() {
  let whereClause = `(actions IS NULL OR actions = '' OR actions = '[]')`;
  if (ANOS.length) {
    const anoConditions = ANOS.map(ano => `EXTRACT(YEAR FROM aberto_em::timestamptz) = ${ano}`).join(' OR ');
    whereClause += ` AND (aberto_em IS NULL OR (${anoConditions}))`;
  }
  const result = await db.queryDatabase(
    'movidesk_curadoria',
    `SELECT ticket_id FROM public.curadoria_chamados WHERE ${whereClause} ORDER BY ticket_id ASC`
  );
  return (result.rows || []).map(r => r.ticket_id);
}

// ── Busca um lote de IDs em um endpoint → Map<id, ticket> ────────────────────

async function fetchBatch(token, baseUrl, batchIds) {
  const filter = batchIds.map(id => `id eq ${id}`).join(' or ');
  const params = new URLSearchParams({
    '$select': SELECT_DETAILS,
    '$expand': EXPAND_DETAILS,
    '$filter': filter,
    '$top':    String(batchIds.length),
  });
  const url = `${baseUrl}?${params.toString()}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'X-Gateway-Token': token } });
      if (resp.status === 429) {
        log(`    ⏳ Rate limit (429). Aguardando 65s…`);
        await sleep(65000);
        continue;
      }
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }
      const raw  = await resp.json();
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
      const map  = new Map();
      list.forEach(t => t.id && map.set(t.id, t));
      return map;
    } catch (e) {
      if (attempt === 4) throw e;
      log(`    ⚠️  Tentativa ${attempt + 1} falhou (${e.message}). Aguardando…`);
      await sleep(2000 * (attempt + 1));
    }
  }
  return new Map();
}

// ── Atualiza os registros no banco ───────────────────────────────────────────

async function updateTicket(t) {
  const ownerName   = t.owner?.businessName || '';
  const actions     = Array.isArray(t.actions) ? t.actions : [];
  const firstClient = Array.isArray(t.clients) ? t.clients[0] : null;
  const totalAcoes   = actions.length;
  const totalCliente = actions.filter(a => a.type !== 1).length; // type 1 = agente/interno
  const totalAgente  = actions.filter(a => a.type === 1).length;
  let tempoResolDias = null;
  if (t.createdDate && t.resolvedIn) {
    const ms = new Date(t.resolvedIn) - new Date(t.createdDate);
    if (ms > 0) tempoResolDias = String(Math.round(ms / 86400000 * 10) / 10);
  }
  await db.queryDatabase(
    'movidesk_curadoria',
    `UPDATE public.curadoria_chamados SET
       servico       = $2,
       owner         = $3,
       owner_team    = $4,
       status        = $5,
       urgencia      = $6,
       solicitante   = $7,
       organizacao   = $8,
       actions       = $9,
       total_acoes   = $10,
       total_cliente = $11,
       total_agente  = $12,
       tempo_resol_dias = $13,
       aberto_em     = $14,
       resolvido_em  = $15
     WHERE ticket_id = $1`,
    [
      t.id,
      t.subject    || '',
      ownerName,
      t.ownerTeam  || '',
      t.status     || '',
      t.urgency    || '',
      firstClient?.businessName || '',
      firstClient?.organization?.businessName || '',
      JSON.stringify(actions),
      totalAcoes,
      totalCliente,
      totalAgente,
      tempoResolDias,
      t.createdDate || null,
      t.resolvedIn  || null,
    ]
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const filtro = ANOS.length ? ANOS.join(', ') : 'todos os anos';
  log(`🚀 enriquecer-curadoria.js — período: ${filtro} | lote: ${BATCH_SIZE} IDs/req | rate: ${RATE_MS}ms`);
  log(`   API: ${API_BASE}\n`);

  const token = await resolveToken();
  log(`🔑 Token obtido.\n`);

  log('🔍 Buscando IDs sem dados no banco...');
  const ids = await fetchPendingIds();
  log(`📦 ${ids.length} chamado(s) sem dados encontrados.\n`);

  if (!ids.length) {
    log('✅ Nenhum chamado para enriquecer. Encerrando.');
    return;
  }

  let done = 0, updated = 0, notFound = 0, failed = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);

    try {
      // FASE A: tenta /tickets (abertos/atuais)
      const fromCurrent = await fetchBatch(token, URL_CURRENT, batch);

      // FASE B: os que não vieram → tenta /tickets/past (fechados)
      const missing = batch.filter(id => !fromCurrent.has(id));
      const fromPast = missing.length
        ? await fetchBatch(token, URL_PAST, missing)
        : new Map();

      for (const id of batch) {
        const t = fromCurrent.get(id) || fromPast.get(id);
        if (!t) {
          await db.queryDatabase('movidesk_curadoria',
            `UPDATE public.curadoria_chamados SET processado = -1 WHERE ticket_id = $1`, [id]).catch(() => {});
          notFound++;
        } else {
          await updateTicket(t);
          updated++;
        }
        done++;
      }
    } catch (e) {
      failed += batch.length;
      done   += batch.length;
      if (failed <= 30) log(`  ❌ lote ${batch[0]}–${batch[batch.length-1]}: ${e.message}`);
      else if (failed === 31) log('  ❌ (erros repetidos — veja os acima)');
    }

    // Bail-out: se os primeiros 50 falharem 100%, token provavelmente inválido
    if (done >= 50 && failed === done) {
      log('\n💥 100% de erros — verifique o token e a URL do gateway.');
      process.exit(1);
    }

    if (done % 150 < BATCH_SIZE || done >= ids.length) {
      const elapsed   = Date.now() - startedAt;
      const remaining = ids.length - done;
      const eta       = done > 0 ? fmtDuration((elapsed / done) * remaining) : '–';
      const pct       = ((done / ids.length) * 100).toFixed(1);
      log(`  📊 ${done}/${ids.length} (${pct}%) | ✅ ${updated} enriquecidos | 🔍 ${notFound} não encontrados | ❌ ${failed} erros | ETA: ${eta}`);
    }

    if (i + BATCH_SIZE < ids.length) await sleep(RATE_MS);
  }

  log(`\n✅ Concluído em ${fmtDuration(Date.now() - startedAt)}`);
  log(`   ✅ Enriquecidos: ${updated}`);
  log(`   🔍 Não encontrados na API (marcados -1): ${notFound}`);
  log(`   ❌ Erros: ${failed}`);
  log(`\n💡 Próximo passo: Configurações → Curadoria → "Processar tudo agora"\n`);
}

main()
  .then(async () => { await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error('\n💥 Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
