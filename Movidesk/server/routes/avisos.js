'use strict';
// Avisos automáticos (Configurações → Avisos automáticos). Somente admin.
//  GET  /avisos            — estado geral, regras, variáveis e resumo recente
//  PUT  /avisos/geral      — liga/desliga o módulo e o intervalo
//  POST /avisos/regras     — cria regra · PUT /avisos/regras/:id — edita · DELETE /avisos/regras/:id
//  GET  /avisos/historico  — últimos avisos (enviados, simulados, erros)
//  GET  /avisos/servicos   — serviços existentes (para escolher na regra) · GET /avisos/agentes — remetentes possíveis
//  POST /avisos/previa     — mostra a mensagem montada com dados de exemplo
const express = require('express');
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const av = require('../utils/avisosAutomaticos');

const router = express.Router();
router.use(authMiddleware, requireRole('admin'));

const txt = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '');
function lerRegra(b) {
  const servicos = [...new Set((Array.isArray(b.servicos) ? b.servicos : []).map((s) => txt(s, 300)).filter(Boolean))].slice(0, 50);
  const regra = {
    nome: txt(b.nome, 120),
    ativo: b.ativo === true,
    modo: b.modo === 'ativo' ? 'ativo' : 'simulacao',
    servicos,
    tipo_acao: b.tipo_acao === 'interna' ? 'interna' : 'publica',
    mensagem: txt(b.mensagem, 5000),
    agente_id: txt(String(b.agente_id ?? ''), 40) || null,
    agente_nome: txt(b.agente_nome, 200) || null,
  };
  if (!regra.nome) return { erro: 'Dê um nome à regra.' };
  if (!regra.servicos.length) return { erro: 'Escolha ao menos um serviço.' };
  if (!regra.mensagem) return { erro: 'Escreva a mensagem.' };
  if (regra.modo === 'ativo' && !regra.agente_id) return { erro: 'Para enviar de verdade, escolha o agente remetente do Movidesk.' };
  return { regra };
}

router.get('/', async (req, res) => {
  try {
    await av.garantirTabelas();
    const [estado, regras, resumo] = await Promise.all([
      av.lerEstado(),
      db.query(`SELECT * FROM public.aviso_regra ORDER BY id`),
      db.query(`SELECT status, COUNT(*)::int AS n FROM public.aviso_envio WHERE criado_em > NOW() - INTERVAL '7 days' GROUP BY 1`),
    ]);
    res.json({ estado, regras: regras.rows, variaveis: av.VARIAVEIS, resumo7d: Object.fromEntries(resumo.rows.map((r) => [r.status, r.n])) });
  } catch (e) { console.error('[avisos] get:', e.message); res.status(500).json({ error: 'Erro ao carregar os avisos automáticos' }); }
});

router.put('/geral', async (req, res) => {
  try {
    const parcial = {};
    if (typeof req.body?.ligado === 'boolean') {
      parcial.ligado = req.body.ligado;
      if (req.body.ligado) parcial.vigia = new Date().toISOString();   // ao ligar, só vale para chamados criados daqui para frente
    }
    if (req.body?.intervaloSeg != null) parcial.intervaloSeg = Math.min(600, Math.max(30, Math.round(Number(req.body.intervaloSeg)) || 120));
    res.json({ estado: await av.gravarEstado(parcial) });
  } catch (e) { res.status(500).json({ error: 'Erro ao salvar' }); }
});

router.post('/regras', async (req, res) => {
  const { regra, erro } = lerRegra(req.body || {});
  if (erro) return res.status(400).json({ error: erro });
  try {
    await av.garantirTabelas();
    const r = await db.query(
      `INSERT INTO public.aviso_regra (nome, ativo, modo, servicos, tipo_acao, mensagem, agente_id, agente_nome, criado_por)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING *`,
      [regra.nome, regra.ativo, regra.modo, JSON.stringify(regra.servicos), regra.tipo_acao, regra.mensagem, regra.agente_id, regra.agente_nome, req.user.email || null]);
    res.json({ regra: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Erro ao criar a regra' }); }
});

router.put('/regras/:id(\\d+)', async (req, res) => {
  const { regra, erro } = lerRegra(req.body || {});
  if (erro) return res.status(400).json({ error: erro });
  try {
    const r = await db.query(
      `UPDATE public.aviso_regra SET nome=$2, ativo=$3, modo=$4, servicos=$5::jsonb, tipo_acao=$6, mensagem=$7, agente_id=$8, agente_nome=$9, atualizado_em=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, regra.nome, regra.ativo, regra.modo, JSON.stringify(regra.servicos), regra.tipo_acao, regra.mensagem, regra.agente_id, regra.agente_nome]);
    if (!r.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ regra: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Erro ao salvar a regra' }); }
});

router.delete('/regras/:id(\\d+)', async (req, res) => {
  try { await db.query(`DELETE FROM public.aviso_regra WHERE id = $1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Erro ao excluir a regra' }); }
});

router.get('/historico', async (req, res) => {
  try {
    await av.garantirTabelas();
    const r = await db.query(
      `SELECT id, regra_id, regra_nome, ticket_id, assunto, servico, status, modo, tentativas, erro, criado_em FROM public.aviso_envio ORDER BY id DESC LIMIT 200`);
    res.json({ itens: r.rows });
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar o histórico' }); }
});

router.get('/servicos', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT service_full AS servico, COUNT(*)::int AS n FROM silver.ticket
        WHERE service_full IS NOT NULL AND service_full <> '' AND createddate >= NOW() - INTERVAL '12 months'
        GROUP BY 1 ORDER BY 1 LIMIT 1500`);
    // inclui também os níveis acima (ex.: "Agronegócio" cobre todo o ramo)
    const mapa = new Map();
    for (const x of r.rows) {
      const partes = x.servico.split(' > ');
      for (let i = 1; i <= partes.length; i++) { const k = partes.slice(0, i).join(' > '); mapa.set(k, (mapa.get(k) || 0) + x.n); }
    }
    res.json({ servicos: [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([servico, n]) => ({ servico, n })) });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar os serviços' }); }
});

router.get('/agentes', async (req, res) => {
  try { res.json({ agentes: (await av.listaAgentes()).map((a) => ({ id: a.id, nome: a.nome })) }); }
  catch (e) { res.status(502).json({ error: 'Não consegui listar os agentes do Movidesk: ' + e.message }); }
});

router.post('/previa', (req, res) => {
  const t = { id: '123456', subject: 'Erro ao emitir nota fiscal', servico: txt(req.body?.servico, 300) || 'Agronegócio > Agrotitan', urgency: 'Alta', ownerTeam: 'Agrotitan - Suporte Técnico' };
  res.json({ texto: av.montarMensagem(txt(req.body?.mensagem, 5000), t) });
});

module.exports = router;
