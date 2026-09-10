#!/usr/bin/env node
/**
 * import-curadoria-ano.js
 *
 * Coleta todos os IDs de um ano inteiro da API Movidesk e insere em
 * `movidesk_curadoria.curadoria_chamados` (processado=0), prontos para o
 * pipeline de enriquecimento (IA, satisfação, módulo x rotina).
 *
 * Lógica:
 *   1. FASE 1 — Coleta IDs: pagina /tickets e /tickets/past com $top=1000
 *      filtrando por createdDate no ano alvo, até esgotar todas as páginas.
 *   2. FASE 2 — Upsert dos IDs no banco: INSERT ticket_id + processado=0.
 *      Chamados já analisados (processado > 0) nunca são tocados.
 *
 * Uso:
 *   node scripts/import-curadoria-ano.js              (ano atual)
 *   node scripts/import-curadoria-ano.js 2026
 *   node scripts/import-curadoria-ano.js 2025
 *   node scripts/import-curadoria-ano.js all          (todos os anos disponíveis na API)
 *
 * Variáveis de ambiente (.env):
 *   MOVIDESK_TOKEN    — token/gateway-token em texto claro (alternativa ao token no banco)
 *   MOVIDESK_API_BASE — URL base da API (default: https://apimovidesk.viasoftcloud.com.br)
 *   IMPORT_RATE_MS    — intervalo entre páginas de paginação (default: 1000ms)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fetch = require('node-fetch');
const db = require(path.join(__dirname, '..', 'server', 'db', 'remote'));
const { getToken } = require(path.join(__dirname, '..', 'server', 'routes', 'config'));

// ── Configuração ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ALL  = args[0] === 'all';
const ANO  = ALL ? null : parseInt(args[0] || String(new Date().getFullYear()), 10);

if (!ALL && (isNaN(ANO) || ANO < 2000 || ANO > 2100)) {
  console.error(`Ano inválido: "${args[0]}". Use um ano entre 2000 e 2100, ou "all".`);
  process.exit(1);
}

const DATE_FROM = ALL ? null : `${ANO}-01-01T00:00:00Z`;
const DATE_TO   = ALL ? null : `${ANO}-12-31T23:59:59Z`;
const FILTER    = ALL
  ? null
  : `createdDate ge ${DATE_FROM} and createdDate le ${DATE_TO}`;

const RATE_MS  = parseInt(process.env.IMPORT_RATE_MS || '1000', 10);
const PAGE_SIZE = 1000;
const INSERT_BATCH = 500; // IDs por lote de INSERT

const API_BASE = (process.env.MOVIDESK_API_BASE || 'https://apimovidesk.viasoftcloud.com.br').replace(/\/$/, '');

const BASE_URLS = [
  `${API_BASE}/public/v1/tickets`,       // chamados abertos / atuais
  `${API_BASE}/public/v1/tickets/past`,  // chamados históricos / fechados
];

// ── Utilitários ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${ts}] ${msg}`);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m ${rs}s`;
}

// Obtém o gateway token da env ou do banco
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

// ── FASE 1: Coleta todos os IDs via paginação da API ───────────────────────

async function collectIds(token) {
  const allIds = new Set();
  const filtro = ALL ? 'todos os registros' : `${ANO}`;
  log(`\n📋 FASE 1 — Coletando IDs (${filtro})…`);

  for (const baseUrl of BASE_URLS) {
    const source = baseUrl.includes('/past') ? 'past' : 'current';
    let skip = 0;
    let page = 0;

    log(`  → ${source}: iniciando paginação`);

    while (true) {
      page++;
      const params = new URLSearchParams({
        '$select': 'id,createdDate',
        '$top':    String(PAGE_SIZE),
        '$skip':   String(skip),
        '$orderby': 'id asc',
      });
      if (FILTER) params.set('$filter', FILTER);

      const url = `${baseUrl}?${params.toString()}`;
      let tickets = [];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(url, { headers: { 'X-Gateway-Token': token } });
          if (resp.status === 429) {
            log(`    ⏳ Rate limit (429). Aguardando ${RATE_MS * 2}ms…`);
            await sleep(RATE_MS * 2);
            continue;
          }
          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
          }
          const raw = await resp.json();
          tickets = Array.isArray(raw) ? raw
                  : Array.isArray(raw?.value) ? raw.value
                  : [];
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          log(`    ⚠️  Tentativa ${attempt + 1} falhou (${e.message}). Tentando novamente…`);
          await sleep(2000 * (attempt + 1));
        }
      }

      const pageIds = tickets.map(t => t.id).filter(Boolean);
      pageIds.forEach(id => allIds.add(id));
      log(`    Página ${page} [skip=${skip}] — ${pageIds.length} IDs (total: ${allIds.size})`);

      if (tickets.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
      await sleep(RATE_MS);
    }
  }

  log(`✅ FASE 1 concluída — ${allIds.size} IDs únicos encontrados.\n`);
  return [...allIds];
}

// ── FASE 2: Insere os IDs em curadoria_chamados ────────────────────────────

async function insertIds(ids) {
  log(`📥 FASE 2 — Inserindo ${ids.length} IDs em curadoria_chamados…`);

  let inserted = 0, skipped = 0, failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < ids.length; i += INSERT_BATCH) {
    const batch = ids.slice(i, i + INSERT_BATCH);

    for (const id of batch) {
      try {
        const res = await db.queryDatabase(
          'movidesk_curadoria',
          `INSERT INTO public.curadoria_chamados (ticket_id, processado)
           VALUES ($1, 0)
           ON CONFLICT (ticket_id) DO NOTHING`,
          [id]
        );
        if ((res.rowCount || 0) > 0) inserted++;
        else skipped++;
      } catch (e) {
        failed++;
        if (failed <= 3) log(`  ❌ ID ${id}: ${e.message}`);
        else if (failed === 4) log('  ❌ (erros repetidos — veja os 3 acima)');
      }
    }

    const done = Math.min(i + INSERT_BATCH, ids.length);
    const elapsed = Date.now() - startedAt;
    const remaining = ids.length - done;
    const eta = done > 0 ? fmtDuration((elapsed / done) * remaining) : '–';
    const pct = ((done / ids.length) * 100).toFixed(1);
    log(`  📊 ${done}/${ids.length} (${pct}%) | ✅ ${inserted} inseridos | ⏭️  ${skipped} já existiam | ❌ ${failed} erros | ETA: ${eta}`);
  }

  return { inserted, skipped, failed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const filtro = ALL ? 'todos os anos' : ANO;
  log(`🚀 import-curadoria-ano.js — período: ${filtro}`);
  log(`   API: ${API_BASE}\n`);

  const token = await resolveToken();
  log(`🔑 Token obtido com sucesso.\n`);

  const ids = await collectIds(token);
  if (!ids.length) {
    log('⚠️  Nenhum ID encontrado. Encerrando.');
    return;
  }

  const { inserted, skipped, failed } = await insertIds(ids);

  log(`\n✅ Concluído em ${fmtDuration(Date.now() - startedAt)}`);
  log(`   Total de IDs coletados: ${ids.length}`);
  log(`   ✅ Inseridos: ${inserted}`);
  log(`   ⏭️  Já existiam (não alterados): ${skipped}`);
  log(`   ❌ Erros: ${failed}`);
  log(`\n💡 Próximo passo: POST /api/curadoria/full-load para iniciar análise de IA.\n`);
}

main()
  .then(async () => { await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error('\n💥 Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
