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
 * POST /geral/sla-liquido — tempo de solução líquido (horas úteis, sem pausas) por ticket
 * POST /geral/temas — tema (por palavras-chave) de cada ticket, a partir do assunto e das ações
 */

const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { requireTabAccess, getToken } = require('./config');
const { calcularMinutosUteisComPausas, parseData } = require('../utils/sla');
const { classificarTexto, listarTemas } = require('../utils/temasChamados');

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
// A janela pega também os chamados RESOLVIDOS dentro dela, mesmo abertos em anos
// anteriores: a contagem de resolvidos não depende do ano de abertura.
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
        whereClause = `WHERE t.createddate >= $1::date OR t.resolved_in >= $1::date`;
      } else {
        whereClause = `WHERE t.createddate >= date_trunc('year', NOW()) OR t.resolved_in >= date_trunc('year', NOW())`;
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
    // 42P01 = undefined_table (silver.* ainda não existe, primeira carga) —
    // ESPECÍFICO pra não mascarar outros erros reais (ex: 42703 coluna
    // errada numa query nova), que precisam aparecer como 500 de verdade.
    if (error.code === '42P01') {
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
// Última ação PÚBLICA (visível ao cliente) separada por quem respondeu —
// usada no Painel TV pra "dias sem retorno" por agente/cliente. Mesma
// convenção de criado_por_profile_type usada em pages/geral.html
// (tlAuthorLabel): 1/3 = agente, 2 = cliente; sem profile_type (ação
// antiga), cai pro domínio do e-mail como aproximação.
const LAST_PUBLIC_ACTION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      MAX(criado_em) FILTER (
        WHERE is_public AND (
          criado_por_profile_type IN ('1','3')
          OR (criado_por_profile_type IS NULL AND criado_por_email ILIKE '%@viasoft.com.br')
        )
      ) AS ultima_publica_agente,
      MAX(criado_em) FILTER (
        WHERE is_public AND (
          criado_por_profile_type = '2'
          OR (criado_por_profile_type IS NULL AND criado_por_email IS NOT NULL AND criado_por_email NOT ILIKE '%@viasoft.com.br')
        )
      ) AS ultima_publica_cliente
    FROM silver.ticket_acao
    WHERE ticket_id = p.ticket_id::bigint
  ) ap ON true
`;

router.get('/pendentes', authMiddleware, requireTabAccess('paineltv'), async (req, res) => {
  try {
    const closedList = OPEN_EXCLUDED_STATUSES.map(s => `'${s}'`).join(',');
    const result = await db.query(`
      SELECT p.*, ap.ultima_publica_agente, ap.ultima_publica_cliente
      FROM (${LIST_SELECT} WHERE t.basestatus NOT IN (${closedList})) p
      ${LAST_PUBLIC_ACTION_JOIN}
      ORDER BY p.criado_em DESC
    `);
    res.json({ rows: result.rows || [] });
  } catch (error) {
    if (error.code === '42P01') {
      console.warn('[geral] silver.* ainda não existe — retornando vazio (pendentes)');
      return res.json({ rows: [] });
    }
    console.error('Erro ao buscar pendentes do painel geral:', error.message);
    res.status(500).json({ error: 'Erro ao carregar pendentes do painel geral: ' + error.message });
  }
});

// ===== GET /geral/chat-diagnostico (admin) =====
// Só leitura. Pergunta ao Movidesk pelos chamados mais recentes pedindo os campos de chat e conta o que veio:
// serve pra descobrir, sem adivinhar, se os atendimentos de chat chegam com origem/grupo/widget/tempos preenchidos.
const MOVI_TICKETS = 'https://apimovidesk.viasoftcloud.com.br/public/v1/tickets';
const CAMPOS_CHAT = ['chatWidget', 'chatGroup', 'chatTalkTime', 'chatWaitingTime'];
router.get('/chat-diagnostico', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const token = await new Promise((ok, ko) => getToken((e, t) => (e ? ko(e) : ok(t))));
    const buscar = async (extra) => {
      const url = `${MOVI_TICKETS}?token=${encodeURIComponent(token)}&$select=${encodeURIComponent(['id', 'origin', 'createdDate', 'baseStatus', ...CAMPOS_CHAT].join(','))}`
        + `&$orderby=${encodeURIComponent('createdDate desc')}&$top=100${extra || ''}`;
      const r = await fetch(url);
      const txt = await r.text();
      let dados = null; try { dados = JSON.parse(txt); } catch { /* texto de erro */ }
      if (!r.ok) {
        // o token nunca volta na resposta
        throw new Error(`Movidesk respondeu ${r.status}: ${(typeof dados === 'object' && dados ? JSON.stringify(dados) : txt).slice(0, 300)}`);
      }
      return Array.isArray(dados) ? dados : [];
    };
    const preenchido = (v) => v !== null && v !== undefined && String(v).trim() !== '';
    let erros = [];
    // 1) amostra geral: quais origens existem e se os campos de chat vêm
    let amostra = [];
    try { amostra = await buscar(''); } catch (e) { erros.push(`Amostra geral: ${e.message}`); }
    // 2) chamados que têm widget de chat preenchido (os de chat de verdade)
    let chats = [];
    try { chats = await buscar(`&$filter=${encodeURIComponent('chatWidget ne null')}`); } catch (e) { erros.push(`Filtro por chat: ${e.message}`); }
    const porOrigem = {};
    amostra.forEach((t) => { const k = String(t.origin ?? 'sem origem'); porOrigem[k] = (porOrigem[k] || 0) + 1; });
    const conta = (lista, campo) => lista.filter((t) => preenchido(t[campo])).length;
    res.json({
      amostra: {
        total: amostra.length, porOrigem,
        comWidget: conta(amostra, 'chatWidget'), comGrupo: conta(amostra, 'chatGroup'),
        comTempoConversa: conta(amostra, 'chatTalkTime'), comTempoEspera: conta(amostra, 'chatWaitingTime'),
      },
      chats: {
        total: chats.length,
        origens: [...new Set(chats.map((t) => String(t.origin ?? 'sem origem')))],
        grupos: [...new Set(chats.map((t) => t.chatGroup).filter(preenchido))].slice(0, 20),
        widgets: [...new Set(chats.map((t) => t.chatWidget).filter(preenchido))].slice(0, 20),
        comGrupo: conta(chats, 'chatGroup'), comTempoConversa: conta(chats, 'chatTalkTime'), comTempoEspera: conta(chats, 'chatWaitingTime'),
        maisRecente: chats[0] ? chats[0].createdDate : null,
        exemplos: chats.slice(0, 5).map((t) => ({ id: t.id, criado: t.createdDate, status: t.baseStatus, grupo: t.chatGroup || null, widget: t.chatWidget || null,
          conversa: t.chatTalkTime ?? null, espera: t.chatWaitingTime ?? null })),
      },
      erros,
    });
  } catch (e) {
    console.error('Erro no diagnóstico de chat:', e.message);
    res.status(500).json({ error: 'Não foi possível consultar o Movidesk: ' + e.message });
  }
});


// ===== POST /geral/sla-liquido =====
// Tempo de SOLUÇÃO líquido de tickets já resolvidos: da abertura (createddate) até
// a resolução (resolved_in), só em horário útil (seg-sex 07:45-12:00 e 13:30-18:00)
// e descontando os trechos em status de pausa (aguardando cliente/terceiro/validação,
// em atendimento - desenvolvimento). Mesmas regras de utils/sla.js (docs/sla-calculo.md);
// a linha do tempo de status vem das ações do ticket (silver.ticket_acao).
// Body: { ids: ["123", ...] } (até 3000). Resposta: { minutos: { "123": 372, ... } }
const SLA_LIQUIDO_MAX_IDS = 3000;
router.post('/sla-liquido', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(i => String(i).trim()).filter(i => /^\d{1,18}$/.test(i)))];
  if (!ids.length) return res.json({ minutos: {} });
  if (ids.length > SLA_LIQUIDO_MAX_IDS) {
    return res.status(400).json({ error: `Máximo de ${SLA_LIQUIDO_MAX_IDS} tickets por chamada` });
  }
  try {
    const [tRes, aRes] = await Promise.all([
      db.query(
        `SELECT ticket_id::varchar AS id, createddate AS criado_em, resolved_in AS resolvido_em
         FROM silver.ticket
         WHERE ticket_id = ANY($1::bigint[]) AND resolved_in IS NOT NULL`,
        [ids]
      ),
      db.query(
        `SELECT ticket_id::varchar AS id, criado_em, status
         FROM silver.ticket_acao
         WHERE ticket_id = ANY($1::bigint[]) AND status IS NOT NULL
         ORDER BY criado_em ASC`,
        [ids]
      ),
    ]);
    const acoesPorTicket = new Map();
    for (const a of aRes.rows) {
      if (!acoesPorTicket.has(a.id)) acoesPorTicket.set(a.id, []);
      acoesPorTicket.get(a.id).push({ createdDate: a.criado_em, status: a.status });
    }
    const minutos = {};
    for (const t of tRes.rows) {
      const ini = parseData(t.criado_em), fim = parseData(t.resolvido_em);
      if (!ini || !fim) continue;
      // Status inicial "Novo" na abertura: sem isso a função assume que o ticket já
      // nasceu no status da primeira ação (e descontaria o início se fosse uma pausa).
      const actions = [{ createdDate: ini, status: 'Novo' }, ...(acoesPorTicket.get(t.id) || [])];
      minutos[t.id] = calcularMinutosUteisComPausas({ actions }, ini, fim);
    }
    res.json({ minutos });
  } catch (error) {
    console.error('Erro ao calcular SLA líquido do painel geral:', error);
    res.status(500).json({ error: 'Erro ao calcular o tempo de solução' });
  }
});


// ===== GET /geral/:ticketId =====
// ===== POST /geral/temas =====
// Tema mais citado de cada ticket: palavras-chave (server/data/temas-chamados.json)
// contadas no assunto + texto das primeiras ações (silver.ticket_acao). Resultado
// guardado em memória por 6h pra não reler o texto a cada abertura do painel.
// Body: { ids: ["123", ...] } (até 2000). Resposta: { catalogo:[{tema,cor}], temas:{ "123": "Fiscal"|null } }
const TEMAS_MAX_IDS = 2000;
const TEMAS_ACOES_LIDAS = 5;      // primeiras ações de cada ticket
const TEMAS_CHARS_POR_ACAO = 1500;
const TEMAS_TTL_MS = 6 * 3600 * 1000;
const _cacheTemas = new Map();    // ticket_id -> { tema, ate }
router.post('/temas', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(i => String(i).trim()).filter(i => /^\d{1,18}$/.test(i)))];
  if (ids.length > TEMAS_MAX_IDS) {
    return res.status(400).json({ error: `Máximo de ${TEMAS_MAX_IDS} tickets por chamada` });
  }
  try {
    const agora = Date.now();
    const temas = {};
    const faltam = [];
    for (const id of ids) {
      const c = _cacheTemas.get(id);
      if (c && c.ate > agora) temas[id] = c.tema; else faltam.push(id);
    }
    if (faltam.length) {
      const r = await db.query(
        `SELECT t.ticket_id::varchar AS id, t.subject AS assunto,
                COALESCE((
                  SELECT string_agg(left(a.descricao, ${TEMAS_CHARS_POR_ACAO}), ' ' ORDER BY a.criado_em)
                  FROM (
                    SELECT descricao, criado_em FROM silver.ticket_acao
                    WHERE ticket_id = t.ticket_id AND descricao IS NOT NULL
                    ORDER BY criado_em ASC LIMIT ${TEMAS_ACOES_LIDAS}
                  ) a
                ), '') AS texto
         FROM silver.ticket t
         WHERE t.ticket_id = ANY($1::bigint[])`,
        [faltam]
      );
      for (const row of r.rows) {
        // o assunto vale em dobro: é o resumo que o cliente/atendente escolheu
        const tema = classificarTexto(`${row.assunto || ''} ${row.assunto || ''} ${row.texto || ''}`);
        temas[row.id] = tema;
        _cacheTemas.set(row.id, { tema, ate: agora + TEMAS_TTL_MS });
      }
    }
    res.json({ catalogo: listarTemas(), temas });
  } catch (error) {
    console.error('Erro ao classificar temas do painel geral:', error);
    res.status(500).json({ error: 'Erro ao analisar os temas dos chamados' });
  }
});


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
