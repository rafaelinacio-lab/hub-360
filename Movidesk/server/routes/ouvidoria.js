const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');
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
  criado_em
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
module.exports = router;
