'use strict';
// Automações (Configurações → Automações). Somente admin; o webhook é público, protegido por um código secreto longo na URL.
//  GET  /automacoes                 — estado geral, regras (com o endereço do webhook) e resumo dos últimos 7 dias
//  PUT  /automacoes/geral           — liga/desliga o módulo
//  POST /automacoes/regras · PUT /regras/:id · DELETE /regras/:id · POST /regras/:id/token (gera outro código de webhook)
//  POST /automacoes/regras/:id/testar    — roda a análise num chamado SEM gravar nada (mostra a nota e se as condições casam)
//  POST /automacoes/regras/:id/executar  — roda a regra num chamado (respeita o modo: simulação grava só no histórico)
//  GET  /automacoes/historico · /agentes · /servicos · /classificacoes · /equipes · /urgencias
//  POST /api/webhooks/automacao/:token   — (público) o Movidesk avisa de um chamado; resposta 202 e processamento em fila
const express = require('express');
const crypto = require('crypto');
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { listaAgentes } = require('../utils/movideskPeople');
const { analisarCliente } = require('../utils/analiseCliente');
const { rateLimit } = require('../utils/rateLimit');
const av = require('../utils/avisosAutomaticos');
const au = require('../utils/automacoes');

const router = express.Router();
const publico = express.Router();

const txt = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '');
const novoToken = () => crypto.randomBytes(24).toString('hex');
const idOk = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// ── Webhook público ─────────────────────────────────────────────────────
// 60 chamadas por minuto por código (sobra para o ritmo normal de chamados novos; barra repetição em laço).
publico.post('/automacao/:token([a-f0-9]{48})', rateLimit({ name: 'webhook-automacao', windowMs: 60 * 1000, max: 60, keyFn: (req) => 'w:' + req.params.token.slice(0, 12) }), async (req, res) => {
  try {
    await au.garantirTabelas();
    const r = await db.query(`SELECT id, ativo FROM public.automacao WHERE token = $1 AND gatilho = 'webhook'`, [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Webhook não encontrado' });
    const ticket = au.ticketDoPayload(req);
    if (!ticket) return res.status(400).json({ error: 'Não achei o número do chamado (envie "id" no corpo JSON ou ?id= na URL)' });
    if (!r.rows[0].ativo) return res.status(202).json({ ok: true, ignorado: 'regra desativada' });
    if (!au.enfileirar(r.rows[0].id, ticket)) return res.status(503).json({ error: 'Fila cheia, tente novamente em instantes' });
    res.status(202).json({ ok: true, chamado: ticket });
  } catch (e) { console.error('[automacoes] webhook:', e.message); res.status(500).json({ error: 'Erro ao receber o webhook' }); }
});

router.use(authMiddleware, requireRole('admin'));

async function urlBase(req) {
  try { const e = await av.lerEstado(); if (e.urlPublica) return String(e.urlPublica).replace(/\/+$/, ''); } catch { /* usa o host da requisição */ }
  return `${req.protocol}://${req.get('host')}`;
}
const comUrl = (base) => (r) => ({ ...r, webhookUrl: r.gatilho === 'webhook' && r.token ? `${base}/api/webhooks/automacao/${r.token}` : null, token: undefined, temToken: !!r.token });

function lerRegra(b) {
  const gatilho = b.gatilho === 'agendado' ? 'agendado' : 'webhook';
  const regra = {
    nome: txt(b.nome, 120),
    ativo: !!b.ativo,
    modo: b.modo === 'ativo' ? 'ativo' : 'simulacao',
    gatilho,
    intervalo_min: Math.min(1440, Math.max(5, Math.round(Number(b.intervalo_min) || 15))),
    condicoes: au.normalizarCondicoes(b.condicoes),
    acao: au.ACOES[b.acao] ? b.acao : 'analise_cliente',
    agente_id: txt(String(b.agente_id || ''), 40) || null,
    agente_nome: txt(String(b.agente_nome || ''), 200) || null,
    max_por_ciclo: Math.min(50, Math.max(1, Math.round(Number(b.max_por_ciclo) || 10))),
  };
  if (!regra.nome) return { erro: 'Dê um nome à automação.' };
  if (regra.modo === 'ativo' && !regra.agente_id) return { erro: 'Para gravar de verdade no Movidesk, escolha o agente em nome de quem a nota será registrada.' };
  return { regra };
}

router.get('/', async (req, res) => {
  try {
    await au.garantirTabelas();
    const [estado, regras, resumo, ia] = await Promise.all([
      au.lerEstado(),
      db.query(`SELECT * FROM public.automacao ORDER BY id`),
      db.query(`SELECT status, COUNT(*)::int AS n FROM public.automacao_execucao WHERE criado_em > NOW() - INTERVAL '7 days' GROUP BY 1`),
      require('../utils/ai').configurada().catch(() => false),
    ]);
    const base = await urlBase(req);
    res.json({
      estado, regras: regras.rows.map(comUrl(base)), acoes: au.ACOES, iaConfigurada: ia, condicoesPadrao: au.CONDICOES_PADRAO,
      resumo7d: Object.fromEntries(resumo.rows.map((x) => [x.status, x.n])),
    });
  } catch (e) { console.error('[automacoes]', e.message); res.status(500).json({ error: 'Erro ao carregar as automações' }); }
});

router.put('/geral', async (req, res) => {
  try { await au.gravarEstado({ ligado: !!req.body?.ligado }); res.json({ ok: true, estado: await au.lerEstado() }); }
  catch (e) { res.status(500).json({ error: 'Erro ao salvar' }); }
});

router.post('/regras', async (req, res) => {
  const { regra, erro } = lerRegra(req.body || {});
  if (erro) return res.status(400).json({ error: erro });
  try {
    await au.garantirTabelas();
    const r = await db.query(
      `INSERT INTO public.automacao (nome, ativo, modo, gatilho, token, intervalo_min, condicoes, acao, agente_id, agente_nome, max_por_ciclo, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12) RETURNING id`,
      [regra.nome, regra.ativo, regra.modo, regra.gatilho, regra.gatilho === 'webhook' ? novoToken() : null, regra.intervalo_min, JSON.stringify(regra.condicoes), regra.acao, regra.agente_id, regra.agente_nome, regra.max_por_ciclo, req.user.email || null]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error('[automacoes]', e.message); res.status(500).json({ error: 'Erro ao criar a automação' }); }
});

router.put('/regras/:id', async (req, res) => {
  const id = idOk(req.params.id);
  const { regra, erro } = lerRegra(req.body || {});
  if (!id) return res.status(400).json({ error: 'Automação inválida' });
  if (erro) return res.status(400).json({ error: erro });
  try {
    const atual = (await db.query(`SELECT token FROM public.automacao WHERE id = $1`, [id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Automação não encontrada' });
    const token = regra.gatilho === 'webhook' ? (atual.token || novoToken()) : null;
    await db.query(
      `UPDATE public.automacao SET nome=$2, ativo=$3, modo=$4, gatilho=$5, token=$6, intervalo_min=$7, condicoes=$8::jsonb, acao=$9, agente_id=$10, agente_nome=$11, max_por_ciclo=$12, atualizado_em=NOW() WHERE id=$1`,
      [id, regra.nome, regra.ativo, regra.modo, regra.gatilho, token, regra.intervalo_min, JSON.stringify(regra.condicoes), regra.acao, regra.agente_id, regra.agente_nome, regra.max_por_ciclo]);
    res.json({ ok: true });
  } catch (e) { console.error('[automacoes]', e.message); res.status(500).json({ error: 'Erro ao salvar a automação' }); }
});

router.delete('/regras/:id', async (req, res) => {
  const id = idOk(req.params.id);
  if (!id) return res.status(400).json({ error: 'Automação inválida' });
  try { await db.query(`DELETE FROM public.automacao WHERE id = $1`, [id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Erro ao excluir' }); }
});

router.post('/regras/:id/token', async (req, res) => {
  const id = idOk(req.params.id);
  if (!id) return res.status(400).json({ error: 'Automação inválida' });
  try {
    const r = await db.query(`UPDATE public.automacao SET token = $2, atualizado_em = NOW() WHERE id = $1 AND gatilho = 'webhook' RETURNING id`, [id, novoToken()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Automação de webhook não encontrada' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erro ao gerar o novo código' }); }
});

async function regraEChamado(req, res) {
  const id = idOk(req.params.id), ticket = idOk(req.body?.ticket);
  if (!id) { res.status(400).json({ error: 'Automação inválida' }); return null; }
  if (!ticket) { res.status(400).json({ error: 'Informe o número do chamado.' }); return null; }
  const regra = (await db.query(`SELECT * FROM public.automacao WHERE id = $1`, [id])).rows[0];
  if (!regra) { res.status(404).json({ error: 'Automação não encontrada' }); return null; }
  let t = await au.lerChamado(ticket);
  if (!t) {
    try { await require('../scripts/movidesk-loader').sincronizarTicket(ticket); } catch { /* segue: pode não existir */ }
    t = await au.lerChamado(ticket);
  }
  if (!t) { res.status(404).json({ error: `Chamado ${ticket} não encontrado.` }); return null; }
  return { regra, t };
}

const limiteIA = rateLimit({ name: 'automacoes-ia', windowMs: 10 * 60 * 1000, max: 30 });
router.post('/regras/:id/testar', limiteIA, async (req, res) => {
  try {
    const x = await regraEChamado(req, res); if (!x) return;
    const motivo = au.motivoDeNaoCasar(x.t, au.normalizarCondicoes(x.regra.condicoes), 'agendado');
    const a = await analisarCliente(Number(x.t.id), { userEmail: req.user.email });
    if (!a) return res.status(404).json({ error: 'Chamado sem informação no banco para analisar.' });
    res.json({ casa: !motivo, motivo, assunto: x.t.subject, texto: au.textoDaAnalise(a) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Erro no teste' }); }
});

router.post('/regras/:id/executar', limiteIA, async (req, res) => {
  try {
    const x = await regraEChamado(req, res); if (!x) return;
    const motivo = au.motivoDeNaoCasar(x.t, au.normalizarCondicoes(x.regra.condicoes), 'agendado');
    if (motivo) return res.status(409).json({ error: `O chamado não atende às condições: ${motivo}.` });
    const r = await au.executarNoChamado(x.regra, x.t, 'manual', { forcar: true });
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Erro ao executar' }); }
});

router.get('/historico', async (req, res) => {
  try {
    await au.garantirTabelas();
    const r = await db.query(`SELECT id, automacao_id, automacao_nome, ticket_id, origem, status, modo, assunto, texto, erro, tentativas, criado_em FROM public.automacao_execucao ORDER BY id DESC LIMIT 200`);
    res.json({ itens: r.rows });
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar o histórico' }); }
});

router.get('/agentes', async (req, res) => {
  try { res.json({ agentes: (await listaAgentes()).map((a) => ({ id: a.id, nome: a.nome, email: a.email })) }); }
  catch (e) { res.status(502).json({ error: 'Não consegui listar os agentes do Movidesk.' }); }
});
router.get('/servicos', async (req, res) => {
  try {
    const r = await db.query(`SELECT service_full AS servico, COUNT(*)::int AS n FROM silver.ticket WHERE service_full IS NOT NULL AND service_full <> '' AND createddate >= NOW() - INTERVAL '12 months' GROUP BY 1 ORDER BY 1 LIMIT 1500`);
    const mapa = new Map();
    for (const x of r.rows) { const p = x.servico.split(' > '); for (let i = 1; i <= p.length; i++) { const k = p.slice(0, i).join(' > '); mapa.set(k, (mapa.get(k) || 0) + x.n); } }
    res.json({ servicos: [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([servico, n]) => ({ servico, n })) });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar os serviços' }); }
});
router.get('/classificacoes', async (req, res) => {
  try {
    const r = await db.query(`SELECT valor_texto AS v FROM silver.ticket_campo_customizado WHERE custom_field_id = 23946 AND NULLIF(TRIM(valor_texto), '') IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 200`);
    res.json({ classificacoes: r.rows.map((x) => x.v) });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar as classificações' }); }
});
router.get('/equipes', async (req, res) => {
  try {
    const r = await db.query(`SELECT ownerteam AS v FROM silver.ticket WHERE ownerteam IS NOT NULL AND ownerteam <> '' AND createddate >= NOW() - INTERVAL '12 months' GROUP BY 1 ORDER BY 1 LIMIT 300`);
    res.json({ equipes: r.rows.map((x) => x.v) });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar as equipes' }); }
});

router.get('/urgencias', async (req, res) => {
  try {
    const r = await db.query(`SELECT urgency AS v FROM silver.ticket WHERE urgency IS NOT NULL AND urgency <> '' AND createddate >= NOW() - INTERVAL '12 months' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 30`);
    res.json({ urgencias: r.rows.map((x) => x.v) });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar as urgências' }); }
});

module.exports = router;
module.exports.publico = publico;
