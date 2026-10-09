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
const { escopoVertical, pertence, primeiroNivel } = require('../utils/verticalScope');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');

const FINALIZADO_STATUSES = "('Resolved','Closed','Resolvido','Fechado')";

// Organização pré-calculada — ver comentário equivalente em geral.js e
// refreshTicketOrganizacao em movidesk-loader.js.
const ORG_JOIN = `
  LEFT JOIN silver.ticket_organizacao tc ON tc.ticket_id = t.ticket_id
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
          s.nota, s.comentario, s.respondido_em, quem.nome AS respondido_por,
          cl.valor_texto AS classificacao
        FROM silver.ticket_satisfacao s
        JOIN silver.ticket t ON t.ticket_id = s.ticket_id
        ${ORG_JOIN}
        -- Classificação do chamado (campo 23946), um valor só por chamado — filtro "Classificação" da tela (padrão Suporte Técnico)
        LEFT JOIN LATERAL (
          SELECT cf.valor_texto FROM silver.ticket_campo_customizado cf
          WHERE cf.ticket_id = t.ticket_id AND cf.custom_field_id = 23946 AND NULLIF(btrim(cf.valor_texto), '') IS NOT NULL
          ORDER BY cf.item_ordem LIMIT 1
        ) cl ON true
        LEFT JOIN silver.ticket_cliente quem
          ON quem.ticket_id = t.ticket_id AND quem.cliente_id = s.respondido_por_id
        ${RESPONSAVEL_INFERIDO_LATERAL}
        WHERE s.nota IS NOT NULL
        ORDER BY s.respondido_em DESC NULLS LAST
      `).catch(() => ({ rows: [] })),
    ]);

    // Vertical do chamado = 1º nível do serviço (mesma ideia do GCC). Escopo: quem não é admin vê só as verticais definidas
    // em Pessoas; a equipe só decide quando o chamado está sem serviço.
    const esc = await escopoVertical(req.user.id);
    const comVertical = (rowsRes.rows || []).map((r) => ({ ...r, vertical: primeiroNivel(r.servico).trim() || null }));
    if (!esc.filtrar) return res.json({ universo: universoRes.rows?.[0]?.total || 0, rows: comVertical });
    if (esc.semVertical) return res.json({ universo: 0, rows: [] });
    const rows = comVertical.filter((r) => pertence(esc.verticais, { vertical: r.vertical, equipe: r.vertical ? null : r.equipe }));
    const universo = (await db.query(
      `SELECT COUNT(*)::int AS total FROM silver.ticket t WHERE t.basestatus IN ${FINALIZADO_STATUSES}
         AND (lower(NULLIF(split_part(t.service_full, ' > ', 1), '')) = ANY($1::text[])
              OR (NULLIF(split_part(t.service_full, ' > ', 1), '') IS NULL AND EXISTS (SELECT 1 FROM unnest($1::text[]) v WHERE lower(COALESCE(t.ownerteam,'')) LIKE '%' || v || '%')))`,
      [esc.verticais.map((v) => v.toLowerCase())]
    ).catch(() => ({ rows: [{ total: 0 }] }))).rows[0].total;
    res.json({ universo, rows });
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
