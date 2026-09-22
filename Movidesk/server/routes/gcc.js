const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');

// GCC lê direto de silver.* (datalake) em movidesk_painel — não usa mais
// public.gcc em movidesk_tickets nem chama a API do Movidesk pra exibir dados.

// CF IDs no datalake
const CF_CLASSIFICACAO  = 23946; // Classificação de Ticket
const CF_LOCUS_EXTERNO  = 24523; // GCC - Locus Externo
const CF_LOCUS_INTERNO  = 24986; // GCC - Locus Interno
const CF_MRR            = 26214; // GCC - MRR
const CF_DATA_MRR       = 26215; // GCC - Data
const CF_DATA_RESCISAO  = 43724; // GCC - Data Rescisão
const CF_DATA_REVERSAO  = 58049; // GCC - Data Reversão
const CF_REAL_MOTIVO    = 59012; // GCC - Real Motivo
const CF_TIPO_LOCUS     = 61982; // GCC - Tipo de Locus
const CF_TIPO_RESCISAO  = 87894;  // GCC - Tipo Rescisão (Total/Parcial)
const CF_TIPO_RESC_PARC = 216954; // GCC - Tipo de Rescisão Parcial (Módulos/Usuários)
const CF_MODULOS        = 216958; // GCC - Módulos
const CF_VERTICAL       = 98697;  // GCC - Verticais Insatisfação (confirmado com dado real: "Agrotitan" etc.)

// ===== GET /gcc =====
router.get('/', authMiddleware, requireTabAccess('gcc'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        t.ticket_id::varchar                                                        AS ticket_id,
        tc.organizacao_nome                                                         AS organizacao,
        tc.organizacao_id,
        t.subject                                                                   AS assunto_gcc,
        t.service_full                                                              AS servico_gcc,
        MAX(CASE WHEN cf.custom_field_id = ${CF_TIPO_LOCUS}    THEN cf.valor_texto END) AS classificacao_locus,
        MAX(CASE WHEN cf.custom_field_id = ${CF_REAL_MOTIVO}   THEN cf.valor_texto END) AS motivo_churn,
        MAX(CASE WHEN cf.custom_field_id = ${CF_LOCUS_EXTERNO} THEN cf.valor_texto END) AS cf_24523,
        MAX(CASE WHEN cf.custom_field_id = ${CF_LOCUS_INTERNO} THEN cf.valor_texto END) AS cf_24986,
        MAX(CASE WHEN cf.custom_field_id = ${CF_MRR}           THEN cf.valor_texto END) AS mrr,
        MAX(CASE WHEN cf.custom_field_id = ${CF_DATA_MRR}      THEN cf.valor_texto END) AS data_mrr,
        MAX(CASE WHEN cf.custom_field_id = ${CF_DATA_RESCISAO} THEN cf.valor_texto END) AS data_rescisao,
        MAX(CASE WHEN cf.custom_field_id = ${CF_DATA_REVERSAO} THEN cf.valor_texto END) AS data_reversao,
        MAX(CASE WHEN cf.custom_field_id = ${CF_TIPO_RESCISAO}  THEN cf.valor_texto END) AS tipo_rescisao,
        MAX(CASE WHEN cf.custom_field_id = ${CF_TIPO_RESC_PARC} THEN cf.valor_texto END) AS tipo_rescisao_parcial,
        MAX(CASE WHEN cf.custom_field_id = ${CF_MODULOS}        THEN cf.valor_texto END) AS modulos,
        MAX(CASE WHEN cf.custom_field_id = ${CF_VERTICAL}       THEN cf.valor_texto END) AS vertical,
        t.createddate   AS criado_em,
        t.status        AS status_movidesk,
        t.basestatus    AS base_status,
        t.resolved_in   AS resolvido_em,
        t.owner_name    AS responsavel,
        t.urgency       AS urgencia,
        t.sla_solution_date AS sla_solucao,
        COALESCE(ac.n, 0) AS acoes_count,
        ce.estado       AS estado_cliente
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf_class
        ON cf_class.ticket_id = t.ticket_id
        AND cf_class.custom_field_id = ${CF_CLASSIFICACAO}
        AND cf_class.valor_texto = 'Gestão de Combate ao Churn'
      LEFT JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id
      LEFT JOIN LATERAL (
        SELECT organizacao_id, organizacao_nome
        FROM silver.ticket_cliente
        WHERE ticket_id = t.ticket_id
        -- prioriza o contato externo (profile_type <> '3') sobre o agente
        -- interno da Viasoft que às vezes também aparece em clients[] —
        -- sem isso a organização podia sair errada (ex: "VIASOFT
        -- INFORMATICA LTDA" em vez do cliente de verdade); e-mail @viasoft.com.br
        -- também desempata pro mesmo lado (funcionário nosso cadastrado como
        -- contato "Executivo de Relacionamento" no ticket do cliente real).
        ORDER BY (email ILIKE '%@viasoft.com.br'), (profile_type = '3'), organizacao_nome IS NULL
        LIMIT 1
      ) tc ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS n FROM silver.ticket_acao WHERE ticket_id = t.ticket_id
      ) ac ON true
      -- estado (UF) do cliente — importado de planilha de cadastro (Movidesk
      -- não expõe UF de forma confiável nem no ticket nem no /persons), ver
      -- silver.cliente_estado. NULLIF pra cobrir string vazia do CSV.
      LEFT JOIN silver.cliente_estado ce ON ce.organizacao_id = tc.organizacao_id AND NULLIF(ce.estado, '') IS NOT NULL
      GROUP BY t.ticket_id, tc.organizacao_nome, tc.organizacao_id,
               t.subject, t.service_full, t.createddate, t.status, t.basestatus, t.resolved_in,
               t.owner_name, t.urgency, t.sla_solution_date, ac.n, ce.estado
      ORDER BY t.createddate DESC
    `);
    res.json(result.rows || []);
  } catch (error) {
    // Se as tabelas silver.* ainda não existem (datalake não carregado), retorna vazio
    if (error.message && (error.message.includes('does not exist') || error.message.includes('não existe'))) {
      console.warn('[gcc] silver.* ainda não existe — retornando vazio');
      return res.json([]);
    }
    console.error('Erro ao buscar GCC:', error.message);
    res.status(500).json({ error: 'Erro ao carregar dados de GCC: ' + error.message });
  }
});

// ===== GET /gcc/:ticketId =====
router.get('/:ticketId', authMiddleware, requireTabAccess('gcc'), async (req, res) => {
  const ticketId = String(req.params.ticketId).trim();
  if (!ticketId) return res.status(400).json({ error: 'ticket_id inválido' });

  try {
    const result = await db.query(`
      SELECT
        t.ticket_id::varchar                                                        AS ticket_id,
        tc.organizacao_nome                                                         AS organizacao,
        tc.organizacao_id,
        t.subject                                                                   AS assunto_gcc,
        t.service_full                                                              AS servico_gcc,
        MAX(CASE WHEN cf.custom_field_id = ${CF_TIPO_LOCUS}    THEN cf.valor_texto END) AS classificacao_locus,
        MAX(CASE WHEN cf.custom_field_id = ${CF_REAL_MOTIVO}   THEN cf.valor_texto END) AS motivo_churn,
        MAX(CASE WHEN cf.custom_field_id = ${CF_LOCUS_EXTERNO} THEN cf.valor_texto END) AS cf_24523,
        MAX(CASE WHEN cf.custom_field_id = ${CF_LOCUS_INTERNO} THEN cf.valor_texto END) AS cf_24986,
        MAX(CASE WHEN cf.custom_field_id = ${CF_MRR}           THEN cf.valor_texto END) AS mrr,
        MAX(CASE WHEN cf.custom_field_id = ${CF_DATA_MRR}      THEN cf.valor_texto END) AS data_mrr,
        MAX(CASE WHEN cf.custom_field_id = ${CF_DATA_RESCISAO} THEN cf.valor_texto END) AS data_rescisao,
        MAX(CASE WHEN cf.custom_field_id = ${CF_DATA_REVERSAO} THEN cf.valor_texto END) AS data_reversao,
        t.createddate   AS criado_em,
        t.status        AS status_movidesk,
        t.basestatus    AS base_status,
        t.resolved_in   AS resolvido_em
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf_class
        ON cf_class.ticket_id = t.ticket_id
        AND cf_class.custom_field_id = ${CF_CLASSIFICACAO}
        AND cf_class.valor_texto = 'Gestão de Combate ao Churn'
      LEFT JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id
      LEFT JOIN LATERAL (
        SELECT organizacao_id, organizacao_nome
        FROM silver.ticket_cliente
        WHERE ticket_id = t.ticket_id
        -- prioriza o contato externo (profile_type <> '3') sobre o agente
        -- interno da Viasoft que às vezes também aparece em clients[] —
        -- sem isso a organização podia sair errada (ex: "VIASOFT
        -- INFORMATICA LTDA" em vez do cliente de verdade); e-mail @viasoft.com.br
        -- também desempata pro mesmo lado (funcionário nosso cadastrado como
        -- contato "Executivo de Relacionamento" no ticket do cliente real).
        ORDER BY (email ILIKE '%@viasoft.com.br'), (profile_type = '3'), organizacao_nome IS NULL
        LIMIT 1
      ) tc ON true
      WHERE t.ticket_id = $1
      GROUP BY t.ticket_id, tc.organizacao_nome, tc.organizacao_id,
               t.service_full,
               t.subject, t.createddate, t.status, t.basestatus, t.resolved_in
    `, [ticketId]);
    const row = result.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Registro não encontrado' });
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar registro de GCC:', error);
    res.status(500).json({ error: 'Erro ao carregar registro' });
  }
});

// ===== GET /gcc/:ticketId/actions — ações e campos do datalake =====
// Lê exclusivamente de silver.* (datalake), não chama a API do Movidesk.
const STATIC_CF_NAMES = {
  22000: 'Tipo de Manifesto', 22003: 'Manifesto Procedente', 23946: 'Classificação de Ticket',
  24523: 'GCC - Locus Externo', 24986: 'GCC - Locus Interno', 26214: 'GCC - MRR', 26215: 'GCC - Data',
  38595: 'Manifesto direcionado a', 43724: 'GCC - Data Rescisão', 58049: 'GCC - Data Reversão',
  59012: 'GCC - Real Motivo', 61982: 'GCC - Tipo de Locus',
  87894: 'GCC - Tipo Rescisão', 216954: 'GCC - Tipo de Rescisão Parcial', 216958: 'GCC - Módulos',
  98697: 'GCC - Verticais Insatisfação', 92847: 'GCC - MRR pós churn', 94219: 'GCC - Data do Contrato',
};

router.get('/:ticketId/actions', authMiddleware, requireTabAccess('gcc'), async (req, res) => {
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

    const fieldDefs = Object.fromEntries(
      Object.entries(STATIC_CF_NAMES).map(([id, name]) => [id, name])
    );

    res.json({ actions, customFieldValues, fieldDefs });
  } catch (e) {
    console.error('Erro ao buscar ações de GCC:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ações do chamado' });
  }
});

module.exports = router;
