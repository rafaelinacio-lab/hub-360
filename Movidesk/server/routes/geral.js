'use strict';
/**
 * routes/geral.js
 *
 * Painel Geral de Tickets — visão de gestão cobrindo TODA a base de
 * silver.ticket, sem filtro de equipe/classificação (diferente de
 * ouvidoria.js/gcc.js, que só mostram tickets de uma classificação
 * específica, e de tickets.js, que exige equipe configurada pra não
 * varrer o histórico inteiro).
 *
 * GET /geral            — lista completa de tickets + campos calculados
 * GET /geral/:ticketId  — detalhe de um ticket
 * GET /geral/:ticketId/actions — timeline de ações + campos customizados
 */

const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');

const CF_CLASSIFICACAO = 23946; // Classificação de Ticket

// Organização do ticket: mesma heurística validada em ouvidoria.js/gcc.js —
// prioriza contato externo (não @viasoft.com.br, profile_type <> '3') sobre
// o agente interno que às vezes também aparece em clients[].
const ORG_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT organizacao_id, organizacao_nome
    FROM silver.ticket_cliente
    WHERE ticket_id = t.ticket_id
    ORDER BY (email ILIKE '%@viasoft.com.br'), (profile_type = '3'), organizacao_nome IS NULL
    LIMIT 1
  ) tc ON true
`;

const LIST_SELECT = `
  SELECT
    t.ticket_id::varchar AS ticket_id,
    t.subject            AS assunto,
    t.status              AS status_movidesk,
    t.basestatus           AS base_status,
    t.createddate           AS criado_em,
    t.resolved_in            AS resolvido_em,
    t.closed_in                AS fechado_em,
    t.reopened_in                AS reaberto_em,
    t.ownerteam                    AS equipe,
    t.owner_name                    AS responsavel,
    t.urgency                        AS urgencia,
    t.category                        AS categoria,
    t.service_full                     AS servico,
    t.sla_solution_date                 AS sla_solucao,
    tc.organizacao_id,
    tc.organizacao_nome                  AS organizacao,
    cf.valor_texto                        AS classificacao,
    COALESCE(ac.total, 0)                  AS acoes_count,
    COALESCE(ac.publicas, 0)                AS acoes_publicas
  FROM silver.ticket t
  LEFT JOIN silver.ticket_campo_customizado cf
    ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
  ${ORG_LATERAL}
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_public) AS publicas
    FROM silver.ticket_acao
    WHERE ticket_id = t.ticket_id
  ) ac ON true
`;

// ===== GET /geral =====
router.get('/', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  try {
    const result = await db.query(`${LIST_SELECT} ORDER BY t.createddate DESC`);
    res.json(result.rows || []);
  } catch (error) {
    if (error.message && (error.message.includes('does not exist') || error.message.includes('não existe'))) {
      console.warn('[geral] silver.* ainda não existe — retornando vazio');
      return res.json([]);
    }
    console.error('Erro ao buscar painel geral:', error.message);
    res.status(500).json({ error: 'Erro ao carregar dados do painel geral: ' + error.message });
  }
});

// ===== GET /geral/:ticketId =====
router.get('/:ticketId', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  const ticketId = String(req.params.ticketId).trim();
  if (!ticketId) return res.status(400).json({ error: 'ticket_id inválido' });
  try {
    const result = await db.query(`${LIST_SELECT} WHERE t.ticket_id = $1`, [ticketId]);
    const row = result.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Ticket não encontrado' });
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar ticket do painel geral:', error);
    res.status(500).json({ error: 'Erro ao carregar ticket' });
  }
});

// ===== GET /geral/:ticketId/actions =====
router.get('/:ticketId/actions', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  const ticketId = String(req.params.ticketId).trim();
  if (!ticketId) return res.status(400).json({ error: 'ticket_id inválido' });
  try {
    const [acaoRes, cfRes] = await Promise.all([
      db.query(
        `SELECT acao_id AS id, tipo AS type, descricao AS description,
                is_public, status, criado_em AS created_date,
                criado_por_nome
         FROM silver.ticket_acao
         WHERE ticket_id = $1
         ORDER BY criado_em ASC`,
        [ticketId]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT custom_field_id, valor_texto, items_json
         FROM silver.ticket_campo_customizado
         WHERE ticket_id = $1`,
        [ticketId]
      ).catch(() => ({ rows: [] })),
    ]);

    const actions = acaoRes.rows.map(a => ({
      id: a.id,
      type: a.type,
      description: a.description,
      isPublic: a.is_public,
      status: a.status,
      createdDate: a.created_date,
      createdByName: a.criado_por_nome,
    }));

    const customFieldValues = cfRes.rows.map(cf => ({
      customFieldId: cf.custom_field_id,
      value: cf.valor_texto,
      items: cf.items_json ? (() => { try { return JSON.parse(cf.items_json); } catch { return []; } })() : [],
    }));

    res.json({ actions, customFieldValues, fieldDefs: {} });
  } catch (e) {
    console.error('Erro ao buscar ações do painel geral:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ações do chamado' });
  }
});

module.exports = router;
