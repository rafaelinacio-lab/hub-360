'use strict';
// Controle de horas da Política de SLA (POL-SLA-001) — Configurações → SLA e horas. Admin e supervisor veem; só admin altera regras e créditos.
//  GET/PUT /config                 parâmetros (janela, feriados, pausas, prazos por plano, faixas de crédito…)
//  GET     /status-conhecidos      status que aparecem nas ações (para escolher quais pausam o relógio)
//  GET     /clientes?q=            plano por cliente (organização) + busca · PUT /clientes/:orgId
//  GET     /apuracao?competencia=AAAA-MM            apuração mensal por cliente (só chamados de Suporte Técnico)
//  GET     /apuracao/detalhe?competencia=&org=      chamados e marcos de um cliente
//  POST    /creditos/gerar                          lança as horas técnicas sugeridas da competência
//  GET     /extrato/resumo · GET /extrato/:orgId · POST /extrato/uso · POST /extrato/ajuste
const express = require('express');
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const P = require('../utils/slaPolitica');

const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'supervisor'));
const soAdmin = requireRole('admin');
const limiteApurar = rateLimit({ name: 'slahoras/apurar', windowMs: 10 * 60 * 1000, max: 30 });
const erro = (res, e) => (console.error('[sla-horas]', e), res.status(e.status || 500).json({ error: e.message || 'Erro inesperado' }));
const usuario = (req) => (req.user && (req.user.email || req.user.name)) || 'admin';
const txt = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);
const CF_CLASSIFICACAO = 23946;
const FECHADOS = `'Resolved','Closed','Resolvido','Fechado'`;

let prontas = null;
router.use(async (req, res, next) => {
  try {
    if (!prontas) prontas = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS public.sla_cliente_plano (organizacao_id TEXT PRIMARY KEY, organizacao_nome TEXT, plano TEXT NOT NULL, observacao TEXT, atualizado_por TEXT, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.query(`CREATE TABLE IF NOT EXISTS public.sla_credito (id BIGSERIAL PRIMARY KEY, organizacao_id TEXT NOT NULL, organizacao_nome TEXT, competencia TEXT, tipo TEXT NOT NULL,
        horas NUMERIC(8,2) NOT NULL, motivo TEXT, validade DATE, origem JSONB, criado_por TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_sla_credito_competencia ON public.sla_credito (organizacao_id, competencia) WHERE tipo = 'credito'`);
      await db.query(`CREATE INDEX IF NOT EXISTS ix_sla_credito_org ON public.sla_credito (organizacao_id, criado_em)`);
    })().catch((e) => { prontas = null; throw e; });
    await prontas; next();
  } catch (e) { erro(res, e); }
});

// ── configuração ───────────────────────────────────────────────────────────
async function lerConfig() {
  const r = await db.query(`SELECT value FROM config WHERE key = 'sla_politica'`).catch(() => ({ rows: [] }));
  let salvo = null; try { salvo = r.rows[0] ? JSON.parse(r.rows[0].value) : null; } catch (_) { /* usa o padrão */ }
  return P.normalizar(salvo);
}
router.get('/config', async (req, res) => { try { res.json({ config: await lerConfig(), padrao: P.normalizar({}) }); } catch (e) { erro(res, e); } });
router.put('/config', soAdmin, async (req, res) => {
  try {
    const cfg = P.normalizar(req.body && req.body.config);
    await db.query(`INSERT INTO config (key, value) VALUES ('sla_politica', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(cfg)]);
    console.log(`[sla-horas] parâmetros alterados por ${usuario(req)}`);
    res.json({ config: cfg });
  } catch (e) { erro(res, e); }
});
router.get('/status-conhecidos', async (req, res) => {
  try {
    const r = await db.query(`SELECT status, COUNT(*)::int AS n FROM silver.ticket_acao WHERE status IS NOT NULL AND criado_em > NOW() - INTERVAL '12 months' GROUP BY 1 ORDER BY 2 DESC LIMIT 80`);
    res.json({ status: r.rows });
  } catch (e) { erro(res, e); }
});

// ── plano por cliente ───────────────────────────────────────────────────────
router.get('/clientes', async (req, res) => {
  try {
    const q = txt(req.query.q, 80);
    const definidos = (await db.query(`SELECT organizacao_id, organizacao_nome, plano, observacao, atualizado_por, atualizado_em FROM public.sla_cliente_plano ORDER BY organizacao_nome`)).rows;
    let busca = [];
    if (q.length >= 2) {
      busca = (await db.query(`SELECT DISTINCT ON (organizacao_id) organizacao_id, organizacao_nome FROM silver.ticket_organizacao
          WHERE organizacao_id IS NOT NULL AND organizacao_nome ILIKE $1 ORDER BY organizacao_id LIMIT 40`, [`%${q}%`])).rows;
    }
    res.json({ definidos, busca });
  } catch (e) { erro(res, e); }
});
router.put('/clientes/:orgId', soAdmin, async (req, res) => {
  try {
    const orgId = txt(req.params.orgId, 80), plano = req.body && req.body.plano;
    if (!orgId) return res.status(400).json({ error: 'Cliente inválido' });
    if (plano === null || plano === 'remover') { await db.query(`DELETE FROM public.sla_cliente_plano WHERE organizacao_id = $1`, [orgId]); return res.json({ ok: true }); }
    if (!['padrao', 'premium'].includes(plano)) return res.status(400).json({ error: 'Plano inválido (use padrao ou premium)' });
    await db.query(`INSERT INTO public.sla_cliente_plano (organizacao_id, organizacao_nome, plano, observacao, atualizado_por) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (organizacao_id) DO UPDATE SET plano = EXCLUDED.plano, organizacao_nome = COALESCE(NULLIF(EXCLUDED.organizacao_nome,''), public.sla_cliente_plano.organizacao_nome),
        observacao = EXCLUDED.observacao, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
      [orgId, txt(req.body.nome, 200), plano, txt(req.body.observacao, 300) || null, usuario(req)]);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

// ── apuração mensal ──────────────────────────────────────────────────────────
const ehAgente = (a) => a.is_public && (['1', '3'].includes(String(a.criado_por_profile_type)) || (a.criado_por_profile_type == null && /@viasoft\.com\.br$/i.test(a.criado_por_email || '')));
async function carregarChamados(competencia, cfg) {
  const [ano, mes] = competencia.split('-').map(Number);
  const ini = `${competencia}-01T00:00:00-03:00`;
  const prox = mes === 12 ? `${ano + 1}-01` : `${ano}-${String(mes + 1).padStart(2, '0')}`;
  const fim = `${prox}-01T00:00:00-03:00`;
  const tk = (await db.query(`
    SELECT t.ticket_id::text AS id, t.subject, t.createddate AS criado_em, COALESCE(t.resolved_in, t.closed_in) AS encerrado_em, t.urgency AS urgencia,
           o.organizacao_id, COALESCE(NULLIF(btrim(o.organizacao_nome), ''), 'Sem organização') AS organizacao_nome
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
      LEFT JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id
     WHERE translate(lower(cf.valor_texto), 'éèêáàâãíóôõúç', 'eeeaaaaiooouc') = 'suporte tecnico'
       AND t.basestatus IN (${FECHADOS}) AND COALESCE(t.resolved_in, t.closed_in) >= $1::timestamptz AND COALESCE(t.resolved_in, t.closed_in) < $2::timestamptz`, [ini, fim])).rows;
  const ids = tk.map((t) => t.id);
  const acoes = new Map();
  for (let i = 0; i < ids.length; i += 3000) {
    const r = await db.query(`SELECT ticket_id::text AS id, criado_em, status, is_public, criado_por_profile_type, criado_por_email, criado_por_nome
        FROM silver.ticket_acao WHERE ticket_id = ANY($1::bigint[]) ORDER BY criado_em`, [ids.slice(i, i + 3000)]);
    for (const a of r.rows) { if (!acoes.has(a.id)) acoes.set(a.id, []); acoes.get(a.id).push(a); }
  }
  const auto = new Set(cfg.autoresAutomaticos.map(P.semAcento));
  return tk.map((t) => {
    const lista = acoes.get(t.id) || [];
    const pr = lista.find((a) => ehAgente(a) && !auto.has(P.semAcento(a.criado_por_nome)) && new Date(a.criado_em) > new Date(t.criado_em));
    return { ...t, eventos: lista.filter((a) => a.status).map((a) => ({ em: a.criado_em, status: a.status })), primeiraRespostaEm: pr ? pr.criado_em : null };
  });
}
async function planosMap() {
  return new Map((await db.query(`SELECT organizacao_id, plano FROM public.sla_cliente_plano`)).rows.map((r) => [r.organizacao_id, r.plano]));
}
const compOk = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''));
async function apurar(competencia, cfg) {
  const [chamados, planos] = await Promise.all([carregarChamados(competencia, cfg), planosMap()]);
  const por = new Map();
  for (const c of chamados) {
    const chave = c.organizacao_id || `sem:${c.organizacao_nome}`;
    if (!por.has(chave)) por.set(chave, { organizacao_id: c.organizacao_id || null, nome: c.organizacao_nome, plano: planos.get(c.organizacao_id) || cfg.planoPadrao, planoDefinido: planos.has(c.organizacao_id), itens: [] });
    const g = por.get(chave);
    g.itens.push({ c, av: P.avaliarChamado({ criadoEm: c.criado_em, resolvidoEm: c.encerrado_em, urgencia: c.urgencia, eventos: c.eventos, primeiraRespostaEm: c.primeiraRespostaEm, contornoEm: null }, g.plano, cfg) });
  }
  const clientes = [...por.values()].map((g) => ({ organizacao_id: g.organizacao_id, nome: g.nome, plano: g.plano, planoDefinido: g.planoDefinido, ...P.apurarCliente(g.itens.map((i) => i.av), cfg), _itens: g.itens }))
    .sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));
  return { competencia, clientes, chamados: chamados.length };
}
router.get('/apuracao', limiteApurar, async (req, res) => {
  try {
    if (!compOk(req.query.competencia)) return res.status(400).json({ error: 'Informe a competência no formato AAAA-MM' });
    const cfg = await lerConfig(), r = await apurar(req.query.competencia, cfg);
    const lanc = new Map((await db.query(`SELECT organizacao_id, SUM(horas)::float AS horas FROM public.sla_credito WHERE tipo = 'credito' AND competencia = $1 GROUP BY 1`, [req.query.competencia])).rows.map((x) => [x.organizacao_id, x.horas]));
    const aval = r.clientes.reduce((s, c) => s + c.avaliados, 0), dentro = r.clientes.reduce((s, c) => s + c.dentro, 0);
    res.json({ competencia: r.competencia, chamados: r.chamados, total: { clientes: r.clientes.length, avaliados: aval, dentro, fora: aval - dentro, pct: aval ? dentro / aval * 100 : null },
      contornoMedido: false, clientes: r.clientes.map(({ _itens, ...c }) => ({ ...c, creditoLancado: lanc.get(c.organizacao_id) ?? null })) });
  } catch (e) { erro(res, e); }
});
router.get('/apuracao/detalhe', limiteApurar, async (req, res) => {
  try {
    if (!compOk(req.query.competencia)) return res.status(400).json({ error: 'Informe a competência no formato AAAA-MM' });
    const cfg = await lerConfig(), r = await apurar(req.query.competencia, cfg);
    const org = String(req.query.org || '');
    const c = r.clientes.find((x) => (x.organizacao_id || `sem:${x.nome}`) === org);
    if (!c) return res.json({ chamados: [] });
    res.json({ cliente: { nome: c.nome, plano: c.plano }, chamados: c._itens.map(({ c: t, av }) => ({ id: t.id, assunto: t.subject, criado_em: t.criado_em, encerrado_em: t.encerrado_em, severidade: av.severidade, dentro: av.dentro,
      marcos: av.marcos, naoMedidos: av.naoMedidos })).sort((a, b) => (a.dentro === b.dentro ? 0 : a.dentro === false ? -1 : 1)) });
  } catch (e) { erro(res, e); }
});

// ── créditos e extrato ──────────────────────────────────────────────────────────
router.post('/creditos/gerar', soAdmin, limiteApurar, async (req, res) => {
  try {
    const competencia = req.body && req.body.competencia;
    if (!compOk(competencia)) return res.status(400).json({ error: 'Informe a competência no formato AAAA-MM' });
    const hoje = new Date().toISOString().slice(0, 7);
    if (competencia >= hoje) return res.status(409).json({ error: 'A competência ainda não terminou: só dá para lançar créditos de meses encerrados.' });
    const cfg = await lerConfig(), r = await apurar(competencia, cfg);
    const so = Array.isArray(req.body.orgIds) && req.body.orgIds.length ? new Set(req.body.orgIds.map(String)) : null;
    const hoje10 = new Date().toISOString().slice(0, 10);
    const feitos = [], pulados = [];
    for (const c of r.clientes) {
      if (!c.organizacao_id) { if (c.creditoSugerido > 0) pulados.push({ nome: c.nome, motivo: 'sem organização identificada' }); continue; }
      if (so && !so.has(c.organizacao_id)) continue;
      if (c.creditoSugerido <= 0) continue;
      if (c.acumula) { pulados.push({ nome: c.nome, motivo: `menos de ${cfg.minimoElegiveis} chamados avaliados (a apuração acumula)` }); continue; }
      const ins = await db.query(`INSERT INTO public.sla_credito (organizacao_id, organizacao_nome, competencia, tipo, horas, motivo, validade, origem, criado_por)
        VALUES ($1,$2,$3,'credito',$4,$5,$6::date,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [c.organizacao_id, c.nome, competencia, c.creditoSugerido, `Cumprimento global ${c.pct.toFixed(2)}% em ${competencia}${c.gatilhoCritico ? ' (gatilho de chamado Crítico)' : ''}`,
          P.somaMeses(hoje10, cfg.validadeMeses), JSON.stringify({ pct: c.pct, avaliados: c.avaliados, dentro: c.dentro, plano: c.plano }), usuario(req)]);
      if (ins.rows.length) feitos.push({ nome: c.nome, horas: c.creditoSugerido }); else pulados.push({ nome: c.nome, motivo: 'crédito desta competência já lançado' });
    }
    console.log(`[sla-horas] créditos de ${competencia}: ${feitos.length} lançado(s) por ${usuario(req)}`);
    res.json({ lancados: feitos, pulados });
  } catch (e) { erro(res, e); }
});
router.get('/extrato/resumo', async (req, res) => {
  try {
    const rows = (await db.query(`SELECT organizacao_id, organizacao_nome, tipo, horas::float AS horas, criado_em, validade FROM public.sla_credito ORDER BY criado_em`)).rows;
    const por = new Map();
    for (const l of rows) { if (!por.has(l.organizacao_id)) por.set(l.organizacao_id, { organizacao_id: l.organizacao_id, nome: l.organizacao_nome, l: [] }); por.get(l.organizacao_id).l.push(l); }
    res.json({ clientes: [...por.values()].map((g) => ({ organizacao_id: g.organizacao_id, nome: g.nome, ...P.saldoExtrato(g.l) })).sort((a, b) => b.disponivel - a.disponivel) });
  } catch (e) { erro(res, e); }
});
router.get('/extrato/:orgId', async (req, res) => {
  try {
    const l = (await db.query(`SELECT id, competencia, tipo, horas::float AS horas, motivo, validade, criado_por, criado_em FROM public.sla_credito WHERE organizacao_id = $1 ORDER BY criado_em DESC, id DESC`, [txt(req.params.orgId, 80)])).rows;
    res.json({ lancamentos: l, saldo: P.saldoExtrato(l) });
  } catch (e) { erro(res, e); }
});
async function lancar(req, res, tipo) {
  const b = req.body || {}, orgId = txt(b.organizacao_id, 80), horas = Number(b.horas), motivo = txt(b.motivo, 400);
  if (!orgId) return res.status(400).json({ error: 'Informe o cliente.' });
  if (!Number.isFinite(horas) || horas === 0 || Math.abs(horas) > 1000) return res.status(400).json({ error: 'Informe uma quantidade de horas válida.' });
  if (tipo === 'uso' && horas < 0) return res.status(400).json({ error: 'O uso deve ser um valor positivo.' });
  if (motivo.length < 5) return res.status(400).json({ error: 'Explique o motivo (mínimo 5 caracteres) para ficar na auditoria.' });
  const atuais = (await db.query(`SELECT tipo, horas::float AS horas, criado_em, validade FROM public.sla_credito WHERE organizacao_id = $1`, [orgId])).rows;
  const saldo = P.saldoExtrato(atuais);
  if (tipo === 'uso' && horas > saldo.disponivel + 1e-9) return res.status(409).json({ error: `Saldo insuficiente: o cliente tem ${saldo.disponivel.toLocaleString('pt-BR')} h disponíveis (créditos vencidos não contam).` });
  const nome = txt(b.nome, 200) || (await db.query(`SELECT organizacao_nome FROM public.sla_credito WHERE organizacao_id = $1 LIMIT 1`, [orgId])).rows[0]?.organizacao_nome || null;
  await db.query(`INSERT INTO public.sla_credito (organizacao_id, organizacao_nome, tipo, horas, motivo, criado_por) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, nome, tipo, horas, motivo, usuario(req)]);
  res.json({ ok: true });
}
router.post('/extrato/uso', async (req, res) => { try { await lancar(req, res, 'uso'); } catch (e) { erro(res, e); } });
router.post('/extrato/ajuste', soAdmin, async (req, res) => { try { await lancar(req, res, 'ajuste'); } catch (e) { erro(res, e); } });

module.exports = router;
