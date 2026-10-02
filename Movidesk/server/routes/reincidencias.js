'use strict';
// Reincidências: IA que lê o histórico COMPLETO dos chamados e acha problemas que se repetem
//  - dimensão 0: o mesmo sintoma voltando dentro do próprio chamado;
//  - dimensão A: o mesmo cliente com o mesmo problema em chamados diferentes;
//  - dimensão B: o mesmo problema em vários clientes (indício de bug sistêmico).
// A IA propõe os grupos; o servidor confere tudo contra o banco (ids que existem, cliente real de cada chamado,
// mínimo de clientes para "sistêmico") antes de mostrar, para a IA não inventar chamado nem cliente.
const express = require('express');
const db = require('../db/remote');
const { requireTabAccess } = require('./config');
const { authMiddleware } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const cfg = require('../utils/aiSettings');
const { chamarIA, configurada: iaConfigurada, IaError, REGRAS, dados, conversaEmTexto, limitar, semHtml } = require('../utils/ai');

const router = express.Router();
router.use(authMiddleware);
const requireLeitura = requireTabAccess('reincidencias');
const ROLES = ['admin', 'supervisor', 'atendente'];
const limite = rateLimit({ name: 'reincidencias/analisar', windowMs: 10 * 60 * 1000, max: 5 });

let prontas = null;
router.use(async (req, res, next) => {
  try {
    if (!prontas) prontas = db.query(`CREATE TABLE IF NOT EXISTS public.reincidencia_analise (
      id SERIAL PRIMARY KEY, criado_por INTEGER, criado_por_nome TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      parametros JSONB NOT NULL DEFAULT '{}', n_tickets INTEGER NOT NULL DEFAULT 0, resultado JSONB NOT NULL DEFAULT '{}')`).then(() => db.query(TABELA_PAR)).catch((e) => { prontas = null; throw e; });
    await prontas; next();
  } catch (e) { res.status(500).json({ error: 'Erro ao preparar a tabela de reincidências: ' + e.message }); }
});

const TABELA_PAR = `CREATE TABLE IF NOT EXISTS public.reincidencia_par (
  ticket_id BIGINT PRIMARY KEY, anterior_id BIGINT, reincidente BOOLEAN NOT NULL DEFAULT FALSE, confianca TEXT, explicacao TEXT,
  anterior_fim TIMESTAMPTZ, dias_entre NUMERIC, mesmo_modulo BOOLEAN, analisado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
const erro = (res, e) => (e instanceof IaError ? res.status(e.status).json({ error: e.message }) : (console.error('[reincidencias]', e), res.status(500).json({ error: e.message || 'Erro inesperado' })));
const num = (v, min, max, pad) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : pad; };
const CONF = ['Alta', 'Média', 'Baixa'];
const conf = (v) => { const x = String(v || '').toLowerCase().replace('media', 'média'); return CONF.find((c) => c.toLowerCase() === x) || 'Baixa'; };
const dia = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

router.get('/config', requireLeitura, async (req, res) => {
  try {
    const S = await cfg.obter();
    const papel = (await db.query(`SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user.id])).rows[0]?.name;
    const sv = await db.query(`SELECT split_part(service_full, ' > ', 1) AS s, COUNT(*)::int AS n FROM silver.ticket WHERE createddate >= NOW() - INTERVAL '120 days' AND service_full IS NOT NULL AND service_full <> '' GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY 1`);
    res.json({ ativo: S.reincidencia.ativo, diasPadrao: S.reincidencia.diasPadrao, maxTickets: S.reincidencia.maxTickets, minClientes: S.reincidencia.minClientesSistemico,
      iaConfigurada: await iaConfigurada().catch(() => false), podeAnalisar: ROLES.includes(papel), servicos: sv.rows.map((x) => x.s) });
  } catch (e) { erro(res, e); }
});

router.get('/', requireLeitura, async (req, res) => {
  try {
    const r = await db.query(`SELECT id, criado_por_nome, criado_em, parametros, n_tickets,
        COALESCE(jsonb_array_length(resultado->'dimensao0'),0) AS d0, COALESCE(jsonb_array_length(resultado->'dimensaoA'),0) AS da, COALESCE(jsonb_array_length(resultado->'dimensaoB'),0) AS db
      FROM public.reincidencia_analise ORDER BY id DESC LIMIT 30`);
    res.json({ analises: r.rows });
  } catch (e) { erro(res, e); }
});
router.get('/:id(\\d+)', requireLeitura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Número inválido' });
  try {
    const r = (await db.query(`SELECT * FROM public.reincidencia_analise WHERE id = $1`, [id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Análise não encontrada' });
    res.json({ analise: r });
  } catch (e) { erro(res, e); }
});

const { FORMATO_TECNICO, FORMATO_PARES, montarPrompt } = require('../utils/reincidenciaPrompt');

// Roda uma análise completa (usada pelo botão e pela rotina automática). `usuario` = null quando é automática.
let analisando = false;
async function executar(entrada, usuario) {
  if (analisando) throw new IaError(409, 'Já existe uma análise em andamento. Aguarde terminar.');
  analisando = true;
  try {
    const S = await cfg.obter(), C = S.reincidencia;
    if (!C.ativo) throw new IaError(403, 'Este recurso de IA foi desativado nas Configurações.');
    const dias = [7, 15, 30, 60, 90].includes(Number(entrada.dias)) ? Number(entrada.dias) : C.diasPadrao;
    const servico = String(entrada.servico || '').trim().slice(0, 120);
    const params = [dias, C.maxTickets]; let filtro = '';
    if (servico) { params.push(servico.toLowerCase()); filtro = `AND lower(split_part(t.service_full, ' > ', 1)) = $${params.length}`; }
    const tks = (await db.query(`
      SELECT t.ticket_id::bigint AS id, t.subject, t.status, t.createddate, t.ownerteam, split_part(t.service_full, ' > ', 1) AS servico,
             COALESCE(NULLIF(o.organizacao_nome,''), t.clientorganization, 'Cliente não identificado') AS cliente
        FROM silver.ticket t LEFT JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id::bigint
       WHERE t.createddate >= NOW() - make_interval(days => $1::int) ${filtro}
       ORDER BY t.createddate DESC LIMIT $2`, params)).rows;
    if (tks.length < 3) throw new IaError(400,  `Só há ${tks.length} chamado(s) nesse período${servico ? ' e serviço' : ''}: amplie o período para comparar.`);
    const ids = tks.map((t) => Number(t.id));
    const acoes = (await db.query(`SELECT ticket_id::bigint AS tid, descricao, is_public, criado_em, criado_por_nome, criado_por_profile_type
        FROM silver.ticket_acao WHERE ticket_id::bigint = ANY($1::bigint[]) ORDER BY ticket_id, criado_em`, [ids])).rows;
    const porTicket = new Map();
    for (const a of acoes) { if (!porTicket.has(Number(a.tid))) porTicket.set(Number(a.tid), []); porTicket.get(Number(a.tid)).push(a); }
    const orcamento = Math.max(1200, Math.min(3500, Math.floor(110000 / tks.length)));
    const bloco = tks.map((t) => {
      const hist = conversaEmTexto((porTicket.get(Number(t.id)) || []).map((a) => ({
        criadoEm: a.criado_em, autor: a.criado_por_nome, tipo: a.is_public === false ? 'interna' : 'publica',
        autorPerfil: a.criado_por_profile_type == null ? null : Number(a.criado_por_profile_type), texto: a.descricao })), orcamento);
      return `### CHAMADO ${t.id}\nCliente: ${limitar(t.cliente, 120)} · Time: ${t.ownerteam || '—'} · Serviço: ${t.servico || '—'} · Criado em: ${dia(t.createddate)} · Status: ${t.status || '—'}\nAssunto: ${limitar(t.subject, 200)}\nHistórico:\n${hist}`;
    }).join('\n\n');
    const system = `${REGRAS}${cfg.diretrizes(S)}\n${montarPrompt(C.promptBase, C.minClientesSistemico)}\n${FORMATO_TECNICO}${cfg.extra(C.instrucaoExtra)}`;
    const r = await chamarIA({ source: 'reincidencias', system, user: dados('CHAMADOS', bloco), maxTokens: 5000, temperature: cfg.temperatura(C.criatividade), timeoutMs: 170000, userEmail: usuario ? usuario.email : 'automatico@hub', meta: { tickets: tks.length, dias, servico } });

    // ── confere a resposta da IA contra o banco ──
    const info = new Map(tks.map((t) => [Number(t.id), t]));
    const ok = (v) => Number(v);
    const idsValidos = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(ok).filter((n) => info.has(n)))];
    const itemTicket = (id) => { const t = info.get(id); return { id, assunto: limitar(t.subject, 140), cliente: t.cliente, data: dia(t.createddate), status: t.status }; };
    const d0 = (Array.isArray(r.dimensao0) ? r.dimensao0 : []).map((x) => {
      const id = ok(x && x.ticket_id); if (!info.has(id)) return null;
      const oc = (Array.isArray(x.ocorrencias) ? x.ocorrencias : []).slice(0, 8).map((o) => ({ quando: limitar(o && o.quando, 40), resumo: limitar(o && o.resumo, 260) }));
      if (oc.length < 2) return null;
      return { ...itemTicket(id), ocorrencias: oc, correcao: limitar(x.correcao_aplicada, 300), confianca: conf(x.confianca) };
    }).filter(Boolean).sort((a, b) => b.ocorrencias.length - a.ocorrencias.length);
    const dA = (Array.isArray(r.dimensaoA) ? r.dimensaoA : []).map((x) => {
      let lista = idsValidos(x && x.ticket_ids);
      const porCli = new Map(); lista.forEach((i) => { const c = info.get(i).cliente; porCli.set(c, (porCli.get(c) || []).concat(i)); });
      const [cliente, tk] = [...porCli.entries()].sort((a, b) => b[1].length - a[1].length)[0] || [];
      if (!tk || tk.length < 2) return null;                      // precisa ser o MESMO cliente, 2+ chamados
      const itens = tk.map(itemTicket).sort((a, b) => String(a.data).localeCompare(String(b.data)));
      return { cliente, problema: limitar(x.problema, 300), tickets: itens, periodo: [itens[0].data, itens[itens.length - 1].data], confianca: conf(x.confianca), justificativa: limitar(x.justificativa, 300) };
    }).filter(Boolean).sort((a, b) => b.tickets.length - a.tickets.length);
    const dB = (Array.isArray(r.dimensaoB) ? r.dimensaoB : []).map((x) => {
      const lista = idsValidos(x && x.ticket_ids);
      const clientes = new Map(); lista.forEach((i) => { const c = info.get(i).cliente; if (!clientes.has(c)) clientes.set(c, i); });
      if (clientes.size < C.minClientesSistemico) return null;     // regra: só é sistêmico com N clientes distintos
      return { problema: limitar(x.problema, 400), nClientes: clientes.size, clientes: [...clientes.entries()].map(([cliente, id]) => ({ cliente, ticketId: id })), tickets: lista.map(itemTicket),
        modulo: limitar(x.modulo, 80), confianca: conf(x.confianca), recomendacao: limitar(x.recomendacao, 300) };
    }).filter(Boolean).sort((a, b) => b.nClientes - a.nClientes);
    const resultado = { dimensao0: d0, dimensaoA: dA, dimensaoB: dB, resumo: limitar(r.resumo, 900) };
    const parametros = { origem: usuario ? 'manual' : 'automatica', dias, servico: servico || null, maxTickets: C.maxTickets, minClientes: C.minClientesSistemico, truncado: tks.length >= C.maxTickets };
    const ins = await db.query(`INSERT INTO public.reincidencia_analise (criado_por, criado_por_nome, parametros, n_tickets, resultado) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb) RETURNING id, criado_em`,
      [usuario ? usuario.id : null, usuario ? usuario.nome : 'Análise automática', JSON.stringify(parametros), tks.length, JSON.stringify(resultado)]);
    return { id: ins.rows[0].id, criado_em: ins.rows[0].criado_em, criado_por_nome: usuario ? usuario.nome : 'Análise automática', parametros, n_tickets: tks.length, resultado };
  } finally { analisando = false; }
}

router.post('/analisar', requireLeitura, limite, async (req, res) => {
  try {
    const papel = (await db.query(`SELECT r.name, u.name AS nome FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user.id])).rows[0];
    if (!papel || !ROLES.includes(papel.name)) return res.status(403).json({ error: 'Seu perfil pode ver o painel, mas não gerar novas análises.' });
    res.json({ analise: await executar(req.body || {}, { id: req.user.id, nome: papel.nome || req.user.email, email: req.user.email }) });
  } catch (e) { erro(res, e); }
});

// ── painel: última análise + anterior + série histórica ──
const taxaDe = (r, n) => {
  const ids = new Set();
  (r.dimensao0 || []).forEach((x) => ids.add(x.id));
  (r.dimensaoA || []).forEach((x) => x.tickets.forEach((t) => ids.add(t.id)));
  (r.dimensaoB || []).forEach((x) => x.tickets.forEach((t) => ids.add(t.id)));
  return { envolvidos: ids.size, taxa: n ? Math.round((ids.size / n) * 1000) / 10 : 0 };
};
router.get('/painel', requireLeitura, async (req, res) => {
  try {
    const rows = (await db.query(`SELECT id, criado_por_nome, criado_em, parametros, n_tickets, resultado FROM public.reincidencia_analise ORDER BY id DESC LIMIT 40`)).rows;
    const serie = rows.map((x) => ({ id: x.id, criado_em: x.criado_em, dias: x.parametros.dias, servico: x.parametros.servico || null, n: x.n_tickets,
      d0: (x.resultado.dimensao0 || []).length, da: (x.resultado.dimensaoA || []).length, db: (x.resultado.dimensaoB || []).length, ...taxaDe(x.resultado, x.n_tickets) })).reverse();
    const atual = rows[0] || null;
    // anterior comparável: mesmo período e serviço
    const anterior = atual ? (rows.slice(1).find((x) => x.parametros.dias === atual.parametros.dias && (x.parametros.servico || null) === (atual.parametros.servico || null)) || null) : null;
    const S = await cfg.obter();
    res.json({ atual, anterior: anterior ? { id: anterior.id, criado_em: anterior.criado_em, d0: (anterior.resultado.dimensao0 || []).length, da: (anterior.resultado.dimensaoA || []).length,
      db: (anterior.resultado.dimensaoB || []).length, ...taxaDe(anterior.resultado, anterior.n_tickets) } : null,
      atualTaxa: atual ? taxaDe(atual.resultado, atual.n_tickets) : null, serie, autoHoras: S.reincidencia.autoHoras, analisando });
  } catch (e) { erro(res, e); }
});

// ── visão geral de todos os anos: veredito da IA sobre o contexto e as ações ──
// Chamado reincidente = a IA leu o assunto e o HISTÓRICO DE AÇÕES do chamado e do(s) chamado(s) anterior(es) do mesmo cliente (já encerrados, até 60 dias antes)
// e concluiu que é o MESMO PROBLEMA voltando. O módulo/rotina NÃO decide: é só uma dica para a IA e um filtro/agrupamento na tela.
// O banco só escolhe os candidatos (mesmo cliente + anterior encerrado até 60 dias antes, de qualquer módulo); o veredito fica em public.reincidencia_par.
// A janela "Voltou em até N dias" da tela filtra o veredito pelo intervalo real entre o encerramento do anterior e a abertura do novo.
// Data de encerramento: resolved_in/closed_in e, nos chamados antigos (que não trazem esses campos), a data da última ação de chamados já fechados.
const GERAL_CTE = `
WITH cf AS (
        SELECT ticket_id,
               min(valor_texto) FILTER (WHERE custom_field_id::bigint = ANY($6::bigint[])) AS modulo,
               min(valor_texto) FILTER (WHERE custom_field_id = '148916') AS causa,
               min(valor_texto) FILTER (WHERE custom_field_id = '23946') AS classif
          FROM silver.ticket_campo_customizado WHERE custom_field_id::bigint = ANY($7::bigint[]) GROUP BY ticket_id),
      b AS (
        SELECT t.ticket_id, t.subject, t.status, t.createddate, t.reopened_in,
               COALESCE(NULLIF(o.organizacao_nome,''), NULLIF(t.clientorganization,'')) AS cliente,
               COALESCE(NULLIF(trim(cf.modulo),''), NULLIF(trim(cf.causa),'')) AS motivo,
               COALESCE(NULLIF(t.owner_team,''), NULLIF(t.ownerteam,''), 'Sem equipe') AS equipe
          FROM silver.ticket t LEFT JOIN cf ON cf.ticket_id = t.ticket_id LEFT JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id
         WHERE ($5 = '' OR cf.classif = $5)),
      c AS (SELECT *, (cliente IS NOT NULL) AS classificado FROM b),
      f AS (
        SELECT c.*, (COALESCE(v.reincidente, false) AND v.dias_entre <= $1::int) AS rn, v.anterior_id::text AS ant_id, v.anterior_fim AS fim_ant, v.explicacao, v.confianca
          FROM c LEFT JOIN public.reincidencia_par v ON v.ticket_id = c.ticket_id::bigint
         WHERE ($2::int IS NULL OR extract(year from c.createddate)::int = $2)
           AND ($3 = '' OR c.equipe = $3)
           AND ($4 = '' OR c.cliente ILIKE '%' || $4 || '%')),
      fc AS (SELECT * FROM f WHERE classificado)
`;
const JANELAS = [7, 15, 30, 60];
const geralCache = new Map();                                            // chave dos filtros -> { em, dados }
const GERAL_TTL = 10 * 60 * 1000;
router.get('/geral', requireLeitura, async (req, res) => {
  try {
    const dias = JANELAS.includes(Number(req.query.dias)) ? Number(req.query.dias) : 15;
    const ano = /^\d{4}$/.test(String(req.query.ano || '')) ? Number(req.query.ano) : null;
    const equipe = String(req.query.equipe || '').trim().slice(0, 120);
    const busca = String(req.query.cliente || '').trim().slice(0, 120);
    const classif = req.query.classif === 'todas' ? '' : 'Suporte Técnico';
    const chave = JSON.stringify([dias, ano, equipe, busca.toLowerCase(), classif]);
    const c = geralCache.get(chave);
    if (c && Date.now() - c.em < GERAL_TTL) return res.json({ ...c.dados, cache: true });
    const mods = (await db.query(`SELECT custom_field_id::bigint AS id FROM silver.dim_campo_customizado WHERE nome_campo ILIKE '%m_dulo%rotina%' OR nome_campo ILIKE 'M_dulos - %'`)).rows.map((x) => Number(x.id));
    const campos = [...new Set([...mods, 148916, 23946])];
    const r = (await db.query(`
      ${GERAL_CTE}
      SELECT
        (SELECT json_build_object('total', count(*), 'classificados', count(*) FILTER (WHERE classificado), 'semMotivo', count(*) FILTER (WHERE NOT classificado),
                'reincidentes', count(*) FILTER (WHERE rn), 'clientes', count(DISTINCT cliente) FILTER (WHERE classificado), 'clientesAfetados', count(DISTINCT cliente) FILTER (WHERE rn),
                'motivosAfetados', count(DISTINCT motivo) FILTER (WHERE rn), 'reabertos', count(*) FILTER (WHERE reopened_in IS NOT NULL),
                'retornoMedio', round((avg(extract(epoch from (createddate - fim_ant)) / 86400) FILTER (WHERE rn))::numeric, 1),
                'retornoMediana', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (createddate - fim_ant)) / 86400) FILTER (WHERE rn))::numeric, 1)) FROM f) AS kpi,
        (SELECT COALESCE(json_agg(x ORDER BY x.ano), '[]') FROM (SELECT extract(year from createddate)::int AS ano, count(*)::int AS n, count(*) FILTER (WHERE rn)::int AS reinc,
                count(DISTINCT cliente) FILTER (WHERE rn)::int AS clientes FROM fc GROUP BY 1) x) AS anual,
        (SELECT COALESCE(json_agg(x ORDER BY x.mes), '[]') FROM (SELECT to_char(createddate AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS mes, count(*)::int AS n, count(*) FILTER (WHERE rn)::int AS reinc,
                count(DISTINCT cliente) FILTER (WHERE rn)::int AS clientes FROM fc GROUP BY 1) x) AS mensal,
        (SELECT COALESCE(json_agg(x ORDER BY x.reinc DESC), '[]') FROM (SELECT motivo, count(*)::int AS n, count(*) FILTER (WHERE rn)::int AS reinc, count(DISTINCT cliente) FILTER (WHERE rn)::int AS clientes
                FROM fc GROUP BY motivo HAVING count(*) FILTER (WHERE rn) > 0 ORDER BY 3 DESC LIMIT 15) x) AS motivos,
        (SELECT COALESCE(json_agg(x ORDER BY x.reinc DESC), '[]') FROM (SELECT cliente, count(*)::int AS n, count(*) FILTER (WHERE rn)::int AS reinc, count(DISTINCT motivo) FILTER (WHERE rn)::int AS motivos,
                mode() WITHIN GROUP (ORDER BY motivo) FILTER (WHERE rn) AS principal FROM fc GROUP BY cliente HAVING count(*) FILTER (WHERE rn) > 0 ORDER BY 3 DESC LIMIT 15) x) AS clientes,
        (SELECT COALESCE(json_agg(x ORDER BY x.reinc DESC), '[]') FROM (SELECT equipe, count(*)::int AS n, count(*) FILTER (WHERE rn)::int AS reinc FROM fc GROUP BY equipe HAVING count(*) FILTER (WHERE rn) > 0 ORDER BY 3 DESC LIMIT 10) x) AS equipes,
        (SELECT COALESCE(json_agg(DISTINCT extract(year from createddate)::int ORDER BY extract(year from createddate)::int), '[]') FROM c WHERE classificado) AS anos,
        (SELECT COALESCE(json_agg(e ORDER BY e), '[]') FROM (SELECT equipe AS e FROM c WHERE classificado GROUP BY equipe ORDER BY count(*) DESC LIMIT 40) q) AS equipesLista`,
      [dias, ano, equipe, busca, classif, mods.length ? mods : [0], campos])).rows[0];
    const dados = { filtros: { dias, ano, equipe, cliente: busca, classif: classif || 'todas' }, kpi: r.kpi, anual: r.anual, mensal: r.mensal, motivos: r.motivos, clientes: r.clientes, equipes: r.equipes,
      anos: r.anos, equipesLista: r.equipeslista, geradoEm: new Date().toISOString() };
    if (geralCache.size > 60) geralCache.clear();
    geralCache.set(chave, { em: Date.now(), dados });
    res.json({ ...dados, cache: false });
  } catch (e) { erro(res, e); }
});


// Chamados por trás de um número da visão geral (mesmos filtros e mesma regra). tipo: kpi | motivo | cliente | equipe | ano | mes
const KPI_FILTRO = { reincidentes: 'rn', classificados: 'classificado', semMotivo: 'NOT classificado', reabertos: 'reopened_in IS NOT NULL', clientesAfetados: 'rn', motivosAfetados: 'rn', clientes: 'classificado', total: 'TRUE' };
router.get('/geral/chamados', requireLeitura, async (req, res) => {
  try {
    const dias = JANELAS.includes(Number(req.query.dias)) ? Number(req.query.dias) : 15;
    const ano = /^\d{4}$/.test(String(req.query.ano || '')) ? Number(req.query.ano) : null;
    const equipe = String(req.query.equipe || '').trim().slice(0, 120);
    const busca = String(req.query.cliente || '').trim().slice(0, 120);
    const classif = req.query.classif === 'todas' ? '' : 'Suporte Técnico';
    const tipo = String(req.query.tipo || ''), valor = String(req.query.valor || '').slice(0, 200);
    let cond, extra = [];
    if (tipo === 'kpi' && KPI_FILTRO[valor]) cond = KPI_FILTRO[valor];
    else if (tipo === 'motivo') { cond = 'classificado AND rn AND motivo = $8'; extra = [valor]; }
    else if (tipo === 'cliente') { cond = 'classificado AND rn AND cliente = $8'; extra = [valor]; }
    else if (tipo === 'equipe') { cond = 'classificado AND rn AND equipe = $8'; extra = [valor]; }
    else if (tipo === 'ano' && /^\d{4}$/.test(valor)) { cond = 'classificado AND rn AND extract(year from createddate)::int = $8::int'; extra = [valor]; }
    else if (tipo === 'mes' && /^\d{4}-\d{2}$/.test(valor)) { cond = "classificado AND rn AND to_char(createddate AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $8"; extra = [valor]; }
    else return res.status(400).json({ error: 'Detalhe inválido' });
    const mods = (await db.query(`SELECT custom_field_id::bigint AS id FROM silver.dim_campo_customizado WHERE nome_campo ILIKE '%m_dulo%rotina%' OR nome_campo ILIKE 'M_dulos - %'`)).rows.map((x) => Number(x.id));
    const campos = [...new Set([...mods, 148916, 23946])];
    const r = await db.query(`
      ${GERAL_CTE}
      SELECT f.ticket_id::text AS ticket_id, f.subject AS assunto, f.status, f.cliente, f.motivo, f.equipe, f.createddate AS criado_em, f.ant_id AS anterior, p.subject AS anterior_assunto,
             f.fim_ant AS anterior_fim, round((extract(epoch from (f.createddate - f.fim_ant)) / 86400)::numeric, 1) AS dias_entre,
             f.rn AS reincidente, f.explicacao, f.confianca, (f.reopened_in IS NOT NULL) AS reaberto, f.classificado
        FROM f LEFT JOIN silver.ticket p ON p.ticket_id::text = f.ant_id WHERE ${cond.replace(/\b(rn|classificado|motivo|cliente|equipe|createddate|reopened_in)\b/g, 'f.$1')} ORDER BY f.createddate DESC LIMIT 501`,
      [dias, ano, equipe, busca, classif, mods.length ? mods : [0], campos, ...extra]);
    res.json({ total: Math.min(r.rows.length, 500), truncado: r.rows.length > 500, chamados: r.rows.slice(0, 500) });
  } catch (e) { erro(res, e); }
});


// ── análise dos pares candidatos (IA lê contexto e ações) ──
// O prompt-base é o MESMO da análise por IA (padrão ou o editado em Configurações → Assistente de IA); FORMATO_PARES só adapta a entrada e a saída aos pares.

const job = { rodando: false, total: 0, feitos: 0, reincidentes: 0, erros: 0, inicio: null, fim: null, msg: '', origem: '' };

async function candidatosPendentes(limite) {
  const mods = (await db.query(`SELECT custom_field_id::bigint AS id FROM silver.dim_campo_customizado WHERE nome_campo ILIKE '%m_dulo%rotina%' OR nome_campo ILIKE 'M_dulos - %'`)).rows.map((x) => Number(x.id));
  const campos = [...new Set([...mods, 148916, 23946])];
  const SQL_CAND = `
    WITH cf AS (
           SELECT ticket_id, min(valor_texto) FILTER (WHERE custom_field_id::bigint = ANY($1::bigint[])) AS modulo,
                  min(valor_texto) FILTER (WHERE custom_field_id = '148916') AS causa, min(valor_texto) FILTER (WHERE custom_field_id = '23946') AS classif
             FROM silver.ticket_campo_customizado WHERE custom_field_id::bigint = ANY($2::bigint[]) GROUP BY ticket_id),
         b AS (
           SELECT t.ticket_id::bigint AS id, t.subject, t.createddate,
                  COALESCE(t.resolved_in, t.closed_in, CASE WHEN t.basestatus IN ('Closed','Resolved','Canceled') THEN COALESCE(t.lastactiondate, t.lastupdate, t.last_update) END) AS fim,
                  COALESCE(NULLIF(o.organizacao_nome,''), NULLIF(t.clientorganization,'')) AS cliente,
                  COALESCE(NULLIF(trim(cf.modulo),''), NULLIF(trim(cf.causa),'')) AS modulo
             FROM silver.ticket t LEFT JOIN cf ON cf.ticket_id = t.ticket_id LEFT JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id
            WHERE cf.classif = 'Suporte Técnico'),
         pend AS (SELECT n.* FROM b n WHERE n.cliente IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.reincidencia_par v WHERE v.ticket_id = n.id) ORDER BY n.createddate DESC LIMIT $4),
         pares AS (
           SELECT n.id AS tid, n.createddate AS cd, p.id AS pid, p.fim AS pfim, (p.modulo IS NOT NULL AND p.modulo = n.modulo) AS mesmo_modulo,
                  row_number() OVER (PARTITION BY n.id ORDER BY p.fim DESC NULLS LAST) AS rk
             FROM pend n LEFT JOIN b p ON p.cliente = n.cliente AND p.id <> n.id AND p.fim IS NOT NULL AND p.fim < n.createddate AND n.createddate - p.fim <= interval '60 days'),
         sel AS (SELECT tid FROM pares WHERE pid IS NOT NULL GROUP BY tid ORDER BY max(cd) DESC LIMIT $3)
    SELECT p.tid, p.pid, p.pfim, p.mesmo_modulo, p.cd FROM pares p WHERE p.rk <= 2 AND (p.pid IS NULL OR p.tid IN (SELECT tid FROM sel)) ORDER BY p.cd DESC, p.rk`;
  // consulta pesada: roda numa transação com tempo limite para nunca segurar o banco do Dashboard
  const r = await db.withClient(async (cl) => {
    await cl.query('BEGIN'); await cl.query("SET LOCAL statement_timeout = '90s'");
    try { const x = await cl.query(SQL_CAND, [mods.length ? mods : [0], campos, limite, limite * 12]); await cl.query('COMMIT'); return x; }
    catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; }
  });
  const semCand = r.rows.filter((x) => x.pid == null).map((x) => Number(x.tid));
  if (semCand.length) await db.query(`INSERT INTO public.reincidencia_par (ticket_id, reincidente) SELECT unnest($1::bigint[]), FALSE ON CONFLICT (ticket_id) DO NOTHING`, [semCand]);
  r.rows = r.rows.filter((x) => x.pid != null);
  const por = new Map();
  for (const x of r.rows) { const k = Number(x.tid); if (!por.has(k)) por.set(k, []); por.get(k).push({ pid: Number(x.pid), fim: x.pfim, mesmoModulo: x.mesmo_modulo, cd: x.cd }); }
  return por;
}

async function processarLote(lista, S, C, userEmail) {
  const ids = [...new Set(lista.flatMap(([t, ps]) => [t, ...ps.map((p) => p.pid)]))];
  const tks = (await db.query(`SELECT t.ticket_id::bigint AS id, t.subject, t.createddate, COALESCE(NULLIF(o.organizacao_nome,''), t.clientorganization) AS cliente,
      (SELECT min(valor_texto) FROM silver.ticket_campo_customizado c WHERE c.ticket_id = t.ticket_id AND c.custom_field_id::bigint IN (SELECT custom_field_id::bigint FROM silver.dim_campo_customizado WHERE nome_campo ILIKE '%m_dulo%rotina%' OR nome_campo ILIKE 'M_dulos - %')) AS modulo
      FROM silver.ticket t LEFT JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id WHERE t.ticket_id::bigint = ANY($1::bigint[])`, [ids])).rows;
  const info = new Map(tks.map((t) => [Number(t.id), t]));
  const acoes = (await db.query(`SELECT ticket_id::bigint AS tid, descricao, is_public, criado_em, criado_por_nome, criado_por_profile_type
      FROM silver.ticket_acao WHERE ticket_id::bigint = ANY($1::bigint[]) ORDER BY ticket_id, criado_em`, [ids])).rows;
  const hist = new Map();
  for (const a of acoes) { if (!hist.has(Number(a.tid))) hist.set(Number(a.tid), []); hist.get(Number(a.tid)).push(a); }
  const texto = (id, orc) => conversaEmTexto((hist.get(id) || []).map((a) => ({ criadoEm: a.criado_em, autor: a.criado_por_nome, tipo: a.is_public === false ? 'interna' : 'publica',
    autorPerfil: a.criado_por_profile_type == null ? null : Number(a.criado_por_profile_type), texto: a.descricao })), orc);
  const cab = (id) => { const t = info.get(id) || {}; return `Cliente: ${limitar(t.cliente, 100)} · Criado em: ${dia(t.createddate)} · Módulo (dica): ${limitar(t.modulo, 100) || '—'}\nAssunto: ${limitar(t.subject, 200)}`; };
  const bloco = lista.map(([tid, ps]) => `### CHAMADO NOVO ${tid}\n${cab(tid)}\nHistórico:\n${texto(tid, 2200)}\n` +
    ps.map((p) => `--- CHAMADO ANTERIOR ${p.pid} (encerrado em ${dia(p.fim)})\n${cab(p.pid)}\nHistórico:\n${texto(p.pid, 1500)}`).join('\n')).join('\n\n');
  const system = `${REGRAS}${cfg.diretrizes(S)}\n${montarPrompt(C.promptBase, C.minClientesSistemico)}\n${FORMATO_PARES}${cfg.extra(C.instrucaoExtra)}`;
  const r = await chamarIA({ source: 'reincidencias', system, user: dados('CHAMADOS', bloco), maxTokens: 2500, temperature: cfg.temperatura(C.criatividade), timeoutMs: 120000, userEmail, meta: { pares: lista.length } });
  const res = new Map((Array.isArray(r.resultados) ? r.resultados : []).map((x) => [Number(x && x.ticket_id), x]));
  let reinc = 0;
  for (const [tid, ps] of lista) {
    const x = res.get(tid); if (!x) continue;                           // sem resposta: fica pendente para a próxima rodada
    const p = ps.find((q) => q.pid === Number(x.anterior_id));
    const sim = x.reincidente === true && !!p;
    if (sim) reinc++;
    const ref = p || ps[0];
    const dias = Math.round(((new Date(info.get(tid).createddate) - new Date(ref.fim)) / 86400000) * 10) / 10;
    await db.query(`INSERT INTO public.reincidencia_par (ticket_id, anterior_id, reincidente, confianca, explicacao, anterior_fim, dias_entre, mesmo_modulo, analisado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (ticket_id) DO UPDATE SET anterior_id = EXCLUDED.anterior_id, reincidente = EXCLUDED.reincidente, confianca = EXCLUDED.confianca,
        explicacao = EXCLUDED.explicacao, anterior_fim = EXCLUDED.anterior_fim, dias_entre = EXCLUDED.dias_entre, mesmo_modulo = EXCLUDED.mesmo_modulo, analisado_em = NOW()`,
      [tid, ref.pid, sim, conf(x.confianca), limitar(x.explicacao, 400), ref.fim, dias, ref.mesmoModulo]);
  }
  return { n: res.size, reinc };
}

// Roda em segundo plano: pega os candidatos ainda sem veredito (mais recentes primeiro) e manda a IA decidir em lotes.
async function rodarJob(maxChamados, usuario) {
  if (job.rodando) throw new IaError(409, 'Já existe uma análise do histórico em andamento.');
  const S = await cfg.obter(), C = S.reincidencia;
  if (!C.ativo) throw new IaError(403, 'Este recurso de IA foi desativado nas Configurações.');
  if (!(await iaConfigurada())) throw new IaError(400, 'A chave da OpenAI não está configurada.');
  Object.assign(job, { rodando: true, total: 0, feitos: 0, reincidentes: 0, erros: 0, inicio: new Date().toISOString(), fim: null, msg: 'Buscando candidatos…', origem: usuario ? 'manual' : 'automatica' });
  (async () => {
    try {
      const por = await candidatosPendentes(maxChamados);
      const lista = [...por.entries()];
      job.total = lista.length; job.msg = lista.length ? 'Analisando…' : 'Nada pendente: todos os candidatos já foram analisados.';
      const email = usuario ? usuario.email : 'automatico@hub'; let seguidos = 0;
      for (let i = 0; i < lista.length; i += 5) {
        try { const r = await processarLote(lista.slice(i, i + 5), S, C, email); job.feitos += r.n; job.reincidentes += r.reinc; seguidos = 0; geralCache.clear(); }
        catch (e) { job.erros++; seguidos++; job.msg = 'Erro no lote: ' + e.message; if (seguidos >= 3) { job.msg = 'Interrompido após 3 erros seguidos: ' + e.message; break; } }
      }
      if (job.erros === 0) job.msg = lista.length ? 'Concluído.' : job.msg;
    } catch (e) { job.erros++; job.msg = 'Falhou: ' + e.message; console.error('[reincidencias] job', e); }
    finally { job.rodando = false; job.fim = new Date().toISOString(); }
  })();
}

router.post('/geral/analisar', requireLeitura, rateLimit({ name: 'reincidencias/geral-analisar', windowMs: 10 * 60 * 1000, max: 6 }), async (req, res) => {
  try {
    const papel = (await db.query(`SELECT r.name, u.name AS nome FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user.id])).rows[0];
    if (!papel || !ROLES.includes(papel.name)) return res.status(403).json({ error: 'Seu perfil pode ver o painel, mas não gerar análises.' });
    await rodarJob(num(req.body && req.body.max, 10, 400, 150), { id: req.user.id, email: req.user.email });
    res.json({ job });
  } catch (e) { erro(res, e); }
});
router.get('/geral/progresso', requireLeitura, async (req, res) => {
  try {
    const r = (await db.query(`SELECT count(*) FILTER (WHERE anterior_id IS NOT NULL)::int AS analisados, count(*) FILTER (WHERE reincidente)::int AS reincidentes, max(analisado_em) AS ultimo FROM public.reincidencia_par`)).rows[0];
    res.json({ ...r, job });
  } catch (e) { erro(res, e); }
});

// ── análise automática: roda sozinha quando a última ficou velha (configurável; 0 = desligada) ──
async function rotinaAutomatica() {
  try {
    const S = await cfg.obter(), C = S.reincidencia;
    if (!C.ativo || !C.autoHoras || analisando || !(await iaConfigurada())) return;
    await db.query(`CREATE TABLE IF NOT EXISTS public.reincidencia_analise (id SERIAL PRIMARY KEY, criado_por INTEGER, criado_por_nome TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), parametros JSONB NOT NULL DEFAULT '{}', n_tickets INTEGER NOT NULL DEFAULT 0, resultado JSONB NOT NULL DEFAULT '{}')`);
    // só alimenta sozinha depois de alguém ter rodado a primeira análise pelo botão (evita gasto de IA e carga no banco logo após o deploy)
    const jaRodou = (await db.query(`SELECT 1 FROM public.reincidencia_par LIMIT 1`)).rows.length > 0;
    if (jaRodou && !job.rodando) await rodarJob(60, null).catch((e) => console.warn('[reincidencias] veredito automático:', e.message));
    const ult = (await db.query(`SELECT criado_em FROM public.reincidencia_analise WHERE COALESCE(parametros->>'servico','') = '' AND (parametros->>'dias')::int = $1 ORDER BY id DESC LIMIT 1`, [C.diasPadrao])).rows[0];
    if (ult && Date.now() - new Date(ult.criado_em).getTime() < C.autoHoras * 3600 * 1000) return;
    console.log('[reincidencias] rodando análise automática…');
    const a = await executar({ dias: C.diasPadrao }, null);
    console.log(`[reincidencias] análise automática #${a.id} concluída (${a.n_tickets} chamados).`);
  } catch (e) { console.warn('[reincidencias] análise automática falhou:', e.message); }
}
if (!process.env.REINCIDENCIAS_SEM_AUTO) {
  setTimeout(rotinaAutomatica, 2 * 60 * 1000).unref();                 // 2 min depois de subir
  setInterval(rotinaAutomatica, 30 * 60 * 1000).unref();               // e confere a cada 30 min
}

module.exports = router;
