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

// API pública do Movidesk — token vai na query string (?token=...).
const MOVIDESK_PUBLIC_API = 'https://api.movidesk.com/public/v1';
const RATE_MS   = parseInt(process.env.IMPORT_RATE_MS || '2100', 10);
const BATCH     = 10;   // IDs por requisição OData (filter OR chain)
const PAGE_SIZE = 50;   // tickets por página na importação

// Campo personalizado que classifica o ticket por fluxo
const CF_CLASSIFICACAO = 23946;

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
  return { running: false, done: 0, total: 0, updated: 0, failed: 0, imported: 0,
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
 * Extrai o valor do campo personalizado 23946 ("Classificação de Ticket").
 * O campo pode ser do tipo lista (items[]) ou texto (value).
 */
function getClassification(ticket) {
  const cfv = Array.isArray(ticket.customFieldValues) ? ticket.customFieldValues : [];
  const cf  = cfv.find(f => f.customFieldId === CF_CLASSIFICACAO);
  if (!cf) return null;
  if (Array.isArray(cf.items) && cf.items.length) {
    return cf.items[0].name || cf.items[0].value || null;
  }
  return cf.value || null;
}

/**
 * Busca tickets criados a partir de `since` na API pública, paginando.
 * Retorna array com todos os registros (pode ser grande).
 */
async function fetchTicketsSince(token, since) {
  const dateStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z'); // ex: 2024-01-01T00:00:00Z
  const tickets = [];
  let skip = 0;

  while (true) {
    const params = new URLSearchParams({
      token,
      '$select':  'id,subject,baseStatus,status,resolvedIn,createdDate,ownerTeam,owner',
      '$filter':  `createdDate ge ${dateStr}`,
      '$expand':  'customFieldValues,owner',
      '$orderby': 'createdDate asc',
      '$top':     String(PAGE_SIZE),
      '$skip':    String(skip),
    });

    const url = `${MOVIDESK_PUBLIC_API}/tickets?${params}`;
    let list = [];
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { timeout: 30000 });
        if (resp.status === 429) {
          await sleep(65000 * (attempt + 1));
          continue;
        }
        if (!resp.ok) break;
        const raw = await resp.json();
        list = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
        break;
      } catch { break; }
    }

    if (!list.length) break;
    tickets.push(...list);
    if (list.length < PAGE_SIZE) break; // última página
    skip += PAGE_SIZE;
    await sleep(RATE_MS);
  }

  return tickets;
}

/**
 * Fase 1: busca tickets novos na API e insere os que ainda não existem.
 * Filtra apenas tickets com CF 23946 igual à classificação esperada.
 *
 * @returns {number} quantidade de tickets inseridos
 */
async function importPhase(token, stateKey, dbName, table) {
  const expectedClass = CF_CLASS_BY_KEY[stateKey];
  if (!expectedClass) return 0;

  // Determina a data de corte: MAX(criado_em) da tabela ou 90 dias atrás
  let since = new Date();
  since.setDate(since.getDate() - IMPORT_WINDOW_DAYS);

  try {
    const { rows } = await db.queryDatabase(dbName,
      `SELECT MAX(criado_em) AS last FROM ${table}`);
    if (rows[0]?.last) {
      const d = new Date(rows[0].last);
      // Subtrai 1 dia da última data para evitar gaps por diferença de fuso
      d.setDate(d.getDate() - 1);
      if (d > since) since = d;
    }
  } catch { /* usa o padrão de 90 dias */ }

  const allTickets = await fetchTicketsSince(token, since);

  let imported = 0;
  for (const t of allTickets) {
    const cls = getClassification(t);
    if (cls !== expectedClass) continue;

    // Tenta extrair nome da organização do proprietário expandido
    const owner = t.owner;
    const orgName = owner?.organization?.businessName
                 || owner?.businessName
                 || owner?.organizationName
                 || null;
    const orgId = owner?.organization?.id
               || owner?.organizationId
               || null;

    try {
      await db.queryDatabase(dbName,
        `INSERT INTO ${table}
           (ticket_id, assunto, organizacao, organizacao_id, criado_em,
            status_movidesk, base_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (ticket_id) DO NOTHING`,
        [
          t.id,
          t.subject   ?? null,
          orgName,
          orgId       ?? null,
          t.createdDate ?? null,
          t.status    ?? null,
          t.baseStatus ?? null,
        ]);
      imported++;
    } catch { /* ignora erros de constraint — pode faltar coluna */ }
  }

  return imported;
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
        state.imported = await importPhase(token, stateKey, dbName, table);
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

module.exports = { syncState, runSync, stopSync, ensureColumns };
