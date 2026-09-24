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

// baseStatus que tiram o ticket de "pendente" (mesmas listas de
// FINALIZADO_STATUSES/CANCELADO_STATUSES em pages/geral.html — isAberto lá é
// !finalizado && !cancelado).
const OPEN_EXCLUDED_STATUSES = ['Resolved', 'Closed', 'Resolvido', 'Fechado', 'Canceled', 'Cancelado'];

// Organização do ticket: pré-calculada em silver.ticket_organizacao (ver
// refreshTicketOrganizacao em movidesk-loader.js) com a mesma heurística
// usada em ouvidoria.js/gcc.js (prioriza contato externo — não
// @viasoft.com.br, profile_type <> '3' — sobre o agente interno que às vezes
// também aparece em clients[]). Antes era um LEFT JOIN LATERAL correlacionado
// direto em silver.ticket_cliente — media ~9s sozinho com a base em ~720 mil
// tickets (medido em produção em 22/09/2026), o suficiente pra estourar o
// timeout do Painel Geral. Materializar troca isso por um JOIN indexado simples.
const ORG_JOIN = `
  LEFT JOIN silver.ticket_organizacao tc ON tc.ticket_id = t.ticket_id
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
    t.last_update                        AS ultima_interacao,
    tc.organizacao_id,
    tc.organizacao_nome                  AS organizacao,
    cf.valor_texto                        AS classificacao,
    COALESCE(ac.total, 0)                  AS acoes_count,
    COALESCE(ac.publicas, 0)                AS acoes_publicas
  FROM silver.ticket t
  LEFT JOIN silver.ticket_campo_customizado cf
    ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
  ${ORG_JOIN}
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_public) AS publicas
    FROM silver.ticket_acao
    WHERE ticket_id = t.ticket_id
  ) ac ON true
`;

// Sem filtro de equipe/classificação (ao contrário de ouvidoria.js/gcc.js),
// silver.ticket inteira aqui já passou de 720 mil linhas — buscar tudo de uma
// vez transporta dezenas de MB de JSON e estoura o timeout do frontend
// (90s), mesmo com os joins todos indexados (medido em produção em
// 22/09/2026: a query em si roda rápido, o volume que não cabe). Por padrão
// limita a janela ao ano vigente (1º de janeiro até agora); ?todos=1 busca
// tudo (uso explícito e consciente, via botão "Carregar histórico completo"
// no frontend) e ?desde=YYYY-MM-DD permite uma janela customizada.
// ===== GET /geral =====
router.get('/', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  try {
    const todos = req.query.todos === '1' || req.query.todos === 'true';
    const desdeParam = String(req.query.desde || '').trim();
    const desde = !todos
      ? (/^\d{4}-\d{2}-\d{2}$/.test(desdeParam) ? desdeParam : null)
      : null;

    const params = [];
    let whereClause = '';
    if (!todos) {
      if (desde) {
        params.push(desde);
        whereClause = `WHERE t.createddate >= $1::date`;
      } else {
        whereClause = `WHERE t.createddate >= date_trunc('year', NOW())`;
      }
    }

    const result = await db.query(
      `${LIST_SELECT} ${whereClause} ORDER BY t.createddate DESC`,
      params
    );
    res.json({
      rows: result.rows || [],
      janela: todos ? null : (desde || 'ano-vigente'),
    });
  } catch (error) {
    if (error.message && (error.message.includes('does not exist') || error.message.includes('não existe'))) {
      console.warn('[geral] silver.* ainda não existe — retornando vazio');
      return res.json({ rows: [], janela: null });
    }
    console.error('Erro ao buscar painel geral:', error.message);
    res.status(500).json({ error: 'Erro ao carregar dados do painel geral: ' + error.message });
  }
});

// ===== GET /geral/pendentes =====
// Todos os tickets atualmente em aberto, de QUALQUER ano — independente da
// janela padrão (ano vigente) do GET /geral acima. O card "Tickets
// pendentes" precisa refletir o backlog real, não só o que está carregado
// no período em tela; como só tickets ABERTOS entram aqui (não a base
// inteira de ~720 mil), o volume fica pequeno o bastante pra sempre buscar
// tudo de uma vez, sem paginação nem janela de data.
router.get('/pendentes', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  try {
    const closedList = OPEN_EXCLUDED_STATUSES.map(s => `'${s}'`).join(',');
    const result = await db.query(
      `${LIST_SELECT} WHERE t.basestatus NOT IN (${closedList}) ORDER BY t.createddate DESC`
    );
    res.json({ rows: result.rows || [] });
  } catch (error) {
    if (error.message && (error.message.includes('does not exist') || error.message.includes('não existe'))) {
      console.warn('[geral] silver.* ainda não existe — retornando vazio (pendentes)');
      return res.json({ rows: [] });
    }
    console.error('Erro ao buscar pendentes do painel geral:', error.message);
    res.status(500).json({ error: 'Erro ao carregar pendentes do painel geral: ' + error.message });
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
                criado_por_nome, criado_por_email, criado_por_profile_type
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
      createdByEmail: a.criado_por_email,
      createdByProfileType: a.criado_por_profile_type,
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
