#!/usr/bin/env node
/**
 * import-curadoria-ano.js
 *
 * Importa TODOS os chamados de um ano inteiro da API Movidesk para a tabela
 * `movidesk_curadoria.curadoria_chamados` (processado=0), prontos para o
 * pipeline de enriquecimento (IA, satisfação, módulo x rotina).
 *
 * Lógica equivalente ao workflow n8n fornecido:
 *   1. FASE 1 — Coleta IDs: pagina /tickets e /tickets/past com $top=1000
 *      filtrando por createdDate no ano alvo, até esgotar todas as páginas.
 *   2. FASE 2 — Busca detalhes: para cada ID busca o chamado completo
 *      (actions, owner, clients, customFieldValues).
 *   3. FASE 3 — Upsert no banco: INSERT ... ON CONFLICT DO NOTHING (idempotente).
 *
 * Uso:
 *   node scripts/import-curadoria-ano.js              (ano atual)
 *   node scripts/import-curadoria-ano.js 2026
 *   node scripts/import-curadoria-ano.js 2025
 *
 * Variáveis de ambiente (.env):
 *   MOVIDESK_TOKEN    — token/gateway-token em texto claro (alternativa ao token no banco)
 *   MOVIDESK_API_BASE — URL base da API (default: https://apimovidesk.viasoftcloud.com.br)
 *   IMPORT_RATE_MS    — intervalo entre requisições de detalhe (default: 3000ms)
 *   IMPORT_BATCH_SIZE — tamanho do lote de upserts paralelos (default: 5)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fetch = require('node-fetch');
const db = require(path.join(__dirname, '..', 'server', 'db', 'remote'));
const { getToken } = require(path.join(__dirname, '..', 'server', 'routes', 'config'));
const { decryptToken } = require(path.join(__dirname, '..', 'server', 'utils', 'crypto'));

// ── Configuração ────────────────────────────────────────────────────────────

const ANO = parseInt(process.argv[2] || String(new Date().getFullYear()), 10);
if (isNaN(ANO) || ANO < 2000 || ANO > 2100) {
  console.error(`Ano inválido: "${process.argv[2]}". Use um ano entre 2000 e 2100.`);
  process.exit(1);
}

const DATE_FROM = `${ANO}-01-01T00:00:00Z`;
const DATE_TO   = `${ANO}-12-31T23:59:59Z`;
const FILTER    = `createdDate ge ${DATE_FROM} and createdDate le ${DATE_TO}`;

const RATE_MS       = parseInt(process.env.IMPORT_RATE_MS   || '3000', 10);
const BATCH_SIZE    = parseInt(process.env.IMPORT_BATCH_SIZE || '5',    10);
const PAGE_SIZE     = 1000;

// Gateway proxy Viasoft — usa X-Gateway-Token no header em vez de ?token= na query.
// Fallback para a API oficial do Movidesk se a env não estiver definida.
const API_BASE = (process.env.MOVIDESK_API_BASE || 'https://apimovidesk.viasoftcloud.com.br').replace(/\/$/, '');

const BASE_URLS = [
  `${API_BASE}/public/v1/tickets`,       // chamados abertos / atuais
  `${API_BASE}/public/v1/tickets/past`,  // chamados históricos / fechados
];

const SELECT_IDS     = 'id,createdDate';
const SELECT_DETAILS = 'id,subject,status,baseStatus,createdDate,resolvedIn,ownerTeam,urgency';
const EXPAND_DETAILS = [
  'owner($select=businessName,email)',
  'actions($select=id,type,origin,status,createdDate,description;$expand=createdBy($select=businessName,email))',
  'clients($select=businessName,email;$expand=organization($select=businessName))',
].join(',');

// ── Utilitários ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${ts}] ${msg}`);
}

function pct(done, total) {
  return total ? `${((done / total) * 100).toFixed(1)}%` : '–';
}

// Formata duração em ms → "1h 23m 45s" / "2m 10s" / "45s"
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m ${rs}s`;
}

// Obtém o gateway token: MOVIDESK_TOKEN (env) tem precedência, senão lê do banco.
// Para o gateway apimovidesk.viasoftcloud.com.br o valor vai como X-Gateway-Token no header.
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

// ── FASE 1: Coleta todos os IDs do ano via paginação ───────────────────────

async function collectIds(token) {
  const allIds = new Set();
  log(`\n📋 FASE 1 — Coletando IDs de ${ANO}…`);

  for (const baseUrl of BASE_URLS) {
    const source = baseUrl.includes('/past') ? 'past' : 'current';
    let skip = 0;
    let page = 0;

    log(`  → ${source}: iniciando paginação`);

    while (true) {
      page++;
      const params = new URLSearchParams({
        '$select': SELECT_IDS,
        '$filter': FILTER,
        '$top':    String(PAGE_SIZE),
        '$skip':   String(skip),
        '$orderby': 'id asc',
      });

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
      log(`    Página ${page} [skip=${skip}] — ${pageIds.length} IDs (total acumulado: ${allIds.size})`);

      if (tickets.length < PAGE_SIZE) break; // última página
      skip += PAGE_SIZE;
      await sleep(RATE_MS);
    }
  }

  log(`✅ FASE 1 concluída — ${allIds.size} IDs únicos encontrados em ${ANO}.\n`);
  return [...allIds];
}

// ── FASE 2: Busca detalhes de cada chamado ──────────────────────────────────

async function fetchTicketDetails(token, id) {
  const params = new URLSearchParams({
    '$select': SELECT_DETAILS,
    '$expand': EXPAND_DETAILS,
  });
  const url = `${API_BASE}/public/v1/tickets/${id}?${params.toString()}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, { headers: { 'X-Gateway-Token': token } });
    if (resp.status === 429) { await sleep(RATE_MS * 2); continue; }
    if (resp.status === 404) return null; // removido da API
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return await resp.json();
  }
  return null;
}

// ── FASE 3: Upsert no banco ─────────────────────────────────────────────────

async function upsertTicket(t) {
  const ownerName     = t.owner?.businessName || '';
  const ownerEmail    = t.owner?.email || '';
  const actions       = Array.isArray(t.actions) ? t.actions : [];
  const actionsJson   = JSON.stringify(actions);

  const firstClient   = Array.isArray(t.clients) ? t.clients[0] : null;
  const solicitante   = firstClient?.businessName || '';
  const organizacao   = firstClient?.organization?.businessName || '';

  const totalAcoes    = actions.length;
  const totalCliente  = actions.filter(a => a.type !== 1 && (a.createdBy?.email || '') !== ownerEmail).length;
  const totalAgente   = actions.filter(a => a.type === 1 || (a.createdBy?.email || '') === ownerEmail).length;

  let tempoResolDias = null;
  if (t.createdDate && t.resolvedIn) {
    const ms = new Date(t.resolvedIn) - new Date(t.createdDate);
    if (ms > 0) tempoResolDias = Math.round(ms / 86400000 * 10) / 10;
  }

  const result = await db.queryDatabase(
    'movidesk_curadoria',
    `INSERT INTO public.curadoria_chamados
       (ticket_id, servico, owner, owner_team, status, urgencia,
        solicitante, organizacao, actions, total_acoes, total_cliente, total_agente,
        tempo_resol_dias, aberto_em, resolvido_em, processado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0)
     -- Chamados já analisados (processado > 0) nunca são tocados.
     -- O WHERE no DO UPDATE faz a instrução inteira virar no-op para esses casos:
     -- o PostgreSQL conta como "conflito sem atualização" (rowCount=0 → skipped).
     ON CONFLICT (ticket_id) DO UPDATE SET
       status       = EXCLUDED.status,
       owner_team   = EXCLUDED.owner_team,
       total_acoes  = EXCLUDED.total_acoes,
       aberto_em    = EXCLUDED.aberto_em,
       resolvido_em = EXCLUDED.resolvido_em,
       actions      = EXCLUDED.actions
     WHERE curadoria_chamados.processado = 0`,
    [
      t.id,
      t.subject   || '',
      ownerName,
      t.ownerTeam || '',
      t.status    || '',
      t.urgency   || '',
      solicitante,
      organizacao,
      actionsJson,
      totalAcoes,
      totalCliente,
      totalAgente,
      tempoResolDias !== null ? String(tempoResolDias) : null,
      t.createdDate || null,
      t.resolvedIn  || null,
    ]
  );

  return (result.rowCount || 0) > 0 ? 'inserted' : 'skipped';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  log(`🚀 import-curadoria-ano.js — ano: ${ANO}`);
  log(`   rate: ${RATE_MS}ms entre chamadas de detalhe | batch: ${BATCH_SIZE} paralelo(s)`);
  log(`   filtro: createdDate entre ${DATE_FROM} e ${DATE_TO}\n`);

  // ── Token ──
  const token = await resolveToken();
  log(`🔑 Token Movidesk obtido com sucesso.\n`);

  // ── FASE 1: IDs ──
  const ids = await collectIds(token);
  if (!ids.length) {
    log('⚠️  Nenhum chamado encontrado para o período. Encerrando.');
    return;
  }

  // ── FASE 2 + 3: Detalhes → Upsert ──
  log(`📥 FASE 2+3 — Buscando detalhes e inserindo no banco…`);
  log(`   Total de IDs: ${ids.length} | Estimativa: ~${fmtDuration(ids.length * RATE_MS / BATCH_SIZE)}\n`);

  let done = 0, inserted = 0, skipped = 0, failed = 0;

  // Processa em janelas de BATCH_SIZE paralelos
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (id) => {
      try {
        const ticket = await fetchTicketDetails(token, id);
        if (!ticket) { failed++; return; }
        const result = await upsertTicket(ticket);
        if (result === 'inserted') inserted++;
        else skipped++;
      } catch (e) {
        failed++;
        // Loga o erro completo nas primeiras 3 ocorrências para diagnóstico
        if (failed <= 3) log(`  ❌ ID ${id}: ${e.message}`);
        else if (failed === 4) log('  ❌ (suprimindo erros repetidos — veja os 3 acima)');
      }
      done++;
    }));

    // Bail-out antecipado: se os primeiros 10 derem 100% de erro, algo está errado
    if (done === 10 && failed === 10) {
      log('\n💥 100% de erros nos primeiros 10 chamados — abortando. Verifique a URL e o token do gateway.');
      process.exit(1);
    }

    // Progresso a cada 50 chamados
    if (done % 50 < BATCH_SIZE || done === ids.length) {
      const elapsed = Date.now() - startedAt;
      const remaining = ids.length - done;
      const eta = done > 0 ? fmtDuration((elapsed / done) * remaining) : '–';
      log(`  📊 ${done}/${ids.length} (${pct(done, ids.length)}) | ✅ ${inserted} inseridos | ⏭️  ${skipped} existentes | ❌ ${failed} erros | ETA: ${eta}`);
    }

    if (i + BATCH_SIZE < ids.length) {
      await sleep(RATE_MS);
    }
  }

  const totalTime = fmtDuration(Date.now() - startedAt);
  log(`\n✅ Importação concluída em ${totalTime}`);
  log(`   Chamados de ${ANO}: ${ids.length} IDs`);
  log(`   ✅ Inseridos/atualizados: ${inserted}`);
  log(`   ⏭️  Já existiam (processado>0, não alterados): ${skipped}`);
  log(`   ❌ Erros: ${failed}`);
  log(`\n💡 Próximo passo: inicie o processamento de IA via POST /api/curadoria/full-load`);
  log(`   ou acesse a aba Curadoria → "Importar da API" e clique em "Importar".\n`);
}

main()
  .then(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n💥 Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
