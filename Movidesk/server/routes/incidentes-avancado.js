'use strict';
// Incidentes — fase 2: correlação automática de chamados, ligação com o Movidesk,
// pós-incidente (análise de causa raiz, blameless) e gestão de problemas (ITIL).
//
//  - sugestões: agrupa chamados abertos recentes parecidos (utils/correlacao.js) — só LÊ, quem decide é a pessoa;
//  - Movidesk: escreve notas/respostas nos chamados vinculados, em nome de quem está logado, com confirmação;
//  - pós-incidente: documento por incidente (rascunho → publicado), com ações corretivas e rascunho opcional da IA;
//  - problema: causa raiz compartilhada por vários incidentes, com contorno (erro conhecido).
const express = require('express');
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const cfg = require('../utils/aiSettings');
const { chamarIA, REGRAS, dados, limitar } = require('../utils/ai');
const { MovideskError, movidesk, agenteDoUsuario } = require('../utils/movideskPeople');
const correl = require('../utils/correlacao');
const base = require('./incidentes');

const H = base.helpers;
const { requireLeitura, exigirEscrita, evento, idValido, erro, codigoDe, listaTickets } = H;
const router = express.Router();
router.use(authMiddleware);

const ACAO_ORIGEM = Number(process.env.MOVIDESK_ACTION_ORIGIN || 9);
const ACAO_TIPO = { interna: 1, publica: 2 };
const STATUS_PROBLEMA = ['aberto', 'analise', 'erro_conhecido', 'resolvido'];
const ROTULO_PROBLEMA = { aberto: 'Aberto', analise: 'Em análise', erro_conhecido: 'Erro conhecido', resolvido: 'Resolvido' };
const ABERTOS = `('New','InAttendance','Stopped','InProgress')`;

let prontas = null;
function garantir() {
  if (!prontas) {
    prontas = (async () => {
      await H.garantirTabelas();
      await db.query(`CREATE TABLE IF NOT EXISTS public.incidente_posmortem (
        incidente_id INTEGER PRIMARY KEY REFERENCES public.incidente(id) ON DELETE CASCADE,
        resumo TEXT, impacto TEXT, causa_raiz TEXT, porques JSONB NOT NULL DEFAULT '[]', o_que_funcionou TEXT, o_que_melhorar TEXT,
        acoes JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'rascunho',
        atualizado_por INTEGER, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), publicado_em TIMESTAMPTZ)`);
      await db.query(`CREATE TABLE IF NOT EXISTS public.problema (
        id SERIAL PRIMARY KEY, titulo TEXT NOT NULL, descricao TEXT, causa_raiz TEXT, contorno TEXT,
        status TEXT NOT NULL DEFAULT 'aberto', responsavel_id INTEGER, criado_por INTEGER,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolvido_em TIMESTAMPTZ)`);
      await db.query(`CREATE TABLE IF NOT EXISTS public.problema_incidente (
        problema_id INTEGER NOT NULL REFERENCES public.problema(id) ON DELETE CASCADE,
        incidente_id INTEGER NOT NULL REFERENCES public.incidente(id) ON DELETE CASCADE,
        vinculado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (problema_id, incidente_id))`);
      await db.query(`CREATE TABLE IF NOT EXISTS public.incidente_sugestao_ignorada (
        ticket_id BIGINT PRIMARY KEY, ignorado_por INTEGER, ignorado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    })().catch((e) => { prontas = null; throw e; });
  }
  return prontas;
}
router.use(async (req, res, next) => { try { await garantir(); next(); } catch (e) { erro(res, e); } });

const codigoProblema = (id) => `PRB-${String(id).padStart(4, '0')}`;
const num = (v, min, max, pad) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : pad; };

// ── 1. correlação automática ────────────────────────────────────────────────
const SEM_VINCULO = `NOT EXISTS (SELECT 1 FROM public.incidente_ticket it WHERE it.ticket_id = t.ticket_id::bigint)
                     AND NOT EXISTS (SELECT 1 FROM public.incidente_sugestao_ignorada ig WHERE ig.ticket_id = t.ticket_id::bigint)`;
async function candidatos(horas, extra = '', params = []) {
  const r = await db.query(`
    SELECT t.ticket_id::bigint AS id, t.subject AS assunto, t.service_full AS servico, t.createddate AS "criadoEm", t.status,
           o.organizacao_id AS "clienteId", COALESCE(o.organizacao_nome, t.clientorganization) AS cliente
      FROM silver.ticket t
      LEFT JOIN LATERAL (SELECT organizacao_id, organizacao_nome FROM silver.ticket_organizacao x WHERE x.ticket_id = t.ticket_id::bigint LIMIT 1) o ON TRUE
     WHERE t.createddate >= NOW() - make_interval(hours => $1::int) AND t.basestatus IN ${ABERTOS} AND ${SEM_VINCULO} ${extra}
     ORDER BY t.createddate DESC LIMIT 3000`, [horas, ...params]);
  return r.rows;
}

router.get('/sugestoes', requireLeitura, async (req, res) => {
  try {
    const horas = num(req.query.horas, 1, 72, 12), minTickets = num(req.query.min, 2, 30, 3), minClientes = num(req.query.clientes, 1, 20, 2);
    const grupos = correl.agrupar(await candidatos(horas), { minTickets, minClientes }).slice(0, 12)
      .map((g) => ({ ...g, ...correl.sugerirNiveis(g) }));
    res.json({ horas, minTickets, minClientes, sugestoes: grupos });
  } catch (e) { erro(res, e); }
});

router.post('/sugestoes/ignorar', requireLeitura, exigirEscrita, async (req, res) => {
  const ids = listaTickets(req.body?.ticketIds).slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: 'Informe os chamados.' });
  try {
    for (const id of ids) await db.query(`INSERT INTO public.incidente_sugestao_ignorada (ticket_id, ignorado_por) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, req.user.id]);
    res.json({ ok: true, ignorados: ids.length });
  } catch (e) { erro(res, e); }
});

// chamados soltos que combinam com um incidente aberto
router.get('/:id/relacionados', requireLeitura, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  try {
    const inc = (await db.query(`SELECT * FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!inc) return res.status(404).json({ error: 'Incidente não encontrado' });
    if (inc.status === 'fechado') return res.json({ relacionados: [] });
    const meus = (await db.query(`SELECT t.subject AS assunto FROM public.incidente_ticket it JOIN silver.ticket t ON t.ticket_id::bigint = it.ticket_id WHERE it.incidente_id = $1`, [id])).rows;
    const horas = Math.min(72, Math.max(6, Math.ceil((Date.now() - new Date(inc.aberto_em).getTime()) / 3600000) + 6));
    const lista = correl.relacionados(inc, meus, await candidatos(horas));
    res.json({ relacionados: lista.map((c) => ({ id: c.id, assunto: limitar(c.assunto, 160), cliente: c.cliente, status: c.status, score: c.score, mesmoServico: c.mesmoServico, criadoEm: c.criadoEm })) });
  } catch (e) { erro(res, e); }
});

// ── 2. ligação com o Movidesk: avisar os chamados vinculados ───────────────
const limiteAviso = rateLimit({ name: 'incidentes/movidesk', windowMs: 10 * 60 * 1000, max: 8 });
router.post('/:id/movidesk/avisar', requireLeitura, exigirEscrita, limiteAviso, async (req, res) => {
  const id = idValido(req.params.id);
  const tipo = req.body?.tipo === 'publica' ? 'publica' : 'interna';
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  if (req.body?.confirmar !== true) return res.status(400).json({ error: 'Confirme o envio antes de continuar.' });
  try {
    const inc = (await db.query(`SELECT * FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!inc) return res.status(404).json({ error: 'Incidente não encontrado' });
    if (inc.status === 'fechado') return res.status(409).json({ error: 'Incidente fechado não envia avisos.' });
    let texto = String(req.body?.texto || '').trim();
    if (req.body?.modelo === 'vinculo') texto = `Este chamado está vinculado ao incidente ${codigoDe(inc.id)} — ${inc.titulo} (P${inc.prioridade}). O tratamento é feito de forma centralizada pelo time de suporte.`;
    if (!texto) return res.status(400).json({ error: 'Escreva o texto do aviso.' });
    if (texto.length > 8000) return res.status(400).json({ error: 'Texto grande demais (máx. 8.000 caracteres).' });
    const vinc = (await db.query(`
      SELECT it.ticket_id, t.basestatus FROM public.incidente_ticket it LEFT JOIN silver.ticket t ON t.ticket_id::bigint = it.ticket_id
       WHERE it.incidente_id = $1 ORDER BY it.ticket_id`, [id])).rows;
    const pedidos = listaTickets(req.body?.ticketIds);
    let alvo = vinc.filter((v) => !pedidos.length || pedidos.includes(Number(v.ticket_id)));
    if (!pedidos.length) alvo = alvo.filter((v) => !v.basestatus || ['New', 'InAttendance', 'Stopped', 'InProgress'].includes(v.basestatus));   // padrão: só os abertos
    if (!alvo.length) return res.status(400).json({ error: 'Nenhum chamado aberto para avisar.' });
    if (alvo.length > 50) return res.status(400).json({ error: 'Máximo de 50 chamados por envio. Selecione menos chamados.' });
    const agente = await agenteDoUsuario(req.user.email);
    if (!agente) return res.status(403).json({ error: `Não achei um agente ativo no Movidesk com o e-mail ${req.user.email}. O aviso é enviado em nome de quem está logado.` });
    const corpo = tipo === 'interna' && req.body?.modelo !== 'vinculo' ? `[${codigoDe(inc.id)}] ${texto}` : texto;
    const ok = [], falhas = [];
    const fila = [...alvo];
    const trabalhador = async () => {
      while (fila.length) {
        const v = fila.shift(); const tid = Number(v.ticket_id);
        try {
          await movidesk('PATCH', '/tickets', { query: { id: tid }, body: { actions: [{ type: ACAO_TIPO[tipo], origin: ACAO_ORIGEM, description: corpo, createdBy: { id: agente.id } }] } });
          ok.push(tid);
        } catch (e) { falhas.push({ id: tid, motivo: limitar(e instanceof MovideskError ? e.message : (e.message || 'erro'), 160) }); }
      }
    };
    await Promise.all([trabalhador(), trabalhador(), trabalhador()]);
    await evento(id, req, 'movidesk', `Aviso ${tipo === 'publica' ? 'PÚBLICO (ao cliente)' : 'interno'} enviado ao Movidesk em ${ok.length} de ${alvo.length} chamado(s)${falhas.length ? `; falhou em ${falhas.map((f) => '#' + f.id).join(', ')}` : ''}: ${limitar(texto, 300)}`);
    res.status(falhas.length && !ok.length ? 502 : 200).json({ ok: ok.sort((a, b) => a - b), falhas, total: alvo.length });
  } catch (e) { erro(res, e); }
});

// ── 3. pós-incidente ────────────────────────────────────────────────────────
const linhas = (v, n, t) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => limitar(String(x).trim(), t)).filter(Boolean).slice(0, n);
function normalizarPm(b) {
  return {
    resumo: limitar(String(b.resumo || '').trim(), 3000), impacto: limitar(String(b.impacto || '').trim(), 2000),
    causa_raiz: limitar(String(b.causa_raiz ?? b.causaRaiz ?? '').trim(), 3000),
    porques: linhas(b.porques, 7, 400),
    o_que_funcionou: limitar(String(b.o_que_funcionou ?? b.oQueFuncionou ?? '').trim(), 3000),
    o_que_melhorar: limitar(String(b.o_que_melhorar ?? b.oQueMelhorar ?? '').trim(), 3000),
    acoes: (Array.isArray(b.acoes) ? b.acoes : []).slice(0, 20).map((a) => ({
      texto: limitar(String(a.texto || '').trim(), 400), responsavel: limitar(String(a.responsavel || '').trim(), 80),
      prazo: /^\d{4}-\d{2}-\d{2}$/.test(String(a.prazo || '')) ? a.prazo : '', feito: !!a.feito })).filter((a) => a.texto),
  };
}
const pmDoBanco = (r) => ({ resumo: r.resumo || '', impacto: r.impacto || '', causaRaiz: r.causa_raiz || '', porques: r.porques || [], oQueFuncionou: r.o_que_funcionou || '',
  oQueMelhorar: r.o_que_melhorar || '', acoes: r.acoes || [], status: r.status, atualizadoEm: r.atualizado_em, publicadoEm: r.publicado_em });

// incidentes que exigem pós-incidente (graves ou P1/P2, já resolvidos) e ainda não têm o documento publicado
router.get('/posmortem/pendentes', requireLeitura, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT i.id, i.titulo, i.prioridade, i.grave, i.resolvido_em FROM public.incidente i
       LEFT JOIN public.incidente_posmortem p ON p.incidente_id = i.id
       WHERE i.status IN ('resolvido','fechado') AND (i.grave OR i.prioridade <= 2) AND COALESCE(p.status,'') <> 'publicado'
       ORDER BY i.resolvido_em DESC NULLS LAST LIMIT 100`);
    res.json({ total: r.rows.length, incidentes: r.rows.map((x) => ({ ...x, codigo: codigoDe(x.id) })) });
  } catch (e) { erro(res, e); }
});

router.get('/:id/posmortem', requireLeitura, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  try {
    const inc = (await db.query(`SELECT * FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!inc) return res.status(404).json({ error: 'Incidente não encontrado' });
    const r = (await db.query(`SELECT * FROM public.incidente_posmortem WHERE incidente_id = $1`, [id])).rows[0];
    const doc = r ? pmDoBanco(r) : { resumo: '', impacto: '', causaRaiz: inc.causa || '', porques: [], oQueFuncionou: '', oQueMelhorar: '', acoes: [], status: 'novo', atualizadoEm: null, publicadoEm: null };
    res.json({ posmortem: doc, obrigatorio: !!(inc.grave || inc.prioridade <= 2), incidenteStatus: inc.status });
  } catch (e) { erro(res, e); }
});

router.put('/:id/posmortem', requireLeitura, exigirEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  const publicar = req.body?.publicar === true;
  const d = normalizarPm(req.body || {});
  try {
    const inc = (await db.query(`SELECT * FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!inc) return res.status(404).json({ error: 'Incidente não encontrado' });
    if (publicar) {
      if (!['resolvido', 'fechado'].includes(inc.status)) return res.status(409).json({ error: 'Publique o pós-incidente depois de resolver o incidente.' });
      if (!d.resumo || !d.causa_raiz) return res.status(400).json({ error: 'Para publicar, preencha ao menos o resumo e a causa raiz.' });
      if (!d.acoes.length) return res.status(400).json({ error: 'Para publicar, registre ao menos uma ação corretiva ou preventiva.' });
    }
    const atual = (await db.query(`SELECT status FROM public.incidente_posmortem WHERE incidente_id = $1`, [id])).rows[0];
    const novoStatus = publicar ? 'publicado' : (atual && atual.status === 'publicado' ? 'publicado' : 'rascunho');
    await db.query(`
      INSERT INTO public.incidente_posmortem (incidente_id, resumo, impacto, causa_raiz, porques, o_que_funcionou, o_que_melhorar, acoes, status, atualizado_por, atualizado_em, publicado_em)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,NOW(), CASE WHEN $11 THEN NOW() END)
      ON CONFLICT (incidente_id) DO UPDATE SET resumo=EXCLUDED.resumo, impacto=EXCLUDED.impacto, causa_raiz=EXCLUDED.causa_raiz, porques=EXCLUDED.porques,
        o_que_funcionou=EXCLUDED.o_que_funcionou, o_que_melhorar=EXCLUDED.o_que_melhorar, acoes=EXCLUDED.acoes, status=EXCLUDED.status,
        atualizado_por=EXCLUDED.atualizado_por, atualizado_em=NOW(), publicado_em=CASE WHEN $11 THEN NOW() ELSE public.incidente_posmortem.publicado_em END`,
      [id, d.resumo, d.impacto, d.causa_raiz, JSON.stringify(d.porques), d.o_que_funcionou, d.o_que_melhorar, JSON.stringify(d.acoes), novoStatus, req.user.id, publicar]);
    if (publicar) {
      await evento(id, req, 'posmortem', `Pós-incidente publicado. Causa raiz: ${limitar(d.causa_raiz, 200)} · ${d.acoes.length} ação(ões) registrada(s).`);
      if (d.causa_raiz && !inc.causa) await db.query(`UPDATE public.incidente SET causa = $2, atualizado_em = NOW() WHERE id = $1`, [id, d.causa_raiz]);
    }
    res.json({ ok: true, status: novoStatus });
  } catch (e) { erro(res, e); }
});

router.post('/:id/posmortem/ia', requireLeitura, exigirEscrita, H.recursoLigado('incidentePosmortem'), H.limiteIA, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  try {
    const S = await cfg.obter(), C = S.incidentePosmortem;
    const ctx = await H.contextoDoIncidente(id, S.incidenteResumo.chamadosNoContexto, S.incidenteResumo.eventosNoContexto);
    if (!ctx) return res.status(404).json({ error: 'Incidente não encontrado' });
    const system = `${REGRAS}${cfg.diretrizes(S)}
Tarefa: escrever o RASCUNHO do pós-incidente (post-mortem blameless, modelo ITIL/SRE) deste incidente.
- Sem culpados: descreva falhas de processo, sistema e comunicação; NUNCA aponte pessoas.
- resumo: 3 a 5 frases (o que houve, duração, quem foi afetado, como foi resolvido);
- impacto: clientes/chamados afetados e consequências, com números dos dados;
- causa_raiz: só se estiver sustentada pelos dados (causa, contorno e solução registrados, linha do tempo). Se não estiver, escreva "Causa raiz ainda não confirmada" e diga o que falta investigar;
- porques: até ${C.maxPorques} níveis encadeados ("por quê?") que levem à causa; lista vazia se não houver base;
- o_que_funcionou e o_que_melhorar: listas curtas, baseadas em fatos da linha do tempo (tempos de reconhecimento e resolução versus as metas, comunicação, vínculo de chamados);
- acoes: até ${C.maxAcoes} ações corretivas/preventivas concretas e verificáveis (sem responsável nem prazo: a equipe define).
Responda em JSON: {"resumo":"","impacto":"","causa_raiz":"","porques":[""],"o_que_funcionou":[""],"o_que_melhorar":[""],"acoes":[""]}${cfg.extra(C.instrucaoExtra)}`;
    const r = await chamarIA({ source: 'incidente_posmortem', system, user: dados('INCIDENTE', ctx.texto), maxTokens: 1500, temperature: cfg.temperatura(C.criatividade), userEmail: req.user.email, meta: { incidente: id } });
    const lst = (v, n, t) => linhas(v, n, t);
    res.json({
      resumo: limitar(r.resumo, 1500), impacto: limitar(r.impacto, 1000), causaRaiz: limitar(r.causa_raiz, 1500),
      porques: lst(r.porques, C.maxPorques, 300), oQueFuncionou: lst(r.o_que_funcionou, 6, 300).map((x) => '• ' + x).join('\n'),
      oQueMelhorar: lst(r.o_que_melhorar, 6, 300).map((x) => '• ' + x).join('\n'),
      acoes: lst(r.acoes, C.maxAcoes, 300).map((texto) => ({ texto, responsavel: '', prazo: '', feito: false })),
    });
  } catch (e) { H.erroIA(res, e); }
});

// ── 4. problemas (causa raiz compartilhada / erro conhecido) ───────────────
const fmtProblema = (p) => ({ ...p, codigo: codigoProblema(p.id), rotuloStatus: ROTULO_PROBLEMA[p.status] || p.status });
router.get('/problemas', requireLeitura, async (req, res) => {
  try {
    const escopo = req.query.escopo === 'todos' ? '' : `WHERE p.status <> 'resolvido'`;
    const r = await db.query(`
      SELECT p.*, u.name AS responsavel_nome, (SELECT COUNT(*) FROM public.problema_incidente x WHERE x.problema_id = p.id)::int AS n_incidentes
        FROM public.problema p LEFT JOIN users u ON u.id = p.responsavel_id ${escopo} ORDER BY p.atualizado_em DESC LIMIT 300`);
    res.json({ problemas: r.rows.map(fmtProblema), status: STATUS_PROBLEMA, rotulos: ROTULO_PROBLEMA });
  } catch (e) { erro(res, e); }
});
router.get('/problemas/:pid', requireLeitura, async (req, res) => {
  const pid = idValido(req.params.pid);
  if (!pid) return res.status(400).json({ error: 'Número inválido' });
  try {
    const p = (await db.query(`SELECT p.*, u.name AS responsavel_nome FROM public.problema p LEFT JOIN users u ON u.id = p.responsavel_id WHERE p.id = $1`, [pid])).rows[0];
    if (!p) return res.status(404).json({ error: 'Problema não encontrado' });
    const inc = (await db.query(`SELECT i.id, i.titulo, i.status, i.prioridade, i.aberto_em FROM public.problema_incidente x JOIN public.incidente i ON i.id = x.incidente_id WHERE x.problema_id = $1 ORDER BY i.aberto_em DESC`, [pid])).rows;
    res.json({ problema: fmtProblema(p), incidentes: inc.map((i) => ({ ...i, codigo: codigoDe(i.id) })) });
  } catch (e) { erro(res, e); }
});
async function vincularIncidentes(pid, ids, req) {
  const ok = [];
  for (const iid of ids) {
    const existe = (await db.query(`SELECT 1 FROM public.incidente WHERE id = $1`, [iid])).rows[0];
    if (!existe) continue;
    const r = await db.query(`INSERT INTO public.problema_incidente (problema_id, incidente_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING incidente_id`, [pid, iid]);
    if (r.rows[0]) { ok.push(iid); await evento(iid, req, 'problema', `Ligado ao problema ${codigoProblema(pid)}.`); }
  }
  return ok;
}
router.post('/problemas', requireLeitura, exigirEscrita, async (req, res) => {
  const b = req.body || {}; const titulo = String(b.titulo || '').trim();
  if (titulo.length < 5) return res.status(400).json({ error: 'Dê um título ao problema (mínimo 5 caracteres).' });
  const status = STATUS_PROBLEMA.includes(b.status) ? b.status : 'aberto';
  if (status === 'erro_conhecido' && !String(b.contorno || '').trim()) return res.status(400).json({ error: 'Um erro conhecido precisa de um contorno (workaround) registrado.' });
  if (status === 'resolvido' && !String(b.causaRaiz || '').trim()) return res.status(400).json({ error: 'Para resolver o problema, registre a causa raiz.' });
  try {
    const r = await db.query(`INSERT INTO public.problema (titulo, descricao, causa_raiz, contorno, status, responsavel_id, criado_por, resolvido_em) VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $5 = 'resolvido' THEN NOW() END) RETURNING *`,
      [limitar(titulo, 200), limitar(b.descricao || '', 3000) || null, limitar(b.causaRaiz || '', 3000) || null, limitar(b.contorno || '', 3000) || null, status, idValido(b.responsavelId), req.user.id]);
    const ids = [...new Set((Array.isArray(b.incidenteIds) ? b.incidenteIds : []).map(idValido).filter(Boolean))];
    await vincularIncidentes(r.rows[0].id, ids, req);
    res.status(201).json({ problema: fmtProblema(r.rows[0]) });
  } catch (e) { erro(res, e); }
});
router.patch('/problemas/:pid', requireLeitura, exigirEscrita, async (req, res) => {
  const pid = idValido(req.params.pid);
  if (!pid) return res.status(400).json({ error: 'Número inválido' });
  const b = req.body || {};
  try {
    const atual = (await db.query(`SELECT * FROM public.problema WHERE id = $1`, [pid])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Problema não encontrado' });
    const status = STATUS_PROBLEMA.includes(b.status) ? b.status : atual.status;
    const causa = b.causaRaiz !== undefined ? limitar(b.causaRaiz, 3000) : atual.causa_raiz;
    const contorno = b.contorno !== undefined ? limitar(b.contorno, 3000) : atual.contorno;
    if (status === 'erro_conhecido' && !String(contorno || '').trim()) return res.status(400).json({ error: 'Um erro conhecido precisa de um contorno (workaround) registrado.' });
    if (status === 'resolvido' && !String(causa || '').trim()) return res.status(400).json({ error: 'Para resolver o problema, registre a causa raiz.' });
    const r = await db.query(`
      UPDATE public.problema SET titulo=$2, descricao=$3, causa_raiz=$4, contorno=$5, status=$6, responsavel_id=$7, atualizado_em=NOW(),
             resolvido_em = CASE WHEN $6 = 'resolvido' THEN COALESCE(resolvido_em, NOW()) ELSE NULL END WHERE id=$1 RETURNING *`,
      [pid, b.titulo ? limitar(String(b.titulo).trim(), 200) : atual.titulo, b.descricao !== undefined ? limitar(b.descricao, 3000) : atual.descricao, causa || null, contorno || null, status,
        b.responsavelId !== undefined ? idValido(b.responsavelId) : atual.responsavel_id]);
    res.json({ problema: fmtProblema(r.rows[0]) });
  } catch (e) { erro(res, e); }
});
router.post('/problemas/:pid/incidentes', requireLeitura, exigirEscrita, async (req, res) => {
  const pid = idValido(req.params.pid);
  if (!pid) return res.status(400).json({ error: 'Número inválido' });
  try {
    if (!(await db.query(`SELECT 1 FROM public.problema WHERE id = $1`, [pid])).rows[0]) return res.status(404).json({ error: 'Problema não encontrado' });
    const ids = [...new Set((Array.isArray(req.body?.incidenteIds) ? req.body.incidenteIds : [req.body?.incidenteId]).map(idValido).filter(Boolean))];
    res.json({ ok: true, vinculados: await vincularIncidentes(pid, ids, req) });
  } catch (e) { erro(res, e); }
});
router.delete('/problemas/:pid/incidentes/:iid', requireLeitura, exigirEscrita, async (req, res) => {
  const pid = idValido(req.params.pid), iid = idValido(req.params.iid);
  if (!pid || !iid) return res.status(400).json({ error: 'Número inválido' });
  try {
    const r = await db.query(`DELETE FROM public.problema_incidente WHERE problema_id = $1 AND incidente_id = $2 RETURNING 1`, [pid, iid]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Esse incidente não está ligado ao problema.' });
    await evento(iid, req, 'problema', `Desligado do problema ${codigoProblema(pid)}.`);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});
// problemas ligados a um incidente (para a gaveta)
router.get('/:id/problemas', requireLeitura, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  try {
    const r = await db.query(`SELECT p.* FROM public.problema_incidente x JOIN public.problema p ON p.id = x.problema_id WHERE x.incidente_id = $1 ORDER BY p.id`, [id]);
    res.json({ problemas: r.rows.map(fmtProblema) });
  } catch (e) { erro(res, e); }
});

module.exports = router;
