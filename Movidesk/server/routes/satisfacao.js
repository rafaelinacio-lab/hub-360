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

// ===== GET /satisfacao =====
router.get('/', authMiddleware, requireTabAccess('satisfacao'), async (req, res) => {
  try {
    const [universoRes, rowsRes] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM silver.ticket WHERE basestatus IN ${FINALIZADO_STATUSES}`)
        .catch(() => ({ rows: [{ total: 0 }] })),
      db.query(`
        SELECT
          t.ticket_id, tc.organizacao_nome AS organizacao, t.owner_name AS responsavel,
          t.ownerteam AS equipe, t.service_full AS servico, t.urgency AS urgencia,
          t.status AS status,
          s.nota, s.comentario, s.respondido_em
        FROM silver.ticket_satisfacao s
        JOIN silver.ticket t ON t.ticket_id = s.ticket_id
        ${ORG_LATERAL}
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
