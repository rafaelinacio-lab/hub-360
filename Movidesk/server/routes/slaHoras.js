'use strict';
// Controle de horas da Política de SLA (POL-SLA-001) — Configurações → SLA e horas. Admin e supervisor veem; só admin altera regras e créditos.
//  GET/PUT /config                 parâmetros (janela, feriados, pausas, prazos por plano, faixas de crédito…)
//  GET     /status-conhecidos      status que aparecem nas ações (para escolher quais pausam o relógio)
//  GET     /clientes?q=            plano por cliente (organização) + busca · PUT /clientes/:orgId
//  GET     /apuracao?competencia=AAAA-MM            apuração mensal por cliente (só chamados de Suporte Técnico)
//  GET     /apuracao/detalhe?competencia=&org=      chamados e marcos de um cliente
//  POST    /creditos/gerar                          força agora a rodada automática de lançamento de horas técnicas (idempotente)
//  GET     /automatico/status                       resultado da última rodada automática
//  GET     /extrato/resumo · GET /extrato/:orgId · POST /extrato/uso · POST /extrato/ajuste
const express = require('express');
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const P = require('../utils/slaPolitica');
const core = require('../utils/slaHorasCore');
const { lerConfig, apurar, compOk } = core;
const { escopoVertical, pertence } = require('../utils/verticalScope');

const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'supervisor'));
router.use(async (req, res, next) => { try { await core.prepararTabelas(); next(); } catch (e) { erro(res, e); } });
const soAdmin = requireRole('admin');
const limiteApurar = rateLimit({ name: 'slahoras/apurar', windowMs: 10 * 60 * 1000, max: 30 });
const erro = (res, e) => (console.error('[sla-horas]', e), res.status(e.status || 500).json({ error: e.message || 'Erro inesperado' }));
const usuario = (req) => (req.user && (req.user.email || req.user.name)) || 'admin';
const txt = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);
const CF_CLASSIFICACAO = 23946;
const FECHADOS = `'Resolved','Closed','Resolvido','Fechado'`;

// Escopo por vertical (regra única dos painéis, verticalScope.js): perfil com vertical atribuída vê só os CLIENTES com chamado da
// sua vertical, com os números oficiais e completos (cumprimento e créditos são do cliente, não se recalcula por vertical).
// Admin e perfil sem vertical: null = sem filtro e sem consulta extra. Rotinas automáticas do servidor não passam por aqui.
async function escopoClientes(req) {
  const esc = await escopoVertical(req.user.id);
  if (!esc.filtrar) return null;
  const o = await core.orgsDoEscopo(esc);
  return { verticais: esc.verticais, ids: o.ids, nomes: o.nomes };
}
const orgVisivel = (sc, orgId) => !sc || sc.ids.has(String(orgId));
// cliente da apuração: com organização vale o conjunto do escopo; "sem organização" vale se algum chamado dele é da vertical
const clienteVisivel = (sc, c) => !sc || (c.organizacao_id
  ? sc.ids.has(String(c.organizacao_id))
  : (c._itens || []).some((i) => pertence(sc.verticais, { servico: i.c.servico, equipe: i.c.servico ? null : i.c.equipe })));
const FORA = { status: 404, message: 'Cliente não encontrado na sua vertical' };

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
    const q = txt(req.query.q, 80), sc = await escopoClientes(req);
    const definidos = (await db.query(`SELECT organizacao_id, organizacao_nome, plano, observacao, atualizado_por, atualizado_em FROM public.sla_cliente_plano ORDER BY organizacao_nome`)).rows
      .filter((d) => orgVisivel(sc, d.organizacao_id));
    let busca = [];
    if (q.length >= 2) {
      busca = (await db.query(`SELECT DISTINCT ON (organizacao_id) organizacao_id, organizacao_nome FROM silver.ticket_organizacao
          WHERE organizacao_id IS NOT NULL AND organizacao_nome ILIKE $1 ${sc ? 'AND organizacao_id::text = ANY($2::text[])' : ''} ORDER BY organizacao_id LIMIT 40`,
        sc ? [`%${q}%`, [...sc.ids]] : [`%${q}%`])).rows;
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

router.get('/apuracao', limiteApurar, async (req, res) => {
  try {
    if (!compOk(req.query.competencia)) return res.status(400).json({ error: 'Informe a competência no formato AAAA-MM' });
    const cfg = await lerConfig(), r = await apurar(req.query.competencia, cfg), sc = await escopoClientes(req);
    if (sc) { r.clientes = r.clientes.filter((c) => clienteVisivel(sc, c)); r.chamados = r.clientes.reduce((n, c) => n + (c._itens ? c._itens.length : 0), 0); }   // totais = só o que o usuário vê
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
    const org = String(req.query.org || ''), sc = await escopoClientes(req);
    const c = r.clientes.find((x) => (x.organizacao_id || `sem:${x.nome}`) === org);
    if (c && !clienteVisivel(sc, c)) return res.status(FORA.status).json({ error: FORA.message });   // fora da vertical: 404, sem revelar
    if (!c) return res.json({ chamados: [] });
    res.json({ cliente: { nome: c.nome, plano: c.plano }, chamados: c._itens.map(({ c: t, av }) => ({ id: t.id, assunto: t.subject, criado_em: t.criado_em, encerrado_em: t.encerrado_em, severidade: av.severidade, dentro: av.dentro,
      marcos: av.marcos, naoMedidos: av.naoMedidos, prOrigem: t.prOrigem, prMotivo: t.prMotivo, prPor: t.prPor })).sort((a, b) => (a.dentro === b.dentro ? 0 : a.dentro === false ? -1 : 1)) });
  } catch (e) { erro(res, e); }
});

// ── créditos e extrato ──────────────────────────────────────────────────────────
// Os créditos são lançados SOZINHOS (rotina horária em utils/slaHorasCore.js). Este botão só força uma rodada agora e é idempotente.
router.post('/creditos/gerar', soAdmin, limiteApurar, async (req, res) => {
  try {
    const r = await core.processarCompetencias({ por: usuario(req), forcar: true });
    core.invalidarSaldos();
    res.json(r);
  } catch (e) { erro(res, e); }
});
router.get('/automatico/status', async (req, res) => {
  try {
    const status = await core.lerStatus(), sc = await escopoClientes(req);
    if (sc && status && Array.isArray(status.detalhesLancados)) {   // a lista traz o NOME dos clientes com crédito lançado
      const completa = status.detalhesLancados.length >= Number(status.lancados || 0);
      status.detalhesLancados = status.detalhesLancados.filter((d) => sc.nomes.has(P.semAcento(d.nome)));
      if (completa) status.lancados = status.detalhesLancados.length;
    }
    res.json({ status, reparo: core.estadoReparo() });
  } catch (e) { erro(res, e); }
});
// Reconsulta no Movidesk os chamados da competência cujas ações públicas estão sem autor (em segundo plano; acompanhe em /automatico/status).
router.post('/reparar-autores', soAdmin, limiteApurar, async (req, res) => {
  try {
    if (!compOk(req.body && req.body.competencia)) return res.status(400).json({ error: 'Informe a competência no formato AAAA-MM' });
    if (core.estadoReparo().rodando) return res.status(409).json({ error: 'Já existe um reparo em andamento.' });
    core.repararAutores(req.body.competencia, { limite: 5000 }).then(() => core.invalidarSaldos()).catch((e) => console.error('[sla-horas] reparo de autores:', e.message));
    res.json({ iniciado: true });
  } catch (e) { erro(res, e); }
});
router.get('/extrato/resumo', async (req, res) => {
  try {
    const rows = (await db.query(`SELECT organizacao_id, organizacao_nome, tipo, horas::float AS horas, criado_em, validade FROM public.sla_credito ORDER BY criado_em`)).rows;
    const por = new Map(), sc = await escopoClientes(req);
    for (const l of rows) { if (!orgVisivel(sc, l.organizacao_id)) continue; if (!por.has(l.organizacao_id)) por.set(l.organizacao_id, { organizacao_id: l.organizacao_id, nome: l.organizacao_nome, l: [] }); por.get(l.organizacao_id).l.push(l); }
    res.json({ clientes: [...por.values()].map((g) => ({ organizacao_id: g.organizacao_id, nome: g.nome, ...P.saldoExtrato(g.l) })).sort((a, b) => b.disponivel - a.disponivel) });
  } catch (e) { erro(res, e); }
});
router.get('/extrato/:orgId', async (req, res) => {
  try {
    if (!orgVisivel(await escopoClientes(req), txt(req.params.orgId, 80))) return res.status(FORA.status).json({ error: FORA.message });
    const l = (await db.query(`SELECT id, competencia, tipo, horas::float AS horas, motivo, validade, criado_por, criado_em FROM public.sla_credito WHERE organizacao_id = $1 ORDER BY criado_em DESC, id DESC`, [txt(req.params.orgId, 80)])).rows;
    res.json({ lancamentos: l, saldo: P.saldoExtrato(l) });
  } catch (e) { erro(res, e); }
});
async function lancar(req, res, tipo) {
  const b = req.body || {}, orgId = txt(b.organizacao_id, 80), horas = Number(b.horas), motivo = txt(b.motivo, 400);
  if (!orgId) return res.status(400).json({ error: 'Informe o cliente.' });
  if (!orgVisivel(await escopoClientes(req), orgId)) return res.status(403).json({ error: 'Cliente fora da sua vertical.' });   // quem tem vertical só age nos clientes dela
  if (!Number.isFinite(horas) || horas === 0 || Math.abs(horas) > 1000) return res.status(400).json({ error: 'Informe uma quantidade de horas válida.' });
  if (tipo === 'uso' && horas < 0) return res.status(400).json({ error: 'O uso deve ser um valor positivo.' });
  if (motivo.length < 5) return res.status(400).json({ error: 'Explique o motivo (mínimo 5 caracteres) para ficar na auditoria.' });
  const atuais = (await db.query(`SELECT tipo, horas::float AS horas, criado_em, validade FROM public.sla_credito WHERE organizacao_id = $1`, [orgId])).rows;
  const saldo = P.saldoExtrato(atuais);
  if (tipo === 'uso' && horas > saldo.disponivel + 1e-9) return res.status(409).json({ error: `Saldo insuficiente: o cliente tem ${saldo.disponivel.toLocaleString('pt-BR')} h disponíveis (créditos vencidos não contam).` });
  const nome = txt(b.nome, 200) || (await db.query(`SELECT organizacao_nome FROM public.sla_credito WHERE organizacao_id = $1 LIMIT 1`, [orgId])).rows[0]?.organizacao_nome || null;
  await db.query(`INSERT INTO public.sla_credito (organizacao_id, organizacao_nome, tipo, horas, motivo, criado_por) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, nome, tipo, horas, motivo, usuario(req)]);
  core.invalidarSaldos();
  res.json({ ok: true });
}
router.post('/extrato/uso', async (req, res) => { try { await lancar(req, res, 'uso'); } catch (e) { erro(res, e); } });
router.post('/extrato/ajuste', soAdmin, async (req, res) => { try { await lancar(req, res, 'ajuste'); } catch (e) { erro(res, e); } });

module.exports = router;
