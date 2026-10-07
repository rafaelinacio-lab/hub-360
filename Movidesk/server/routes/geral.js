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
 * GET  /geral/sla-responsaveis — SLA individual (dentro/fora, pendentes, vencidos) por responsável, Suporte Técnico (Painel TV)
 * GET  /geral/causas — causas dos chamados diagnosticados pela Curadoria (que lê o histórico inteiro de cada chamado), compactadas
 */

const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { requireTabAccess, getToken } = require('./config');
const { calcularMinutosUteisComPausas, parseData, FUSO_BRASILIA_MIN } = require('../utils/sla');
const { classificarTexto, listarTemas } = require('../utils/temasChamados');
const cacheResposta = require('../utils/cacheResposta');

// Cache das listas pesadas do painel (compartilhadas por todos os usuários): vale por 2 min ou até a carga gravar tickets.
const CACHE_PAINEL_MS = 2 * 60 * 1000;

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

    await cacheResposta.responder(req, res, `geral:${todos ? 'todos' : (desde || 'ano')}`, CACHE_PAINEL_MS, async () => {
      const result = await db.query(
        `${LIST_SELECT} ${whereClause} ORDER BY t.createddate DESC`,
        params
      );
      return { rows: result.rows || [], janela: todos ? null : (desde || 'ano-vigente') };
    });
  } catch (error) {
    // 42P01 = undefined_table (silver.* ainda não existe, primeira carga) —
    // ESPECÍFICO pra não mascarar outros erros reais (ex: 42703 coluna
    // errada numa query nova), que precisam aparecer como 500 de verdade.
    // Só a ausência da própria silver.ticket (primeira carga) vira "vazio"; falta de qualquer outra tabela é erro de verdade e precisa aparecer.
    if (error.code === '42P01' && /relation "silver\.ticket"/.test(error.message)) {
      console.warn('[geral] silver.ticket ainda não existe — retornando vazio');
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

// ── Acesso do Painel TV por link (sem login): a TV abre painel-tv.html?k=CHAVE. A chave fica na tabela config e só libera
// as duas rotas do painel (lista de pendentes e SLA por analista). Admin vê/renova a chave em /tv-chave.
const crypto = require('crypto');
let _chaveTv = null;
async function lerChaveTv(criar = false) {
  if (_chaveTv && !criar) return _chaveTv;
  if (!criar) {
    const r = await db.query(`SELECT value FROM config WHERE key = 'painel_tv_chave'`).catch(() => ({ rows: [] }));
    if (r.rows[0]?.value) return (_chaveTv = r.rows[0].value);
  }
  _chaveTv = crypto.randomBytes(24).toString('hex');
  await db.query(`INSERT INTO config (key, value) VALUES ('painel_tv_chave', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [_chaveTv]);
  return _chaveTv;
}
const iguais = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Libera com a chave da TV; sem ela, cai no login normal + permissão da aba.
const acessoPainelTv = async (req, res, next) => {
  const k = String(req.query.k || '');
  if (k) {
    try { if (iguais(k, await lerChaveTv())) return next(); } catch (_) { /* cai para o login */ }
    return res.status(401).json({ error: 'Link da TV inválido ou renovado' });
  }
  authMiddleware(req, res, (err) => err ? next(err) : requireTabAccess('paineltv')(req, res, next));
};
router.get('/tv-chave', authMiddleware, requireRole('admin'), async (req, res) => {
  try { res.json({ chave: await lerChaveTv() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/tv-chave', authMiddleware, requireRole('admin'), async (req, res) => {
  try { res.json({ chave: await lerChaveTv(true) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnóstico do Painel Geral (admin): o que existe no banco e quanto a consulta principal leva — para achar por que a tela vem vazia.
router.get('/diagnostico', authMiddleware, requireRole('admin'), async (req, res) => {
  const out = { geradoEm: new Date().toISOString() };
  try {
    const rel = await db.query(`SELECT 'silver.ticket' AS t, to_regclass('silver.ticket') IS NOT NULL AS ok UNION ALL SELECT 'silver.ticket_campo_customizado', to_regclass('silver.ticket_campo_customizado') IS NOT NULL
      UNION ALL SELECT 'silver.ticket_organizacao', to_regclass('silver.ticket_organizacao') IS NOT NULL UNION ALL SELECT 'silver.ticket_acao', to_regclass('silver.ticket_acao') IS NOT NULL`);
    out.tabelas = Object.fromEntries(rel.rows.map((r) => [r.t, r.ok]));
    const closed = OPEN_EXCLUDED_STATUSES.map((x) => `'${x}'`).join(',');
    const c = (await db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE createddate IS NULL)::int AS sem_criacao,
        COUNT(*) FILTER (WHERE createddate >= date_trunc('year', NOW()))::int AS criados_no_ano, COUNT(*) FILTER (WHERE resolved_in >= date_trunc('year', NOW()))::int AS resolvidos_no_ano,
        COUNT(*) FILTER (WHERE basestatus NOT IN (${closed}))::int AS abertos, MAX(createddate) AS ultimo_criado, MAX(last_update) AS ultima_alteracao FROM silver.ticket`)).rows[0];
    Object.assign(out, c);
    const t0 = Date.now();
    const q = await db.query(`SELECT COUNT(*)::int AS n FROM (${LIST_SELECT} WHERE t.createddate >= date_trunc('year', NOW()) OR t.resolved_in >= date_trunc('year', NOW())) x`);
    out.consultaPrincipal = { linhas: q.rows[0].n, ms: Date.now() - t0 };
  } catch (e) { out.erro = e.message; out.codigo = e.code; }
  res.json(out);
});

// Saldo de horas técnicas (crédito da Política de SLA) por organização, para o Painel Geral mostrar ao lado do cliente.
router.get('/horas-tecnicas', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  try {
    const saldos = await require('../utils/slaHorasCore').saldosPorCliente();
    const out = {};
    for (const [id, s] of Object.entries(saldos)) if (s.disponivel > 0 || s.concedido > 0) out[id] = { h: s.disponivel, c: s.concedido, u: s.usado, e: s.expirado, v: s.aVencer ? s.aVencer.validade : null, vh: s.aVencer ? s.aVencer.horas : 0, l: s.creditos || [] };
    res.json({ saldos: out });
  } catch (e) {
    if (e.code === '42P01') return res.json({ saldos: {} });
    console.error('[geral] horas-tecnicas:', e.message);
    res.json({ saldos: {} });   // o saldo é um complemento: nunca derruba o painel
  }
});

router.get('/pendentes', acessoPainelTv, async (req, res) => {
  try {
    const closedList = OPEN_EXCLUDED_STATUSES.map(s => `'${s}'`).join(',');
    await cacheResposta.responder(req, res, 'pendentes', CACHE_PAINEL_MS, async () => {
      const result = await db.query(`
        SELECT p.*, ap.ultima_publica_agente, ap.ultima_publica_cliente
        FROM (${LIST_SELECT} WHERE t.basestatus NOT IN (${closedList})) p
        ${LAST_PUBLIC_ACTION_JOIN}
        ORDER BY p.criado_em DESC
      `);
      const rows = result.rows || [];
      // Chamados recém-carregados ainda não entraram em silver.ticket_organizacao (ela é refeita a cada 30 min):
      // para os pendentes sem organização, usa direto o cliente do chamado (mesma heurística da materialização).
      const semOrg = rows.filter(r => !r.organizacao).map(r => r.ticket_id).filter(id => /^\d{1,18}$/.test(String(id)));
      if (semOrg.length) {
        try {
          const fb = await db.query(`
            SELECT DISTINCT ON (ticket_id) ticket_id::text AS id, organizacao_id, organizacao_nome
              FROM silver.ticket_cliente
             WHERE ticket_id = ANY($1::bigint[]) AND NULLIF(btrim(organizacao_nome), '') IS NOT NULL
             ORDER BY ticket_id, COALESCE(email ILIKE '%@viasoft.com.br', false), COALESCE(profile_type = '3', false)`, [semOrg]);
          const porId = new Map((fb.rows || []).map(x => [x.id, x]));
          rows.forEach(r => { if (!r.organizacao) { const o = porId.get(String(r.ticket_id)); if (o) { r.organizacao = o.organizacao_nome; r.organizacao_id = o.organizacao_id; } } });
        } catch (e) { console.warn('[geral] fallback de organização dos pendentes falhou:', e.message); }
      }
      // Ainda sem organização: o chamado veio sem organização no Movidesk (comum nos recém-abertos da carga rápida).
      // 1) descobre a organização pelo CONTATO: a mais recente que esse mesmo contato (cliente_id) teve em outros chamados;
      // 2) sem isso, mostra o nome do contato externo (ou do agente interno, se só houver ele).
      const semNome = rows.filter(r => !r.organizacao).map(r => r.ticket_id).filter(id => /^\d{1,18}$/.test(String(id)));
      if (semNome.length) {
        try {
          const fc = await db.query(`
            SELECT DISTINCT ON (ticket_id) ticket_id::text AS id, cliente_id, nome
              FROM silver.ticket_cliente
             WHERE ticket_id = ANY($1::bigint[])
             ORDER BY ticket_id, COALESCE(email ILIKE '%@viasoft.com.br', false), COALESCE(profile_type = '3', false), (NULLIF(btrim(nome), '') IS NULL)`, [semNome]);
          const porId = new Map((fc.rows || []).map(x => [x.id, x]));
          const contatos = [...new Set((fc.rows || []).map(x => x.cliente_id).filter(c => c && !/^sem[-_]?id/i.test(String(c))))];
          let orgDoContato = new Map();
          if (contatos.length) {
            const oc = await db.query(`
              SELECT DISTINCT ON (cliente_id) cliente_id, organizacao_id, organizacao_nome
                FROM silver.ticket_cliente
               WHERE cliente_id = ANY($1::text[]) AND NULLIF(btrim(organizacao_nome), '') IS NOT NULL
               ORDER BY cliente_id, extracted_at DESC NULLS LAST`, [contatos]);
            orgDoContato = new Map((oc.rows || []).map(x => [String(x.cliente_id), x]));
          }
          rows.forEach(r => {
            if (r.organizacao) return;
            const c = porId.get(String(r.ticket_id)); if (!c) return;
            const o = orgDoContato.get(String(c.cliente_id));
            if (o) { r.organizacao = o.organizacao_nome; r.organizacao_id = o.organizacao_id; r.organizacao_inferida = true; }
            else if (c.nome && String(c.nome).trim()) r.cliente_nome = c.nome;
          });
        } catch (e) { console.warn('[geral] fallback de cliente dos pendentes falhou:', e.message); }
      }
      // Movimento do dia (fuso de Brasília): chamados abertos hoje e resolvidos/fechados hoje, com os campos dos filtros.
      let hoje = [];
      try {
        const h = await db.query(`
          SELECT t.ticket_id::varchar AS ticket_id, t.service_full AS servico, t.ownerteam AS equipe, t.owner_name AS responsavel,
                 t.urgency AS urgencia, cf.valor_texto AS classificacao, t.createddate AS criado_em,
                 COALESCE(t.resolved_in, t.closed_in) AS fechado_em, t.subject AS assunto, t.status AS status_movidesk, t.basestatus AS base_status,
                 tc.organizacao_nome AS organizacao
            FROM silver.ticket t
            LEFT JOIN silver.ticket_organizacao tc ON tc.ticket_id = t.ticket_id
            LEFT JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
           WHERE (t.createddate >= now() - interval '2 days' OR t.resolved_in >= now() - interval '2 days' OR t.closed_in >= now() - interval '2 days')
             AND ((t.createddate AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
               OR (COALESCE(t.resolved_in, t.closed_in) AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date)`);
        hoje = h.rows || [];
      } catch (e) { console.warn('[geral] movimento do dia falhou:', e.message); }
      return { rows, hoje };
    });
  } catch (error) {
    if (error.code === '42P01' && /relation "silver\.ticket"/.test(error.message)) {
      console.warn('[geral] silver.ticket ainda não existe — retornando vazio (pendentes)');
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
    try { chats = await buscar(`&$filter=${encodeURIComponent('chatGroup ne null')}`); } catch (e) { erros.push(`Filtro por grupo de chat: ${e.message}`); }
    // 3) sonda por número de chamado (?tickets=908248,908372): mostra exatamente o que a API devolve pra cada um
    const ids = [...new Set(String(req.query.tickets || '').split(/[\s,;]+/).filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 8);
    // Busca por LISTA com $filter (a busca por ?id= devolveu 404 para chamados de chat recentes, a por lista funciona).
    const porId = async (id, extra) => {
      const url = `${MOVI_TICKETS}?token=${encodeURIComponent(token)}&$filter=${encodeURIComponent(`id eq ${id}`)}&$top=1${extra || ''}`;
      const r = await fetch(url);
      const txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch { /* erro em texto */ }
      if (!r.ok) throw new Error(`Movidesk respondeu ${r.status}: ${(typeof d === 'object' && d ? JSON.stringify(d) : txt).slice(0, 200)}`);
      return Array.isArray(d) ? d[0] : d;
    };
    const sonda = [];
    for (const id of ids) {
      try {
        const t0 = await porId(id, `&$select=${encodeURIComponent(['id', 'origin', 'createdDate', 'lastUpdate', 'status', 'baseStatus', 'ownerTeam', 'serviceFull', ...CAMPOS_CHAT].join(','))}&$expand=${encodeURIComponent('owner,clients')}`);
        if (!t0) { sonda.push({ id, erro: 'não encontrado' }); continue; }
        const cl = Array.isArray(t0.clients) ? t0.clients[0] : null;
        sonda.push({ id, origin: t0.origin ?? null, status: t0.status || null, baseStatus: t0.baseStatus || null, grupo: t0.chatGroup || null, widget: t0.chatWidget || null,
          espera: t0.chatWaitingTime ?? null, conversa: t0.chatTalkTime ?? null, atendente: (t0.owner && t0.owner.businessName) || null, equipe: t0.ownerTeam || null,
          servico: Array.isArray(t0.serviceFull) ? t0.serviceFull.join(' > ') : (t0.serviceFull || null), cliente: (cl && cl.businessName) || null,
          criado: t0.createdDate || null, atualizado: t0.lastUpdate || null });
      } catch (e) { sonda.push({ id, erro: e.message }); }
    }
    // o que o Hub tem guardado (public.hub_chat) para esses chamados: se não estiver lá, a coleta não o pegou
    if (sonda.length) {
      try {
        const noHub = (await db.query(
          `SELECT ticket_id::text AS id, base_status, status, grupo, tempo_conversa, tempo_espera, atualizado_em, coletado_em FROM public.hub_chat WHERE ticket_id = ANY($1::bigint[])`,
          [sonda.map((x) => x.id)])).rows;
        sonda.forEach((x) => { x.noHub = noHub.find((r) => r.id === String(x.id)) || null; });
      } catch (e) { sonda.forEach((x) => { x.noHub = undefined; }); }
    }
    // 4) procura um valor conhecido (ex.: o chatId do link /Ticket/ChatVisualize/908248?chatId=77563584) dentro do chamado COMPLETO,
    //    pra descobrir em qual campo da API ele vem
    let procura = null;
    const valorProcurado = String(req.query.procurar || '').trim();
    if (ids.length && /^[\w-]{4,40}$/.test(valorProcurado)) {
      try {
        const amplo = ['id', 'protocol', 'type', 'subject', 'category', 'urgency', 'status', 'baseStatus', 'origin', 'createdDate', 'lastUpdate', 'lastActionDate', 'ownerTeam',
          'serviceFull', 'contactForm', 'tags', 'actionCount', ...CAMPOS_CHAT];
        let t0;
        try { t0 = await porId(ids[0], `&$select=${encodeURIComponent(amplo.join(','))}&$expand=${encodeURIComponent('owner,clients,actions')}`); }
        catch (e1) { t0 = await porId(ids[0], `&$select=${encodeURIComponent(['id', 'origin', 'createdDate', ...CAMPOS_CHAT].join(','))}&$expand=${encodeURIComponent('actions')}`); }
        const r = { ok: true };
        if (r.ok && t0) {
          const caminhos = [];
          const andar = (v, caminho) => {
            if (caminhos.length >= 10) return;
            if (v !== null && typeof v === 'object') {
              for (const [k, x] of Object.entries(v)) andar(x, caminho ? `${caminho}.${k}` : k);
            } else if (String(v).includes(valorProcurado)) {
              caminhos.push(`${caminho} = ${String(v).slice(0, 120)}`);
            }
          };
          andar(t0, '');
          const camposChat = {};
          Object.keys(t0).filter((k) => /chat|talk|waiting|conversa/i.test(k)).forEach((k) => { camposChat[k] = t0[k]; });
          procura = { id: ids[0], valor: valorProcurado, encontrado: caminhos, camposChat, todosOsCampos: Object.keys(t0) };
        } else procura = { id: ids[0], valor: valorProcurado, erro: 'chamado não encontrado' };
      } catch (e) { procura = { id: ids[0], valor: valorProcurado, erro: e.message }; }
    }
    const porOrigem = {};
    amostra.forEach((t) => { const k = String(t.origin ?? 'sem origem'); porOrigem[k] = (porOrigem[k] || 0) + 1; });
    const conta = (lista, campo) => lista.filter((t) => preenchido(t[campo])).length;
    res.json({
      sonda, procura,
      amostra: {
        total: amostra.length, porOrigem,
        porOrigemDetalhe: Object.fromEntries(Object.keys(porOrigem).map((k) => {
          const l = amostra.filter((x) => String(x.origin ?? 'sem origem') === k);
          return [k, { total: l.length, comGrupo: conta(l, 'chatGroup'), comWidget: conta(l, 'chatWidget') }];
        })),
        comWidget: conta(amostra, 'chatWidget'), comGrupo: conta(amostra, 'chatGroup'),
        comTempoConversa: conta(amostra, 'chatTalkTime'), comTempoEspera: conta(amostra, 'chatWaitingTime'),
      },
      chats: {
        total: chats.length,
        origens: [...new Set(chats.map((t) => String(t.origin ?? 'sem origem')))],
        grupos: [...new Set(chats.map((t) => t.chatGroup).filter(preenchido))].slice(0, 20),
        widgets: [...new Set(chats.map((t) => t.chatWidget).filter(preenchido))].slice(0, 20),
        comWidget: conta(chats, 'chatWidget'), comGrupo: conta(chats, 'chatGroup'), comTempoConversa: conta(chats, 'chatTalkTime'), comTempoEspera: conta(chats, 'chatWaitingTime'),
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
      minutos[t.id] = calcularMinutosUteisComPausas({ actions }, ini, fim, FUSO_BRASILIA_MIN);
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


// ── Top causas dos chamados ──────────────────────────────────────────────
// A Curadoria (IA) lê o histórico inteiro de cada chamado (todas as ações) e grava a causa em
// public.curadoria_chamados (banco movidesk_curadoria). Em vez de o navegador mandar dezenas de milhares de números
// de chamado, o servidor devolve a base inteira da Curadoria já compactada (causas únicas + [chamado, causa]) e o
// painel cruza com os chamados que está mostrando. Fica em memória por alguns minutos.
// Resposta: { causas:[texto,…], itens:[[ticket_id, índice_da_causa],…] }
const CAUSAS_TTL_MS = 10 * 60 * 1000;
let _causasBase = null;   // { ate, dados }
const _chaveCausa = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.;:\s]+$/, '');
router.get('/causas', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  try {
    if (_causasBase && _causasBase.ate > Date.now()) return res.json(_causasBase.dados);
    // Confere quais colunas existem neste banco (a Curadoria cria colunas aos poucos), em vez de assumir.
    const cols = new Set(((await db.queryDatabase('movidesk_curadoria',
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'curadoria_chamados'`)).rows || []).map((x) => x.column_name));
    const partes = ['causa_normalizada', 'causa'].filter((c) => cols.has(c)).map((c) => `NULLIF(btrim(${c}::text), '')`);
    if (!cols.has('ticket_id') || !partes.length) {
      return res.json({ causas: [], itens: [], aviso: 'A Curadoria ainda não tem diagnósticos de causa neste banco.' });
    }
    const r = await db.queryDatabase('movidesk_curadoria',
      `SELECT ticket_id::text AS id, COALESCE(${partes.join(', ')}) AS causa
         FROM public.curadoria_chamados
        WHERE ${cols.has('processado') ? "processado::text IN ('1', 'true', 't') AND " : ''}COALESCE(${partes.join(', ')}) IS NOT NULL`);
    const indice = new Map();            // chave normalizada -> posição em `causas`
    const variantes = [];                // por posição: Map(texto -> n)
    const itens = [];
    for (const row of r.rows || []) {
      const texto = String(row.causa).replace(/\s+/g, ' ').slice(0, 300);
      const chave = _chaveCausa(texto);
      let i = indice.get(chave);
      if (i === undefined) { i = variantes.length; indice.set(chave, i); variantes.push(new Map()); }
      variantes[i].set(texto, (variantes[i].get(texto) || 0) + 1);
      itens.push([row.id, i]);
    }
    const causas = variantes.map((m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    const dados = { causas, itens };
    _causasBase = { ate: Date.now() + CAUSAS_TTL_MS, dados };
    res.json(dados);
  } catch (error) {
    console.error('Erro ao ler as causas da Curadoria:', error.message);
    const m = String(error.message || '');
    const motivo = /does not exist|não existe/i.test(m) ? 'a tabela da Curadoria não existe neste banco'
      : /ECONN|ETIMEDOUT|EAI_AGAIN|timeout|terminat|password|authentication/i.test(m) ? 'o banco da Curadoria não está acessível'
      : 'erro ao consultar a Curadoria';
    res.status(502).json({ error: `Não foi possível analisar as causas: ${motivo}.` });
  }
});

// ── SLA por responsável (Painel TV) ───────────────────────────────────────
// Para cada responsável: resolvidos no período dentro/fora do prazo (resolvido_em <= sla_solucao, a mesma regra do Painel Geral),
// pendentes agora (total, vencidos, no prazo, sem prazo). O impacto no SLA do time é calculado no painel a partir destes números.
// A política de SLA vale só para Suporte Técnico (campo 23946), então é a classificação usada aqui; ?servico= restringe a um serviço.
// ?desde=YYYY-MM-DD (padrão: 1º dia do mês atual) define o início do período dos resolvidos.
const FECHADOS_SQL = "'Resolved','Closed','Resolvido','Fechado'";
const CLASSIFICACAO_SLA = 'suporte tecnico';
router.get('/sla-responsaveis', acessoPainelTv, async (req, res) => {
  try {
    const hoje = new Date();
    const padrao = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.desde || '')) ? String(req.query.desde) : padrao;
    const servico = String(req.query.servico || '').trim().slice(0, 300);
    const equipe = String(req.query.equipe || '').trim().slice(0, 300);
    const chave = `sla-resp:${desde}:${servico}:${equipe}`;
    await cacheResposta.responder(req, res, chave, CACHE_PAINEL_MS, async () => {
      const params = [desde];
      let filtroServico = '';
      if (servico) { params.push(servico); filtroServico = ` AND t.service_full = $${params.length}`; }
      if (equipe) { params.push(equipe === 'Não informado' ? '' : equipe); filtroServico += ` AND COALESCE(NULLIF(btrim(t.ownerteam), ''), '') = $${params.length}`; }
      const r = await db.query(`
        WITH b AS (
          SELECT COALESCE(NULLIF(btrim(t.owner_name), ''), 'Não atribuído') AS responsavel,
                 (t.basestatus IN (${FECHADOS_SQL})) AS resolvido,
                 (t.basestatus NOT IN (${FECHADOS_SQL}, 'Canceled', 'Cancelado')) AS pendente,
                 t.basestatus AS base, t.resolved_in, t.sla_solution_date AS prazo
            FROM silver.ticket t
            JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
           WHERE translate(lower(cf.valor_texto), 'éèêáàâãíóôõúç', 'eeeaaaaiooouc') = '${CLASSIFICACAO_SLA}'${filtroServico}
             AND (t.basestatus NOT IN (${FECHADOS_SQL}, 'Canceled', 'Cancelado') OR (t.basestatus IN (${FECHADOS_SQL}) AND t.resolved_in >= $1::date))
        )
        SELECT responsavel,
               COUNT(*) FILTER (WHERE resolvido AND prazo IS NOT NULL AND resolved_in <= prazo)::int AS dentro,
               COUNT(*) FILTER (WHERE resolvido AND prazo IS NOT NULL AND resolved_in >  prazo)::int AS fora,
               COUNT(*) FILTER (WHERE resolvido AND prazo IS NULL)::int AS resolvidos_sem_prazo,
               COUNT(*) FILTER (WHERE pendente)::int AS pendentes,
               COUNT(*) FILTER (WHERE pendente AND prazo IS NOT NULL AND prazo <  NOW())::int AS vencidos,
               COUNT(*) FILTER (WHERE pendente AND prazo IS NOT NULL AND prazo >= NOW())::int AS no_prazo,
               COUNT(*) FILTER (WHERE pendente AND prazo IS NULL AND base = 'Stopped')::int AS pausados,
               COUNT(*) FILTER (WHERE pendente AND prazo IS NULL AND base IS DISTINCT FROM 'Stopped')::int AS sem_prazo
          FROM b GROUP BY 1 ORDER BY 1`, params);
      return { desde, servico: servico || null, equipe: equipe || null, classificacao: 'Suporte Técnico', rows: r.rows || [] };
    });
  } catch (error) {
    if (error.code === '42P01') return res.json({ rows: [] });
    console.error('Erro ao calcular o SLA por responsável:', error.message);
    res.status(500).json({ error: 'Erro ao calcular o SLA por responsável' });
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
