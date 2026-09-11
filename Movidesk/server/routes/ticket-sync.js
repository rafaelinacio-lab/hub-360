'use strict';
/**
 * ticket-sync.js
 *
 * Módulo compartilhado de sincronização de andamento de tickets do Movidesk
 * para as tabelas public.ouvidoria e public.gcc.
 *
 * Fase 1 — Importação:
 *   Consulta a API Movidesk para tickets novos (createdDate >= última data
 *   registrada na tabela, ou 90 dias atrás) com campo personalizado 23946
 *   ("Classificação de Ticket") igual à classificação esperada por tabela e
 *   os insere com INSERT … ON CONFLICT (ticket_id) DO NOTHING.
 *
 * Fase 2 — Sincronização de status:
 *   Consulta a API Movidesk em lotes (10 IDs por requisição) e atualiza:
 *     - status_movidesk : status atual do ticket na plataforma
 *     - base_status     : baseStatus (Open / Resolved / Closed / Cancelled)
 *     - resolvido_em    : timestamp de resolução (resolvedIn)
 *     - sincronizado_em : timestamp desta sincronização
 *
 * As colunas são criadas automaticamente (ADD COLUMN IF NOT EXISTS) caso não
 * existam na tabela alvo — sem risco de quebrar tabelas existentes.
 */

const db         = require('../db/remote');
const fetch      = require('node-fetch');
const { getToken } = require('./config');

// API gateway do Movidesk — token vai na query string (?token=...).
const MOVIDESK_PUBLIC_API = 'https://apimovidesk.viasoftcloud.com.br/public/v1';
const RATE_MS   = parseInt(process.env.IMPORT_RATE_MS || '2100', 10);
const BATCH     = 10;   // IDs por requisição OData (filter OR chain)
const PAGE_SIZE = 50;   // tickets por página na importação

// Campo personalizado que classifica o ticket por fluxo
const CF_CLASSIFICACAO    = 23946;
// Campo "Manifesto direcionado a" — preenchido apenas em tickets de Ouvidoria
const CF_MANIFESTO_DIRIGIDO = 38595;

// Janela padrão de importação caso a tabela esteja vazia
const IMPORT_WINDOW_DAYS = parseInt(process.env.IMPORT_WINDOW_DAYS || '90', 10);

// Classificação esperada por stateKey (deve bater com o valor do CF 23946)
const CF_CLASS_BY_KEY = {
  ouvidoria: 'Ouvidoria',
  gcc:       'Gestão de Combate ao Churn',
};

// ── Estado por tabela ─────────────────────────────────────────────────────────
const syncState = {
  ouvidoria: mkState(),
  gcc:       mkState(),
};

function mkState() {
  return { running: false, done: 0, total: 0, updated: 0, failed: 0,
           imported: 0, importInserted: 0, importUpdated: 0,
           startedAt: null, finishedAt: null, error: null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Migração (idempotente) ────────────────────────────────────────────────────
async function ensureColumns(dbName, table) {
  const cols = [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS status_movidesk VARCHAR(120)`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS base_status     VARCHAR(60)`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS resolvido_em    TIMESTAMPTZ`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sincronizado_em TIMESTAMPTZ`,
  ];
  for (const sql of cols) {
    await db.queryDatabase(dbName, sql).catch(() => {});
  }
}

// ── Busca na API pública do Movidesk (token na query string) ─────────────────
// Tenta /tickets e depois /tickets/past. Retenta o mesmo endpoint até
// MAX_RETRIES vezes em caso de 429 com backoff exponencial.
const MAX_RETRIES = 4;

async function apiFetch(token, ids) {
  const filter = ids.map(id => `id eq ${id}`).join(' or ');
  const baseParams = {
    'token':    token,
    '$select':  'id,status,baseStatus,resolvedIn',
    '$filter':  filter,
    '$orderby': 'id asc',
    '$top':     String(ids.length),
  };

  for (const endpoint of ['tickets', 'tickets/past']) {
    const url = `${MOVIDESK_PUBLIC_API}/${endpoint}?${new URLSearchParams(baseParams).toString()}`;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { timeout: 15000 });
        if (resp.status === 429) {
          await sleep(65000 * (attempt + 1)); // backoff: 65s, 130s, 195s, 260s
          continue;
        }
        if (!resp.ok) { await sleep(RATE_MS); break; }
        const raw  = await resp.json();
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
        if (list.length) return list;
        break;
      } catch { break; }
    }
    await sleep(RATE_MS);
  }
  return [];
}

// ── Importação de novos tickets ───────────────────────────────────────────────

/**
 * Extrai o valor de um campo personalizado da lista customFieldValues.
 * Tenta customFieldItem (lista), depois name, depois value (texto livre).
 */
function extractCfValue(cfv, cfId) {
  const cf = (Array.isArray(cfv) ? cfv : []).find(f => f.customFieldId === cfId);
  if (!cf) return null;
  if (Array.isArray(cf.items) && cf.items.length) {
    return cf.items
      .map(i => String(i.customFieldItem || i.name || i.value || '').trim())
      .filter(Boolean).join(', ') || null;
  }
  return String(cf.value || '').trim() || null;
}

/**
 * Extrai o valor do campo personalizado 23946 ("Classificação de Ticket").
 */
function getClassification(ticket) {
  return extractCfValue(ticket.customFieldValues, CF_CLASSIFICACAO);
}

// Status que indicam ticket encerrado (usado no filtro da API e na query de fase 2)
const CLOSED_STATUSES = ['Resolved', 'Closed', 'Cancelled'];

/**
 * Busca tickets da API pública com um filtro OData arbitrário, paginando.
 * @param {string} token
 * @param {string} oDataFilter  - ex: "baseStatus ne 'Resolved' and ..."
 * @param {string} [endpoint]   - 'tickets' ou 'tickets/past'
 */
async function fetchByFilter(token, oDataFilter, endpoint = 'tickets') {
  const tickets = [];
  let skip = 0;

  while (true) {
    const params = new URLSearchParams({
      token,
      '$select':  'id,subject,baseStatus,status,resolvedIn,createdDate,ownerTeam,owner',
      '$filter':  oDataFilter,
      '$expand':  'customFieldValues,owner',
      '$orderby': 'createdDate desc',
      '$top':     String(PAGE_SIZE),
      '$skip':    String(skip),
    });

    const url = `${MOVIDESK_PUBLIC_API}/${endpoint}?${params}`;
    let list  = [];
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { timeout: 30000 });
        if (resp.status === 429) { await sleep(65000 * (attempt + 1)); continue; }
        if (!resp.ok) break;
        const raw = await resp.json();
        list = Array.isArray(raw) ? raw : (raw?.value || []);
        break;
      } catch { break; }
    }

    if (!list.length) break;
    tickets.push(...list);
    if (list.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    await sleep(RATE_MS);
  }

  return tickets;
}

/**
 * Fase 1 — Sincronização completa de tickets:
 *   Busca tickets dos últimos IMPORT_WINDOW_DAYS (ou desde o mais recente no banco)
 *   e faz UPSERT: INSERT se não existe, UPDATE se status/manifesto mudou.
 *
 * @returns {{ inserted: number, updated: number }}
 */
async function importPhase(token, stateKey, dbName, table) {
  const expectedClass = CF_CLASS_BY_KEY[stateKey];
  if (!expectedClass) return { inserted: 0, updated: 0 };

  // Nome da tabela sem schema (para o ON CONFLICT ... WHERE clause)
  const tableAlias = table.split('.').pop();

  // ── Janela de importação: desde o ticket mais recente no banco (−1 dia)
  //    ou IMPORT_WINDOW_DAYS atrás, o que for mais antigo ─────────────────────
  let since = new Date();
  since.setDate(since.getDate() - IMPORT_WINDOW_DAYS);
  try {
    const { rows } = await db.queryDatabase(dbName,
      `SELECT MAX(criado_em) AS last FROM ${table}`);
    if (rows[0]?.last) {
      const d = new Date(rows[0].last);
      d.setDate(d.getDate() - 1);
      if (d > since) since = d;
    }
  } catch {}

  const dateStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const allTickets = await fetchByFilter(token, `createdDate ge ${dateStr}`);

  // ── Deduplica por id ────────────────────────────────────────────────────────
  const ticketMap = new Map();
  for (const t of allTickets) ticketMap.set(t.id, t);

  // ── UPSERT para cada ticket da classificação certa ─────────────────────────
  let inserted = 0, updated = 0;

  for (const t of ticketMap.values()) {
    if (getClassification(t) !== expectedClass) continue;

    const owner   = t.owner;
    const orgName = owner?.organization?.businessName
                 || owner?.businessName
                 || owner?.organizationName
                 || null;
    const orgId   = owner?.organization?.id ?? owner?.organizationId ?? null;
    const manifesto = stateKey === 'ouvidoria'
      ? extractCfValue(t.customFieldValues, CF_MANIFESTO_DIRIGIDO)
      : null;

    try {
      if (stateKey === 'ouvidoria') {
        const r = await db.queryDatabase(dbName,
          `INSERT INTO ${table}
             (ticket_id, assunto, organizacao, organizacao_id, criado_em,
              status_movidesk, base_status, manifesto_direcionado_a, sincronizado_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (ticket_id) DO UPDATE SET
             status_movidesk         = EXCLUDED.status_movidesk,
             base_status             = EXCLUDED.base_status,
             manifesto_direcionado_a = COALESCE(EXCLUDED.manifesto_direcionado_a,
                                                ${tableAlias}.manifesto_direcionado_a),
             sincronizado_em         = NOW()
           WHERE ${tableAlias}.status_movidesk  IS DISTINCT FROM EXCLUDED.status_movidesk
              OR ${tableAlias}.base_status       IS DISTINCT FROM EXCLUDED.base_status
              OR (EXCLUDED.manifesto_direcionado_a IS NOT NULL
                  AND ${tableAlias}.manifesto_direcionado_a
                      IS DISTINCT FROM EXCLUDED.manifesto_direcionado_a)`,
          [
            String(t.id),
            t.subject     ?? null,
            orgName,
            orgId != null ? String(orgId) : null,
            t.createdDate ?? null,
            t.status      ?? null,
            t.baseStatus  ?? null,
            manifesto,
          ]);
        // xmax = 0 → INSERT; xmax != 0 → UPDATE
        if (r.rowCount > 0) {
          const wasInsert = !r.rows?.[0]; // DO UPDATE retorna linha; INSERT não retorna
          // Verifica pelo rowCount se houve alteração
          if (r.command === 'INSERT') inserted++; else updated++;
        }
      } else {
        const r = await db.queryDatabase(dbName,
          `INSERT INTO ${table}
             (ticket_id, assunto, organizacao, organizacao_id, criado_em,
              status_movidesk, base_status, sincronizado_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (ticket_id) DO UPDATE SET
             status_movidesk = EXCLUDED.status_movidesk,
             base_status     = EXCLUDED.base_status,
             sincronizado_em = NOW()
           WHERE ${tableAlias}.status_movidesk IS DISTINCT FROM EXCLUDED.status_movidesk
              OR ${tableAlias}.base_status      IS DISTINCT FROM EXCLUDED.base_status`,
          [
            String(t.id),
            t.subject     ?? null,
            orgName,
            orgId != null ? String(orgId) : null,
            t.createdDate ?? null,
            t.status      ?? null,
            t.baseStatus  ?? null,
          ]);
        if (r.command === 'INSERT') inserted++; else if (r.rowCount > 0) updated++;
      }
    } catch (e) {
      console.error(`[ticket-sync] upsert ticket ${t.id}:`, e.message);
    }
  }

  return { inserted, updated };
}

// ── Backfill de "Manifesto direcionado a" para tickets de Ouvidoria ──────────
/**
 * Atualiza tickets de Ouvidoria onde manifesto_direcionado_a ainda é NULL,
 * buscando o CF 38595 na API pública em lotes de BATCH tickets.
 */
async function backfillManifesto(token, dbName, table) {
  let rows;
  try {
    ({ rows } = await db.queryDatabase(dbName,
      `SELECT ticket_id FROM ${table}
       WHERE manifesto_direcionado_a IS NULL
       ORDER BY criado_em DESC
       LIMIT 300`));
  } catch { return; }

  for (let i = 0; i < rows.length; i += BATCH) {
    const ids    = rows.slice(i, i + BATCH).map(r => r.ticket_id);
    const filter = ids.map(id => `id eq ${id}`).join(' or ');
    const url    = `${MOVIDESK_PUBLIC_API}/tickets?${new URLSearchParams({
      token,
      '$expand':  'customFieldValues',
      '$filter':  filter,
      '$top':     String(ids.length),
    })}`;

    try {
      const resp = await fetch(url, { timeout: 15000 });
      if (!resp.ok) { await sleep(RATE_MS); continue; }
      const raw  = await resp.json();
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);

      for (const t of list) {
        const manifesto = extractCfValue(t.customFieldValues, CF_MANIFESTO_DIRIGIDO);
        if (!manifesto) continue;
        await db.queryDatabase(dbName,
          `UPDATE ${table} SET manifesto_direcionado_a = $2 WHERE ticket_id = $1`,
          [String(t.id), manifesto]).catch(() => {});
      }
    } catch {}
    await sleep(RATE_MS);
  }
}

// ── Loop principal ─────────────────────────────────────────────────────────────
async function runSync(stateKey, dbName, table) {
  const state = syncState[stateKey];
  if (state.running) return state;

  Object.assign(state, mkState());
  state.running    = true;
  state.startedAt  = new Date().toISOString();

  ;(async () => {
    try {
      await ensureColumns(dbName, table);

      const token = await new Promise((ok, fail) =>
        getToken((e, t) => e ? fail(e) : ok(t)));

      // ── Fase 1: importar tickets novos ──────────────────────────────────────
      try {
        const imp = await importPhase(token, stateKey, dbName, table);
        state.imported = (imp?.inserted ?? 0) + (imp?.updated ?? 0);
        state.importInserted = imp?.inserted ?? 0;
        state.importUpdated  = imp?.updated  ?? 0;
      } catch (e) {
        // Falha na importação não impede a sincronização de status
        console.error(`[ticket-sync] importPhase(${stateKey}) error:`, e.message);
      }

      // ── Fase 2: atualizar status dos tickets existentes ─────────────────────
      const { rows } = await db.queryDatabase(dbName,
        `SELECT ticket_id FROM ${table}
         WHERE sincronizado_em IS NULL
            OR base_status IS NULL
            OR base_status NOT IN ('Closed','Resolved','Cancelled','Cancelado','Fechado','Resolvido')
         ORDER BY criado_em DESC`);

      state.total = rows.length;

      for (let i = 0; i < rows.length; i += BATCH) {
        if (!state.running) break;

        const ids  = rows.slice(i, i + BATCH).map(r => r.ticket_id);
        const byId = {};
        try {
          const tickets = await apiFetch(token, ids);
          for (const t of tickets) byId[t.id] = t;
        } catch {}

        for (const id of ids) {
          const t = byId[id];
          try {
            await db.queryDatabase(dbName,
              `UPDATE ${table} SET
                 status_movidesk = $2,
                 base_status     = $3,
                 resolvido_em    = $4,
                 sincronizado_em = NOW()
               WHERE ticket_id = $1`,
              [id, t?.status ?? null, t?.baseStatus ?? null, t?.resolvedIn ?? null]);
            state.updated++;
          } catch { state.failed++; }
          state.done++;
        }

        await sleep(RATE_MS);
      }
      // ── Fase 3 (Ouvidoria): preencher manifesto_direcionado_a nos tickets sem ele ──
      if (stateKey === 'ouvidoria') {
        try {
          await backfillManifesto(token, dbName, table);
        } catch (e) {
          console.error('[ticket-sync] backfillManifesto error:', e.message);
        }
      }

    } catch (e) {
      state.error = e.message;
    } finally {
      state.running    = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return state; // retorna imediatamente; o loop roda em background
}

function stopSync(stateKey) {
  syncState[stateKey].running = false;
}

module.exports = { syncState, runSync, stopSync, ensureColumns, backfillManifesto };
