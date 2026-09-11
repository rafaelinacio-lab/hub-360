const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess, getToken } = require('./config');
const fetch = require('node-fetch');
const { syncState, runSync, stopSync } = require('./ticket-sync');

// Tabela public.ouvidoria é alimentada por um processo externo (fora deste painel), que já
// grava prontos: a análise de IA (coluna `analise`), o serviço identificado da manifestação
// (servico_ouvidoria/servico_ouvidoria_nome) e os chamados de suporte do cliente que
// explicam a reincidência, com o motivo já redigido pela IA (chamados_relacionados).
// Esta rota só lê e expõe esses dados, sem cruzar com nenhuma outra base.
const OUVIDORIA_DB = 'movidesk_tickets';

const OUVIDORIA_COLUMNS = `
  ticket_id,
  organizacao,
  organizacao_id,
  assunto_ouvidoria,
  descricao_ouvidoria,
  total_chamados_anteriores,
  analise,
  chamados_organizacao_ids,
  chamados_relacionados,
  servicos_chamados,
  servico_ouvidoria,
  servico_ouvidoria_nome,
  tipo,
  criado_em,
  status_movidesk,
  base_status,
  resolvido_em,
  sincronizado_em
`;

// ===== GET /ouvidoria =====
router.get('/', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  try {
    const result = await db.queryDatabase(
      OUVIDORIA_DB,
      `SELECT ${OUVIDORIA_COLUMNS} FROM public.ouvidoria ORDER BY criado_em DESC`
    );
    res.json(result.rows || []);
  } catch (error) {
    console.error('Erro ao buscar ouvidoria:', error);
    res.status(500).json({ error: 'Erro ao carregar dados de ouvidoria' });
  }
});

// ===== GET /ouvidoria/:ticketId =====
router.get('/:ticketId', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'ticket_id inválido' });

  try {
    const result = await db.queryDatabase(
      OUVIDORIA_DB,
      `SELECT ${OUVIDORIA_COLUMNS} FROM public.ouvidoria WHERE ticket_id = $1`,
      [ticketId]
    );
    const row = result.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Manifestação não encontrada' });
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar manifestação de ouvidoria:', error);
    res.status(500).json({ error: 'Erro ao carregar manifestação' });
  }
});

// ===== GET /ouvidoria/:ticketId/actions — ações e campos do Movidesk =====
const MOVIDESK_TICKETS_API = 'https://api.movidesk.com/public/v1/tickets';
const MOVIDESK_FIELDS_API  = 'https://api.movidesk.com/public/v1/customFields';

// Cache de definições de campos personalizados (válido por 1 hora)
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

router.get('/:ticketId/actions', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
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
    console.error('Erro ao buscar ações de ouvidoria:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ações do chamado' });
  }
});

// ===== POST /ouvidoria/sync — inicia sincronização de andamento =====
router.post('/sync', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  const state = runSync('ouvidoria', OUVIDORIA_DB, 'public.ouvidoria');
  res.json(state);
});

// ===== POST /ouvidoria/sync/stop =====
router.post('/sync/stop', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  stopSync('ouvidoria');
  res.json(syncState.ouvidoria);
});

// ===== GET /ouvidoria/sync/status =====
router.get('/sync/status', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  res.json(syncState.ouvidoria);
});

router.runSync = () => runSync('ouvidoria', OUVIDORIA_DB, 'public.ouvidoria');

// Garante que as colunas de sincronização existam assim que o módulo for carregado,
// antes de qualquer SELECT que as liste.
const { ensureColumns: _ensureOuvidoria } = require('./ticket-sync');
_ensureOuvidoria(OUVIDORIA_DB, 'public.ouvidoria').catch(() => {});

module.exports = router;
