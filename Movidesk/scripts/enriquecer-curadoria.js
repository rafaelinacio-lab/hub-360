#!/usr/bin/env node
/**
 * enriquecer-curadoria.js
 *
 * FASE 2 do pipeline de importação: lê os ticket_ids que estão em
 * movidesk_curadoria.curadoria_chamados sem dados (actions nulo ou vazio)
 * e vai buscar cada chamado na API Movidesk, atualizando o registro com
 * os detalhes completos (actions, owner, solicitante, status, etc.).
 *
 * Uso:
 *   node scripts/enriquecer-curadoria.js              (todos os sem dados)
 *   node scripts/enriquecer-curadoria.js 2026          (só os do ano 2026)
 *   node scripts/enriquecer-curadoria.js 2025 2026     (dois anos)
 *
 * Variáveis de ambiente (.env):
 *   MOVIDESK_TOKEN    — X-Gateway-Token (alternativa ao token do banco)
 *   MOVIDESK_API_BASE — URL base da API (default: https://apimovidesk.viasoftcloud.com.br)
 *   IMPORT_RATE_MS    — intervalo entre requisições (default: 2100ms → ≈28 req/min)
 *   IMPORT_BATCH_SIZE — paralelo de requisições (default: 1 — seguro para rate limit)
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

const RATE_MS    = parseInt(process.env.IMPORT_RATE_MS    || '2100', 10);
const BATCH_SIZE = parseInt(process.env.IMPORT_BATCH_SIZE || '1',    10);

const API_BASE = (process.env.MOVIDESK_API_BASE || 'https://apimovidesk.viasoftcloud.com.br').replace(/\/$/, '');

const SELECT_DETAILS = 'id,subject,status,baseStatus,createdDate,resolvedIn,ownerTeam,urgency';
// Nota: removido $expand=createdBy dentro de actions para simplificar a URL
// (ponto-e-vírgula dentro de parênteses OData causa 404 em alguns gateways).
// O createdBy dentro de cada action é menos crítico — o owner do chamado já vem separado.
const EXPAND_DETAILS = [
  'owner($select=businessName,email)',
  'actions($select=id,type,origin,status,createdDate,description)',
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
    // Inclui também os que ainda não têm aberto_em (foram inseridos só com ID, sem data)
    whereClause += ` AND (aberto_em IS NULL OR (${anoConditions}))`;
  }

  const result = await db.queryDatabase(
    'movidesk_curadoria',
    `SELECT ticket_id FROM public.curadoria_chamados WHERE ${whereClause} ORDER BY ticket_id ASC`
  );
  return (result.rows || []).map(r => r.ticket_id);
}

// ── Busca detalhes de um ticket na API ───────────────────────────────────────

async function fetchTicketDetails(token, id) {
  // O token "integrator" tem permissão de listar mas não de ler por ID individual.
  // Usamos o endpoint de lista filtrado por id — mesmo caminho que o FASE 1 usa.
  const BASE_PARAMS = {
    '$select': SELECT_DETAILS,
    '$expand': EXPAND_DETAILS,
    '$filter': `id eq ${id}`,
    '$top': '1',
  };

  const LIST_ENDPOINTS = [
    `${API_BASE}/public/v1/tickets`,
    `${API_BASE}/public/v1/tickets/past`,
  ];

  for (const base of LIST_ENDPOINTS) {
    const params = new URLSearchParams(BASE_PARAMS);
    const url = `${base}?${params.toString()}`;

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
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
        if (list.length > 0) return list[0]; // encontrado neste endpoint
        break; // lista vazia — tenta o /past
      } catch (e) {
        if (attempt === 4) throw e;
        log(`    ⚠️  Tentativa ${attempt + 1} falhou para #${id} (${e.message}). Aguardando…`);
        await sleep(2000 * (attempt + 1));
      }
    }
  }

  return null; // não encontrado em nenhum dos dois endpoints
}

// ── Atualiza o registro no banco ──────────────────────────────────────────────

async function updateTicket(t) {
  const ownerName   = t.owner?.businessName || '';
  const ownerEmail  = t.owner?.email || '';
  const actions     = Array.isArray(t.actions) ? t.actions : [];
  const actionsJson = JSON.stringify(actions);

  const firstClient = Array.isArray(t.clients) ? t.clients[0] : null;
  const solicitante = firstClient?.businessName || '';
  const organizacao = firstClient?.organization?.businessName || '';

  const totalAcoes   = actions.length;
  // type 1 = ação interna/agente; outros types = cliente
  // (createdBy não vem mais na resposta para simplificar a URL)
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
      solicitante,
      organizacao,
      actionsJson,
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
  log(`🚀 enriquecer-curadoria.js — período: ${filtro}`);
  log(`   API: ${API_BASE} | rate: ${RATE_MS}ms | batch: ${BATCH_SIZE}\n`);

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

    await Promise.all(batch.map(async (id) => {
      try {
        const ticket = await fetchTicketDetails(token, id);
        if (!ticket) {
          notFound++;
          // Marca como -1 para não tentar de novo (removido da API)
          await db.queryDatabase(
            'movidesk_curadoria',
            `UPDATE public.curadoria_chamados SET processado = -1 WHERE ticket_id = $1`,
            [id]
          ).catch(() => {});
        } else {
          await updateTicket(ticket);
          updated++;
        }
      } catch (e) {
        failed++;
        if (failed <= 5) log(`  ❌ #${id}: ${e.message}`);
        else if (failed === 6) log('  ❌ (erros repetidos — veja os 5 acima)');
      }
      done++;
    }));

    // Bail-out: se os primeiros 10 falharem 100%, token provavelmente inválido
    if (done === 10 && failed === 10) {
      log('\n💥 100% de erros nos primeiros 10 chamados — verifique o token e a URL do gateway.');
      process.exit(1);
    }

    if (done % 50 < BATCH_SIZE || done === ids.length) {
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
  log(`\n💡 Próximo passo: Processar tudo → Configurações → Curadoria → "Processar tudo agora"\n`);
}

main()
  .then(async () => { await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error('\n💥 Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
