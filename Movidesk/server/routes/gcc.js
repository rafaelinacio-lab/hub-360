const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess, getToken } = require('./config');
const fetch = require('node-fetch');
const { syncState, runSync, stopSync } = require('./ticket-sync');

// Tabela public.gcc segue o mesmo padrão de public.ouvidoria: alimentada por um processo
// externo (fora deste painel), que já grava prontos a análise de IA (coluna `analise`), o
// tipo/serviço identificados (tipo, servico_gcc/servico_gcc_nome) e os chamados de suporte
// do cliente que explicam a reincidência, com o motivo já redigido pela IA
// (chamados_relacionados). Esta rota só lê e expõe esses dados.
const GCC_DB = 'movidesk_tickets';

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
      `SELECT ${GCC_COLUMNS} FROM public.gcc
       WHERE base_status IS NULL
          OR base_status NOT IN ('Resolved','Closed','Cancelled','Resolvido','Fechado','Cancelado')
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
      `SELECT ${GCC_COLUMNS} FROM public.gcc WHERE ticket_id = $1`,
      [ticketId]
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

// ===== POST /gcc/sync — inicia sincronização de andamento =====
router.post('/sync', authMiddleware, requireTabAccess('gcc'), (req, res) => {
  const state = runSync('gcc', GCC_DB, 'public.gcc');
  res.json(state);
});

// ===== POST /gcc/sync/stop =====
router.post('/sync/stop', authMiddleware, requireTabAccess('gcc'), (req, res) => {
  stopSync('gcc');
  res.json(syncState.gcc);
});

// ===== GET /gcc/sync/status =====
router.get('/sync/status', authMiddleware, requireTabAccess('gcc'), (req, res) => {
  res.json(syncState.gcc);
});

router.runSync = () => runSync('gcc', GCC_DB, 'public.gcc');

// Garante que as colunas de sincronização existam assim que o módulo for carregado.
const { ensureColumns: _ensureGcc } = require('./ticket-sync');
_ensureGcc(GCC_DB, 'public.gcc').catch(() => {});

module.exports = router;
