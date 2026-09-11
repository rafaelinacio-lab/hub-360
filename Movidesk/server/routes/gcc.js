const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess, getToken } = require('./config');
const fetch = require('node-fetch');

// Lê de public.gcc (populada pelo sync do datalake silver.*)
const GCC_DB = 'movidesk_tickets';

// CF IDs no datalake
const CF_CLASSIFICACAO = 23946; // Classificação de Ticket

const GCC_COLUMNS = `
  ticket_id,
  organizacao,
  organizacao_id,
  assunto_gcc,
  descricao_gcc,
  total_chamados_anteriores,
  analise,
  chamados_organizacao_ids,
  chamados_relacionados,
  servicos_chamados,
  servico_gcc,
  servico_gcc_nome,
  tipo_rescisao AS tipo,
  classificacao_locus,
  motivo_churn,
  cf_24986,
  cf_24523,
  criado_em,
  status_movidesk,
  base_status,
  resolvido_em,
  sincronizado_em
`;

// ===== GET /gcc =====
router.get('/', authMiddleware, requireTabAccess('gcc'), async (req, res) => {
  try {
    const result = await db.queryDatabase(
      GCC_DB,
      `SELECT
         ticket_id, organizacao, organizacao_id, assunto_gcc,
         descricao_gcc, total_chamados_anteriores, analise,
         chamados_organizacao_ids, chamados_relacionados, servicos_chamados,
         servico_gcc, servico_gcc_nome,
         tipo_rescisao AS tipo, classificacao_locus, motivo_churn,
         cf_24986, cf_24523,
         criado_em, status_movidesk, base_status, resolvido_em, sincronizado_em
       FROM public.gcc
       WHERE base_status IS NULL
          OR base_status NOT IN ('Resolved','Closed','Canceled','Resolvido','Fechado','Cancelado')
       ORDER BY criado_em DESC`
    );
    res.json(result.rows || []);
  } catch (error) {
    console.error('Erro ao buscar GCC:', error);
    res.status(500).json({ error: 'Erro ao carregar dados de GCC' });
  }
});

// ===== GET /gcc/:ticketId =====
router.get('/:ticketId', authMiddleware, requireTabAccess('gcc'), async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'ticket_id inválido' });

  try {
    const result = await db.queryDatabase(
      GCC_DB,
      `SELECT
         ticket_id, organizacao, organizacao_id, assunto_gcc,
         descricao_gcc, total_chamados_anteriores, analise,
         chamados_organizacao_ids, chamados_relacionados, servicos_chamados,
         servico_gcc, servico_gcc_nome,
         tipo_rescisao AS tipo, classificacao_locus, motivo_churn,
         cf_24986, cf_24523,
         criado_em, status_movidesk, base_status, resolvido_em, sincronizado_em
       FROM public.gcc WHERE ticket_id = $1`,
      [String(ticketId)]
    );
    const row = result.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Registro não encontrado' });
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar registro de GCC:', error);
    res.status(500).json({ error: 'Erro ao carregar registro' });
  }
});

// ===== GET /gcc/:ticketId/actions — ações e campos do Movidesk =====
const MOVIDESK_TICKETS_API = 'https://apimovidesk.viasoftcloud.com.br/public/v1/tickets';
const MOVIDESK_FIELDS_API  = 'https://apimovidesk.viasoftcloud.com.br/public/v1/customFields';

let _cfCache = null, _cfCacheAt = 0;
async function getCustomFieldDefs(token) {
  if (_cfCache && Date.now() - _cfCacheAt < 3600000) return _cfCache;
  try {
    const resp = await fetch(`${MOVIDESK_FIELDS_API}?token=${encodeURIComponent(token)}`, { timeout: 10000 });
    if (!resp.ok) return {};
    const list = await resp.json();
    _cfCache = Object.fromEntries((Array.isArray(list) ? list : []).map(f => [String(f.id), f.name || `Campo ${f.id}`]));
    _cfCacheAt = Date.now();
    return _cfCache;
  } catch { return {}; }
}

router.get('/:ticketId/actions', authMiddleware, requireTabAccess('gcc'), async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'ticket_id inválido' });
  try {
    const token = await new Promise((ok, fail) => getToken((e, t) => e ? fail(e) : ok(t)));
    const [ticketResp, fieldDefs] = await Promise.all([
      fetch(`${MOVIDESK_TICKETS_API}?${new URLSearchParams({ token, id: String(ticketId), '$expand': 'actions,customFieldValues' })}`, { timeout: 15000 }),
      getCustomFieldDefs(token),
    ]);
    if (!ticketResp.ok) return res.status(ticketResp.status).json({ error: `Movidesk devolveu ${ticketResp.status}` });
    const data = await ticketResp.json();
    res.json({
      actions: Array.isArray(data.actions) ? data.actions : [],
      customFieldValues: Array.isArray(data.customFieldValues) ? data.customFieldValues : [],
      fieldDefs,
    });
  } catch (e) {
    console.error('Erro ao buscar ações de GCC:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ações do chamado' });
  }
});

// ===== POST /gcc/sync — sincroniza do datalake (silver.* → public.gcc) =====
router.post('/sync', authMiddleware, requireTabAccess('gcc'), async (req, res) => {
  const startedAt = new Date().toISOString();
  try {
    const result = await db.queryDatabase(GCC_DB, `
      INSERT INTO public.gcc (
        ticket_id,
        organizacao,
        organizacao_id,
        assunto_gcc,
        criado_em,
        status_movidesk,
        base_status,
        sincronizado_em
      )
      SELECT
        t.ticket_id::varchar(20),
        COALESCE(tc.organizacao_nome, t.clientorganization),
        tc.organizacao_id,
        t.subject,
        t.createddate,
        t.status,
        t.basestatus,
        NOW()
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf_class
        ON cf_class.ticket_id = t.ticket_id
        AND cf_class.custom_field_id = ${CF_CLASSIFICACAO}
        AND cf_class.valor_texto = 'Gestão de Combate ao Churn'
      LEFT JOIN LATERAL (
        SELECT organizacao_id, organizacao_nome
        FROM silver.ticket_cliente
        WHERE ticket_id = t.ticket_id
        LIMIT 1
      ) tc ON true
      ON CONFLICT (ticket_id) DO UPDATE SET
        organizacao     = EXCLUDED.organizacao,
        organizacao_id  = EXCLUDED.organizacao_id,
        assunto_gcc     = EXCLUDED.assunto_gcc,
        status_movidesk = EXCLUDED.status_movidesk,
        base_status     = EXCLUDED.base_status,
        sincronizado_em = EXCLUDED.sincronizado_em
      WHERE
        public.gcc.status_movidesk  IS DISTINCT FROM EXCLUDED.status_movidesk
        OR public.gcc.base_status   IS DISTINCT FROM EXCLUDED.base_status
        OR public.gcc.assunto_gcc   IS DISTINCT FROM EXCLUDED.assunto_gcc
    `);

    res.json({
      running: false,
      done: result.rowCount,
      updated: result.rowCount,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    console.error('[gcc] sync datalake error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== POST /gcc/sync/stop =====
router.post('/sync/stop', authMiddleware, requireTabAccess('gcc'), (req, res) => {
  res.json({ running: false, message: 'Sync via datalake é instantâneo, não há processo para parar.' });
});

// ===== GET /gcc/sync/status =====
router.get('/sync/status', authMiddleware, requireTabAccess('gcc'), (req, res) => {
  res.json({ running: false, phase: 'idle', done: 0, total: 0 });
});

module.exports = router;
