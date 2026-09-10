#!/usr/bin/env node
/**
 * enriquecer-curadoria.js
 *
 * FASE 2 do pipeline de importação: para cada janela de mês, pagina a API
 * Movidesk (/tickets e /tickets/past) com os campos completos e atualiza
 * curadoria_chamados para os tickets que ainda estão sem dados.
 *
 * Uso:
 *   node scripts/enriquecer-curadoria.js              (ano atual)
 *   node scripts/enriquecer-curadoria.js 2026
 *   node scripts/enriquecer-curadoria.js 2025 2026
 *
 * Variáveis de ambiente (.env):
 *   MOVIDESK_TOKEN    — X-Gateway-Token
 *   MOVIDESK_API_BASE — URL base da API (default: https://apimovidesk.viasoftcloud.com.br)
 *   IMPORT_RATE_MS    — intervalo entre páginas (default: 2100ms)
 *   ENRICH_PAGE_SIZE  — tickets por página (default: 100)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fetch = require('node-fetch');
const db    = require(path.join(__dirname, '..', 'server', 'db', 'remote'));
const { getToken } = require(path.join(__dirname, '..', 'server', 'routes', 'config'));

// ── Configuração ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ANOS = args.length
  ? args.map(a => parseInt(a, 10)).filter(n => !isNaN(n))
  : [new Date().getFullYear()];

const RATE_MS   = parseInt(process.env.IMPORT_RATE_MS  || '2100', 10);
const PAGE_SIZE = parseInt(process.env.ENRICH_PAGE_SIZE || '100',  10);

const API_BASE    = (process.env.MOVIDESK_API_BASE || 'https://apimovidesk.viasoftcloud.com.br').replace(/\/$/, '');
const URL_CURRENT = `${API_BASE}/public/v1/tickets`;
const URL_PAST    = `${API_BASE}/public/v1/tickets/past`;

const SELECT_DETAILS = 'id,subject,status,baseStatus,createdDate,resolvedIn,ownerTeam,urgency';
const EXPAND_DETAILS = [
  'owner($select=businessName,email)',
  'actions($select=id,type,origin,status,createdDate,description)',
  'clients($select=businessName,email)',
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

// Gera lista de janelas mensais para os anos pedidos
function gerarJanelas(anos) {
  const janelas = [];
  for (const ano of anos) {
    for (let mes = 1; mes <= 12; mes++) {
      const ultimo = new Date(ano, mes, 0).getDate(); // último dia do mês
      janelas.push({
        label:    `${String(mes).padStart(2,'0')}/${ano}`,
        dateFrom: `${ano}-${String(mes).padStart(2,'0')}-01T00:00:00Z`,
        dateTo:   `${ano}-${String(mes).padStart(2,'0')}-${ultimo}T23:59:59Z`,
      });
    }
  }
  return janelas;
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

// ── Busca IDs pendentes no banco (Set para lookup O(1)) ──────────────────────

async function fetchPendingSet() {
  const result = await db.queryDatabase(
    'movidesk_curadoria',
    `SELECT ticket_id FROM public.curadoria_chamados
     WHERE (actions IS NULL OR actions = '' OR actions = '[]')`
  );
  return new Set((result.rows || []).map(r => r.ticket_id));
}

// ── Pagina um endpoint por janela de mês e processa os tickets encontrados ───

async function paginateWindow(token, baseUrl, dateFrom, dateTo, pendingSet, counters) {
  const filter = `createdDate ge ${dateFrom} and createdDate le ${dateTo}`;
  let skip = 0, page = 0;

  while (true) {
    page++;
    const params = new URLSearchParams({
      '$select':  SELECT_DETAILS,
      '$expand':  EXPAND_DETAILS,
      '$filter':  filter,
      '$orderby': 'id asc',
      '$top':     String(PAGE_SIZE),
      '$skip':    String(skip),
    });
    const url = `${baseUrl}?${params.toString()}`;

    let tickets = [];
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
        const raw = await resp.json();
        tickets = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
        break;
      } catch (e) {
        if (attempt === 4) throw e;
        log(`    ⚠️  Tentativa ${attempt + 1} falhou (${e.message}). Aguardando…`);
        await sleep(2000 * (attempt + 1));
      }
    }

    // Processa só os que estão pendentes
    for (const t of tickets) {
      if (!pendingSet.has(t.id)) continue;

      try {
        await updateTicket(t);
        pendingSet.delete(t.id); // não processa de novo no /past
        counters.updated++;
      } catch (e) {
        counters.failed++;
        log(`    ❌ #${t.id}: ${e.message}`);
      }
      counters.done++;
    }

    if (tickets.length < PAGE_SIZE) break; // última página
    skip += PAGE_SIZE;
    await sleep(RATE_MS);
  }
}

// ── Atualiza um registro no banco ────────────────────────────────────────────

async function updateTicket(t) {
  const ownerName   = t.owner?.businessName || '';
  const actions     = Array.isArray(t.actions) ? t.actions : [];
  const firstClient = Array.isArray(t.clients) ? t.clients[0] : null;
  const totalAcoes   = actions.length;
  const totalCliente = actions.filter(a => a.type !== 1).length;
  const totalAgente  = actions.filter(a => a.type === 1).length;
  let tempoResolDias = null;
  if (t.createdDate && t.resolvedIn) {
    const ms = new Date(t.resolvedIn) - new Date(t.createdDate);
    if (ms > 0) tempoResolDias = String(Math.round(ms / 86400000 * 10) / 10);
  }
  await db.queryDatabase(
    'movidesk_curadoria',
    `UPDATE public.curadoria_chamados SET
       servico=$2, owner=$3, owner_team=$4, status=$5, urgencia=$6,
       solicitante=$7, organizacao=$8, actions=$9, total_acoes=$10,
       total_cliente=$11, total_agente=$12, tempo_resol_dias=$13,
       aberto_em=$14, resolvido_em=$15
     WHERE ticket_id = $1`,
    [
      t.id, t.subject||'', ownerName, t.ownerTeam||'', t.status||'', t.urgency||'',
      firstClient?.businessName||'', firstClient?.organization?.businessName||'',
      JSON.stringify(actions), totalAcoes, totalCliente, totalAgente,
      tempoResolDias, t.createdDate||null, t.resolvedIn||null,
    ]
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  log(`🚀 enriquecer-curadoria.js — anos: ${ANOS.join(', ')} | page: ${PAGE_SIZE} | rate: ${RATE_MS}ms`);
  log(`   API: ${API_BASE}\n`);

  const token = await resolveToken();
  log(`🔑 Token obtido.\n`);

  log('🔍 Carregando IDs pendentes do banco...');
  const pendingSet = await fetchPendingSet();
  log(`📦 ${pendingSet.size} chamado(s) sem dados.\n`);

  if (!pendingSet.size) {
    log('✅ Nenhum chamado para enriquecer. Encerrando.');
    return;
  }

  const janelas = gerarJanelas(ANOS);
  const counters = { done: 0, updated: 0, failed: 0 };

  for (const { label, dateFrom, dateTo } of janelas) {
    if (!pendingSet.size) { log(`   ⏭️  Todos processados — pulando meses restantes.`); break; }

    log(`📅 ${label} — ${pendingSet.size} IDs ainda pendentes`);

    for (const baseUrl of [URL_CURRENT, URL_PAST]) {
      const source = baseUrl.includes('/past') ? 'past' : 'current';
      try {
        await paginateWindow(token, baseUrl, dateFrom, dateTo, pendingSet, counters);
      } catch (e) {
        log(`  ❌ Erro fatal em ${source} ${label}: ${e.message}`);
        counters.failed++;
      }
      await sleep(RATE_MS);
    }

    const pct = (((pendingSet.size === 0 ? 1 : 1 - pendingSet.size / (pendingSet.size + counters.updated)) * 100)).toFixed(1);
    const elapsed = Date.now() - startedAt;
    log(`  📊 ✅ ${counters.updated} enriquecidos | ❌ ${counters.failed} erros | pendentes restantes: ${pendingSet.size} | ${fmtDuration(elapsed)}\n`);
  }

  // Marca como -1 os que ficaram no pendingSet sem aparecer na API
  if (pendingSet.size > 0) {
    log(`🔍 ${pendingSet.size} IDs não encontrados na API — marcando processado=-1…`);
    for (const id of pendingSet) {
      await db.queryDatabase('movidesk_curadoria',
        `UPDATE public.curadoria_chamados SET processado = -1 WHERE ticket_id = $1`, [id]).catch(() => {});
    }
  }

  log(`\n✅ Concluído em ${fmtDuration(Date.now() - startedAt)}`);
  log(`   ✅ Enriquecidos: ${counters.updated}`);
  log(`   🔍 Não encontrados (marcados -1): ${pendingSet.size}`);
  log(`   ❌ Erros: ${counters.failed}`);
  log(`\n💡 Próximo passo: Configurações → Curadoria → "Processar tudo agora"\n`);
}

main()
  .then(async () => { await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error('\n💥 Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
