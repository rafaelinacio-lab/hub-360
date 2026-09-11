'use strict';
/**
 * ticket-sync.js
 *
 * Módulo compartilhado de sincronização de andamento de tickets do Movidesk
 * para as tabelas public.ouvidoria e public.gcc.
 *
 * Consulta a API Movidesk em lotes (10 IDs por requisição) e atualiza:
 *   - status_movidesk : status atual do ticket na plataforma
 *   - base_status     : baseStatus (Open / Resolved / Closed / Cancelled)
 *   - resolvido_em    : timestamp de resolução (resolvedIn)
 *   - sincronizado_em : timestamp desta sincronização
 *
 * As colunas são criadas automaticamente (ADD COLUMN IF NOT EXISTS) caso não
 * existam na tabela alvo — sem risco de quebrar tabelas existentes.
 */

const db         = require('../db/remote');
const fetch      = require('node-fetch');
const { getToken } = require('./config');

// API pública do Movidesk — token vai na query string (?token=...).
// O gateway interno (apimovidesk.viasoftcloud.com.br / X-Gateway-Token) usa
// credenciais diferentes e retorna 401 com o token do config.
const MOVIDESK_PUBLIC_API = 'https://api.movidesk.com/public/v1';
const RATE_MS   = parseInt(process.env.IMPORT_RATE_MS || '2100', 10);
const BATCH     = 10;   // IDs por requisição OData (filter OR chain)

// ── Estado por tabela ─────────────────────────────────────────────────────────
// Cada entrada rastreia um job independente; o front-end faz polling em /status.
const syncState = {
  ouvidoria: mkState(),
  gcc:       mkState(),
};

function mkState() {
  return { running: false, done: 0, total: 0, updated: 0, failed: 0,
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
    await db.queryDatabase(dbName, sql).catch(() => {}); // ignora se já existir
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
        if (!resp.ok) { await sleep(RATE_MS); break; } // outro erro → próximo endpoint
        const raw  = await resp.json();
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
        if (list.length) return list;
        break; // ok mas vazio → tenta tickets/past
      } catch { break; /* erro de rede → próximo endpoint */ }
    }
    await sleep(RATE_MS);
  }
  return [];
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

      // Tickets que ainda não foram fechados OU nunca sincronizados OU cujo
      // status ainda não foi preenchido (base_status IS NULL não é capturado
      // pelo NOT IN, pois NULL NOT IN (...) = NULL em SQL).
      const { rows } = await db.queryDatabase(dbName,
        `SELECT ticket_id FROM ${table}
         WHERE sincronizado_em IS NULL
            OR base_status IS NULL
            OR base_status NOT IN ('Closed','Resolved','Cancelled','Cancelado','Fechado','Resolvido')
         ORDER BY criado_em DESC`);

      state.total = rows.length;
      if (!rows.length) return;

      const token = await new Promise((ok, fail) =>
        getToken((e, t) => e ? fail(e) : ok(t)));

      // Processa em lotes
      for (let i = 0; i < rows.length; i += BATCH) {
        if (!state.running) break; // parou via stopSync()

        const ids    = rows.slice(i, i + BATCH).map(r => r.ticket_id);
        const byId   = {};
        try {
          const tickets = await apiFetch(token, ids);
          for (const t of tickets) byId[t.id] = t;
        } catch { /* vai atualizar sincronizado_em mesmo sem dados da API */ }

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
