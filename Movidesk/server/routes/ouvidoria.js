const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');

// public.ouvidoria fica em movidesk_tickets.
// silver.* fica em movidesk_painel (banco principal do app).
// Como são bancos diferentes no mesmo servidor, o sync faz dois passos:
//   1. db.query()          → lê silver.* no movidesk_painel
//   2. db.queryDatabase()  → upserta em public.ouvidoria no movidesk_tickets
const OUVIDORIA_DB = 'movidesk_tickets';

// CF IDs no datalake
const CF_CLASSIFICACAO  = 23946; // Classificação de Ticket
const CF_TIPO_MANIFESTO = 22000; // Tipo de Manifesto
const CF_MANIFESTO_PROC = 22003; // Manifesto Procedente
const CF_MANIFESTO_DIR  = 38595; // Manifesto direcionado a

// ===== GET /ouvidoria =====
router.get('/', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        t.ticket_id::varchar                                                         AS ticket_id,
        COALESCE(tc.organizacao_nome, t.clientorganization)                          AS organizacao,
        tc.organizacao_id,
        t.subject                                                                    AS assunto_ouvidoria,
        MAX(CASE WHEN cf.custom_field_id = ${CF_TIPO_MANIFESTO} THEN cf.valor_texto END) AS tipo,
        MAX(CASE WHEN cf.custom_field_id = ${CF_MANIFESTO_PROC} THEN cf.valor_texto END) AS manifesto_procedente,
        MAX(CASE WHEN cf.custom_field_id = ${CF_MANIFESTO_DIR}  THEN cf.valor_texto END) AS manifesto_direcionado_a,
        t.createddate   AS criado_em,
        t.status        AS status_movidesk,
        t.basestatus    AS base_status,
        t.resolved_in   AS resolvido_em
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf_class
        ON cf_class.ticket_id = t.ticket_id
        AND cf_class.custom_field_id = ${CF_CLASSIFICACAO}
        AND cf_class.valor_texto = 'Ouvidoria'
      LEFT JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id
      LEFT JOIN LATERAL (
        SELECT organizacao_id, organizacao_nome
        FROM silver.ticket_cliente
        WHERE ticket_id = t.ticket_id
        LIMIT 1
      ) tc ON true
      WHERE t.basestatus IS NULL
         OR t.basestatus NOT IN ('Resolved','Closed','Canceled','Resolvido','Fechado','Cancelado')
      GROUP BY t.ticket_id, tc.organizacao_nome, tc.organizacao_id,
               t.subject, t.createddate, t.status, t.basestatus, t.resolved_in,
               t.clientorganization
      ORDER BY t.createddate DESC
    `);
    res.json(result.rows || []);
  } catch (error) {
    // Se as tabelas silver.* ainda não existem (datalake não carregado), retorna vazio
    if (error.message && (error.message.includes('does not exist') || error.message.includes('não existe'))) {
      console.warn('[ouvidoria] silver.* ainda não existe — retornando vazio');
      return res.json([]);
    }
    console.error('Erro ao buscar ouvidoria:', error.message);
    res.status(500).json({ error: 'Erro ao carregar dados de ouvidoria: ' + error.message });
  }
});

// ===== GET /ouvidoria/:ticketId =====
router.get('/:ticketId', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  const ticketId = String(req.params.ticketId).trim();
  if (!ticketId) return res.status(400).json({ error: 'ticket_id inválido' });

  try {
    const result = await db.query(`
      SELECT
        t.ticket_id::varchar                                                         AS ticket_id,
        COALESCE(tc.organizacao_nome, t.clientorganization)                          AS organizacao,
        tc.organizacao_id,
        t.subject                                                                    AS assunto_ouvidoria,
        MAX(CASE WHEN cf.custom_field_id = ${CF_TIPO_MANIFESTO} THEN cf.valor_texto END) AS tipo,
        MAX(CASE WHEN cf.custom_field_id = ${CF_MANIFESTO_PROC} THEN cf.valor_texto END) AS manifesto_procedente,
        MAX(CASE WHEN cf.custom_field_id = ${CF_MANIFESTO_DIR}  THEN cf.valor_texto END) AS manifesto_direcionado_a,
        t.createddate   AS criado_em,
        t.status        AS status_movidesk,
        t.basestatus    AS base_status,
        t.resolved_in   AS resolvido_em
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf_class
        ON cf_class.ticket_id = t.ticket_id
        AND cf_class.custom_field_id = ${CF_CLASSIFICACAO}
        AND cf_class.valor_texto = 'Ouvidoria'
      LEFT JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id
      LEFT JOIN LATERAL (
        SELECT organizacao_id, organizacao_nome
        FROM silver.ticket_cliente
        WHERE ticket_id = t.ticket_id
        LIMIT 1
      ) tc ON true
      WHERE t.ticket_id = $1
      GROUP BY t.ticket_id, tc.organizacao_nome, tc.organizacao_id,
               t.subject, t.createddate, t.status, t.basestatus, t.resolved_in,
               t.clientorganization
    `, [ticketId]);
    const row = result.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Manifestação não encontrada' });
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar manifestação de ouvidoria:', error);
    res.status(500).json({ error: 'Erro ao carregar manifestação' });
  }
});

// ===== GET /ouvidoria/:ticketId/actions — ações e campos do datalake =====
// Lê exclusivamente de silver.* (datalake), não chama a API do Movidesk.
const STATIC_CF_NAMES = {
  22000: 'Tipo de Manifesto', 22003: 'Manifesto Procedente', 23946: 'Classificação de Ticket',
  24523: 'GCC - Locus Externo', 24986: 'GCC - Locus Interno', 26214: 'GCC - MRR', 26215: 'GCC - Data',
  38595: 'Manifesto direcionado a', 43724: 'GCC - Data Rescisão', 58049: 'GCC - Data Reversão',
  59012: 'GCC - Real Motivo', 61982: 'GCC - Tipo de Locus',
};

router.get('/:ticketId/actions', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  const ticketId = String(req.params.ticketId).trim();
  if (!ticketId) return res.status(400).json({ error: 'ticket_id inválido' });
  try {
    const [acaoRes, cfRes] = await Promise.all([
      db.query(
        `SELECT id, type, description, is_public, status, created_date
         FROM silver.ticket_acao
         WHERE ticket_id = $1
         ORDER BY created_date ASC`,
        [ticketId]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT custom_field_id, valor_texto, items_json
         FROM silver.ticket_campo_customizado
         WHERE ticket_id = $1`,
        [ticketId]
      ).catch(() => ({ rows: [] })),
    ]);

    // Mapeia para o formato esperado pelo frontend
    const actions = acaoRes.rows.map(a => ({
      id: a.id,
      type: a.type,
      description: a.description,
      isPublic: a.is_public,
      status: a.status,
      createdDate: a.created_date,
    }));

    const customFieldValues = cfRes.rows.map(cf => ({
      customFieldId: cf.custom_field_id,
      value: cf.valor_texto,
      items: cf.items_json ? (() => { try { return JSON.parse(cf.items_json); } catch { return []; } })() : [],
    }));

    // fieldDefs: nomes dos campos a partir do mapa estático
    const fieldDefs = Object.fromEntries(
      Object.entries(STATIC_CF_NAMES).map(([id, name]) => [id, name])
    );

    res.json({ actions, customFieldValues, fieldDefs });
  } catch (e) {
    console.error('Erro ao buscar ações de ouvidoria:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ações do chamado' });
  }
});

// ===== Lógica de sync do datalake =====
// Passo 1: lê silver.* no banco principal (movidesk_painel via db.query)
// Passo 2: upserta em public.ouvidoria no movidesk_tickets (db.queryDatabase)
async function syncFromDatalake() {
  // Passo 1 — lê do silver.* (movidesk_painel)
  const { rows } = await db.query(`
    SELECT
      t.ticket_id::varchar(20)                                                   AS ticket_id,
      COALESCE(tc.organizacao_nome, t.clientorganization)                        AS organizacao,
      tc.organizacao_id,
      t.subject                                                                  AS assunto_ouvidoria,
      MAX(CASE WHEN cf.custom_field_id = ${CF_TIPO_MANIFESTO} THEN cf.valor_texto END) AS tipo,
      MAX(CASE WHEN cf.custom_field_id = ${CF_MANIFESTO_PROC} THEN cf.valor_texto END) AS manifesto_procedente,
      MAX(CASE WHEN cf.custom_field_id = ${CF_MANIFESTO_DIR}  THEN cf.valor_texto END) AS manifesto_direcionado_a,
      t.createddate  AS criado_em,
      t.status       AS status_movidesk,
      t.basestatus   AS base_status
    FROM silver.ticket t
    JOIN silver.ticket_campo_customizado cf_class
      ON cf_class.ticket_id = t.ticket_id
      AND cf_class.custom_field_id = ${CF_CLASSIFICACAO}
      AND cf_class.valor_texto = 'Ouvidoria'
    LEFT JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id
    LEFT JOIN LATERAL (
      SELECT organizacao_id, organizacao_nome
      FROM silver.ticket_cliente
      WHERE ticket_id = t.ticket_id
      LIMIT 1
    ) tc ON true
    GROUP BY t.ticket_id, tc.organizacao_nome, tc.organizacao_id,
             t.subject, t.createddate, t.status, t.basestatus
  `);

  if (!rows.length) return { rowCount: 0 };

  // Passo 2 — upserta no movidesk_tickets usando unnest (1 query, N linhas)
  const ids      = rows.map(r => r.ticket_id);
  const orgs     = rows.map(r => r.organizacao     || null);
  const orgIds   = rows.map(r => r.organizacao_id  || null);
  const assuntos = rows.map(r => r.assunto_ouvidoria || null);
  const tipos    = rows.map(r => r.tipo            || null);
  const procs    = rows.map(r => r.manifesto_procedente  || null);
  const dirs     = rows.map(r => r.manifesto_direcionado_a || null);
  const criados  = rows.map(r => r.criado_em       || null);
  const statuses = rows.map(r => r.status_movidesk || null);
  const bases    = rows.map(r => r.base_status     || null);

  const result = await db.queryDatabase(OUVIDORIA_DB, `
    INSERT INTO public.ouvidoria
      (ticket_id, organizacao, organizacao_id, assunto_ouvidoria,
       tipo, manifesto_procedente, manifesto_direcionado_a,
       criado_em, status_movidesk, base_status, sincronizado_em)
    SELECT
      u.ticket_id, u.organizacao, u.organizacao_id, u.assunto_ouvidoria,
      u.tipo, u.manifesto_procedente, u.manifesto_direcionado_a,
      u.criado_em::timestamptz, u.status_movidesk, u.base_status, NOW()
    FROM unnest(
      $1::varchar[],  $2::text[],  $3::text[],  $4::text[],
      $5::text[],     $6::text[],  $7::text[],
      $8::text[],     $9::text[],  $10::text[]
    ) AS u(ticket_id, organizacao, organizacao_id, assunto_ouvidoria,
           tipo, manifesto_procedente, manifesto_direcionado_a,
           criado_em, status_movidesk, base_status)
    ON CONFLICT (ticket_id) DO UPDATE SET
      organizacao             = EXCLUDED.organizacao,
      organizacao_id          = EXCLUDED.organizacao_id,
      assunto_ouvidoria       = EXCLUDED.assunto_ouvidoria,
      tipo                    = EXCLUDED.tipo,
      manifesto_procedente    = EXCLUDED.manifesto_procedente,
      manifesto_direcionado_a = EXCLUDED.manifesto_direcionado_a,
      status_movidesk         = EXCLUDED.status_movidesk,
      base_status             = EXCLUDED.base_status,
      sincronizado_em         = EXCLUDED.sincronizado_em
    WHERE
      public.ouvidoria.status_movidesk            IS DISTINCT FROM EXCLUDED.status_movidesk
      OR public.ouvidoria.base_status             IS DISTINCT FROM EXCLUDED.base_status
      OR public.ouvidoria.assunto_ouvidoria       IS DISTINCT FROM EXCLUDED.assunto_ouvidoria
      OR public.ouvidoria.tipo                    IS DISTINCT FROM EXCLUDED.tipo
      OR public.ouvidoria.manifesto_procedente    IS DISTINCT FROM EXCLUDED.manifesto_procedente
      OR public.ouvidoria.manifesto_direcionado_a IS DISTINCT FROM EXCLUDED.manifesto_direcionado_a
  `, [ids, orgs, orgIds, assuntos, tipos, procs, dirs, criados, statuses, bases]);

  return result;
}

// ===== POST /ouvidoria/sync =====
router.post('/sync', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  const startedAt = new Date().toISOString();
  try {
    const result = await syncFromDatalake();
    res.json({ running: false, done: result.rowCount, updated: result.rowCount, startedAt, finishedAt: new Date().toISOString(), error: null });
  } catch (error) {
    console.error('[ouvidoria] sync datalake error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== POST /ouvidoria/sync/stop =====
router.post('/sync/stop', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  res.json({ running: false });
});

// ===== GET /ouvidoria/sync/status =====
router.get('/sync/status', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  res.json({ running: false, phase: 'idle', done: 0, total: 0 });
});

// Garante colunas novas ao carregar o módulo
db.queryDatabase(OUVIDORIA_DB, `ALTER TABLE public.ouvidoria ADD COLUMN IF NOT EXISTS manifesto_procedente VARCHAR(200)`).catch(() => {});
db.queryDatabase(OUVIDORIA_DB, `ALTER TABLE public.ouvidoria ADD COLUMN IF NOT EXISTS manifesto_direcionado_a VARCHAR(200)`).catch(() => {});

// Chamado pelo agendador em server.js (a cada 2h)
router.runSync = async function () {
  try {
    const result = await syncFromDatalake();
    console.log(`[ouvidoria] sync datalake concluído — ${result.rowCount} linha(s) afetada(s)`);
  } catch (e) {
    console.error('[ouvidoria] sync datalake error:', e.message);
  }
};

module.exports = router;
