'use strict';
/**
 * routes/satisfacao.js
 *
 * Painel de Pesquisa de Satisfação — usa a pesquisa real do Movidesk
 * (satisfactionSurveyResponses, modelo "smiley faces" 1-5), sincronizada
 * pelo job POST /api/loader/satisfacao/sync (ver server/scripts/movidesk-loader.js).
 *
 * Fonte dos dados: silver.ticket_satisfacao, no datalake (mesmo banco de
 * silver.ticket) — cobre TODOS os tickets finalizados da empresa, não só um
 * escopo de equipes. Isso substitui a versão anterior, que lia de um banco
 * separado (movidesk_curadoria) limitado ao escopo da Curadoria.
 *
 * GET /satisfacao — lista de avaliações + universo de tickets finalizados
 */

const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');

const FINALIZADO_STATUSES = "('Resolved','Closed','Resolvido','Fechado')";

// Mesma heurística de organização usada em ouvidoria.js/gcc.js/geral.js.
const ORG_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT organizacao_id, organizacao_nome
    FROM silver.ticket_cliente
    WHERE ticket_id = t.ticket_id
    ORDER BY (email ILIKE '%@viasoft.com.br'), (profile_type = '3'), organizacao_nome IS NULL
    LIMIT 1
  ) tc ON true
`;

// Fallback pra quando t.owner_name vem vazio (~32 mil tickets de uma
// importação antiga que nunca trouxe esse campo — ver histórico de
// investigação, 21/09/2026). Em vez de chamar a API de novo, infere o
// responsável a partir de quem mais agiu no chamado (silver.ticket_acao),
// excluindo qualquer autor que já apareça como CLIENTE desse mesmo ticket
// (silver.ticket_cliente) — sobra só gente interna. Cobertura confirmada:
// os 32 mil tickets sem owner_name têm 100% de correspondência com pelo
// menos uma ação de autor não-cliente. Só complementa a exibição, nunca
// sobrescreve silver.ticket.owner_name.
const RESPONSAVEL_INFERIDO_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT a.criado_por_nome AS nome, COUNT(*) AS n
    FROM silver.ticket_acao a
    WHERE a.ticket_id = t.ticket_id
      AND a.criado_por_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM silver.ticket_cliente c
        WHERE c.ticket_id = t.ticket_id AND c.cliente_id = a.criado_por_id
      )
    GROUP BY a.criado_por_nome
    ORDER BY n DESC
    LIMIT 1
  ) inferido ON t.owner_name IS NULL
`;

// ===== GET /satisfacao =====
router.get('/', authMiddleware, requireTabAccess('satisfacao'), async (req, res) => {
  try {
    const [universoRes, rowsRes] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM silver.ticket WHERE basestatus IN ${FINALIZADO_STATUSES}`)
        .catch(() => ({ rows: [{ total: 0 }] })),
      db.query(`
        SELECT
          t.ticket_id, tc.organizacao_nome AS organizacao,
          COALESCE(t.owner_name, inferido.nome) AS responsavel,
          (t.owner_name IS NULL AND inferido.nome IS NOT NULL) AS responsavel_inferido,
          t.ownerteam AS equipe, t.service_full AS servico, t.urgency AS urgencia,
          t.status AS status,
          s.nota, s.comentario, s.respondido_em, quem.nome AS respondido_por
        FROM silver.ticket_satisfacao s
        JOIN silver.ticket t ON t.ticket_id = s.ticket_id
        ${ORG_LATERAL}
        LEFT JOIN silver.ticket_cliente quem
          ON quem.ticket_id = t.ticket_id AND quem.cliente_id = s.respondido_por_id
        ${RESPONSAVEL_INFERIDO_LATERAL}
        WHERE s.nota IS NOT NULL
        ORDER BY s.respondido_em DESC NULLS LAST
      `).catch(() => ({ rows: [] })),
    ]);

    res.json({
      universo: universoRes.rows?.[0]?.total || 0,
      rows: rowsRes.rows || [],
    });
  } catch (error) {
    if (error.message && (error.message.includes('does not exist') || error.message.includes('não existe'))) {
      console.warn('[satisfacao] silver.ticket_satisfacao ainda não existe — retornando vazio');
      return res.json({ universo: 0, rows: [] });
    }
    console.error('Erro ao buscar painel de satisfação:', error.message);
    res.status(500).json({ error: 'Erro ao carregar dados de satisfação: ' + error.message });
  }
});

module.exports = router;
