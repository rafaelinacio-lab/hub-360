'use strict';
// Pedidos para tirar chamados do cálculo de SLA (suporte pede; Sistemas Internos/admin aprova). Ver utils/slaExclusao.js.
//  GET  /sla-exclusoes/me                 — o que o usuário pode fazer + motivos
//  GET  /sla-exclusoes?status=&q=         — lista (aprovador vê todos; os demais, só os próprios)
//  GET  /sla-exclusoes/por-chamado/:id    — situação do chamado (pedido ativo, se houver)
//  POST /sla-exclusoes                    — { tickets: [..] | ticket, motivo, obs } cria pedidos (aprovador: já entram aprovados)
//  POST /sla-exclusoes/:id/decidir        — { acao: 'aprovar'|'recusar', obs } (só aprovador)
//  POST /sla-exclusoes/:id/cancelar       — quem pediu cancela o pendente; aprovador também reverte um aprovado
const express = require('express');
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const ex = require('../utils/slaExclusao');

const router = express.Router();
router.use(authMiddleware);
const limite = rateLimit({ name: 'sla-exclusoes', windowMs: 10 * 60 * 1000, max: 120 });
const txt = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '');

async function eu(req, res) {
  await ex.garantirTabela();
  const u = await ex.quemE(req.user.id);
  if (!u) { res.status(401).json({ error: 'Usuário não encontrado' }); return null; }
  return u;
}

router.get('/me', async (req, res) => {
  try { const u = await eu(req, res); if (u) res.json({ pede: u.pede, aprova: u.aprova, motivos: ex.MOTIVOS }); }
  catch (e) { console.error('[sla-exclusoes] me:', e.message); res.status(500).json({ error: 'Erro ao carregar' }); }
});

router.get('/por-chamado/:id', async (req, res) => {
  try {
    const u = await eu(req, res); if (!u) return;
    const id = Number(req.params.id); if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Chamado inválido' });
    const r = await db.query(`SELECT id, status, motivo, obs, solicitado_por_nome, solicitado_em, decidido_por_nome, decidido_em, decisao_obs
        FROM public.sla_exclusao WHERE ticket_id = $1 AND status IN ('pendente','aprovado') LIMIT 1`, [id]);
    res.json({ pedido: r.rows[0] || null, pede: u.pede, aprova: u.aprova, motivos: ex.MOTIVOS });
  } catch (e) { console.error('[sla-exclusoes] por-chamado:', e.message); res.status(500).json({ error: 'Erro ao carregar' }); }
});

router.get('/', async (req, res) => {
  try {
    const u = await eu(req, res); if (!u) return;
    if (!u.pede) return res.status(403).json({ error: 'Sem permissão' });
    const status = ['pendente', 'aprovado', 'recusado', 'cancelado', 'revertido'].includes(req.query.status) ? req.query.status : null;
    const q = txt(String(req.query.q || ''), 80);
    const params = []; const w = [];
    if (!u.aprova) { params.push(u.id); w.push(`e.solicitado_por_id = $${params.length}`); }
    if (status) { params.push(status); w.push(`e.status = $${params.length}`); }
    if (q) { params.push(`%${q}%`); w.push(`(e.ticket_id::text LIKE $${params.length} OR e.solicitado_por_nome ILIKE $${params.length} OR t.subject ILIKE $${params.length})`); }
    const r = await db.query(`
      SELECT e.id, e.ticket_id::text AS ticket_id, e.motivo, e.obs, e.status, e.solicitado_por_nome, e.solicitado_em, e.decidido_por_nome, e.decidido_em, e.decisao_obs,
             t.subject AS assunto, t.ownerteam AS equipe, t.owner_name AS responsavel
        FROM public.sla_exclusao e LEFT JOIN silver.ticket t ON t.ticket_id = e.ticket_id
       ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
       ORDER BY (e.status = 'pendente') DESC, e.solicitado_em DESC LIMIT 500`, params);
    const cont = (await db.query(`SELECT status, COUNT(*)::int n FROM public.sla_exclusao ${u.aprova ? '' : 'WHERE solicitado_por_id = $1'} GROUP BY 1`, u.aprova ? [] : [u.id])).rows;
    res.json({ itens: r.rows, contagem: Object.fromEntries(cont.map((x) => [x.status, x.n])), aprova: u.aprova, motivos: ex.MOTIVOS });
  } catch (e) { console.error('[sla-exclusoes] lista:', e.message); res.status(500).json({ error: 'Erro ao listar' }); }
});

router.post('/', limite, async (req, res) => {
  try {
    const u = await eu(req, res); if (!u) return;
    if (!u.pede) return res.status(403).json({ error: 'Seu perfil não pode pedir exclusão do SLA.' });
    const motivo = String(req.body?.motivo || ''), obs = txt(req.body?.obs, 500);
    if (!ex.MOTIVOS[motivo]) return res.status(400).json({ error: 'Escolha o motivo.' });
    if (motivo === 'outro' && obs.length < 5) return res.status(400).json({ error: 'No motivo "Outro", descreva na observação.' });
    const tk = req.body?.tickets;
    const lista = Array.isArray(tk) ? tk : (typeof tk === 'string' ? [tk] : [req.body?.ticket]);   // texto colado (vários números) ou lista
    const ids = [...new Set(lista.flatMap((x) => String(x == null ? '' : x).split(/[\s,;]+/)).map((x) => x.replace(/^#/, '')).filter((x) => /^\d{1,18}$/.test(x)))];
    if (!ids.length) return res.status(400).json({ error: 'Informe ao menos um número de chamado.' });
    if (ids.length > 200) return res.status(400).json({ error: 'No máximo 200 chamados por pedido.' });
    const existentes = new Set((await db.query(`SELECT ticket_id::text AS id FROM silver.ticket WHERE ticket_id = ANY($1::bigint[])`, [ids])).rows.map((x) => x.id));
    const ativos = new Map((await db.query(`SELECT ticket_id::text AS id, status FROM public.sla_exclusao WHERE ticket_id = ANY($1::bigint[]) AND status IN ('pendente','aprovado')`, [ids])).rows.map((x) => [x.id, x.status]));
    const criados = [], ignorados = [];
    for (const id of ids) {
      if (!existentes.has(id)) { ignorados.push({ ticket: id, motivo: 'chamado não encontrado' }); continue; }
      if (ativos.has(id)) { ignorados.push({ ticket: id, motivo: ativos.get(id) === 'aprovado' ? 'já está fora do SLA' : 'já tem pedido pendente' }); continue; }
      const direto = u.aprova;   // quem aprova (Sistemas Internos/admin) já entra aprovado, com o registro de quem fez
      try {
        await db.query(`INSERT INTO public.sla_exclusao (ticket_id, motivo, obs, status, solicitado_por_id, solicitado_por_nome, solicitado_por_email, decidido_por_nome, decidido_em)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, motivo, obs || null, direto ? 'aprovado' : 'pendente', u.id, u.nome, u.email, direto ? u.nome : null, direto ? new Date() : null]);
        criados.push(id);
      } catch (e) { if (e.code === '23505') ignorados.push({ ticket: id, motivo: 'já tem pedido ativo' }); else throw e; }
    }
    res.json({ ok: true, criados, ignorados, aprovadosNaHora: u.aprova });
  } catch (e) { console.error('[sla-exclusoes] criar:', e.message); res.status(500).json({ error: 'Erro ao registrar o pedido' }); }
});

router.post('/:id/decidir', limite, async (req, res) => {
  try {
    const u = await eu(req, res); if (!u) return;
    if (!u.aprova) return res.status(403).json({ error: 'Só Sistemas Internos (ou admin) aprova ou recusa.' });
    const id = Number(req.params.id), acao = req.body?.acao, obs = txt(req.body?.obs, 500);
    if (!Number.isInteger(id) || !['aprovar', 'recusar'].includes(acao)) return res.status(400).json({ error: 'Pedido ou ação inválidos' });
    if (acao === 'recusar' && obs.length < 3) return res.status(400).json({ error: 'Informe o motivo da recusa.' });
    const r = await db.query(`UPDATE public.sla_exclusao SET status = $2, decidido_por_nome = $3, decidido_em = NOW(), decisao_obs = $4 WHERE id = $1 AND status = 'pendente' RETURNING id`,
      [id, acao === 'aprovar' ? 'aprovado' : 'recusado', u.nome, obs || null]);
    if (!r.rows.length) return res.status(409).json({ error: 'Este pedido não está mais pendente.' });
    res.json({ ok: true });
  } catch (e) { console.error('[sla-exclusoes] decidir:', e.message); res.status(500).json({ error: 'Erro ao decidir' }); }
});

router.post('/:id/cancelar', limite, async (req, res) => {
  try {
    const u = await eu(req, res); if (!u) return;
    const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ error: 'Pedido inválido' });
    const p = (await db.query(`SELECT status, solicitado_por_id FROM public.sla_exclusao WHERE id = $1`, [id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (p.status === 'pendente' && (p.solicitado_por_id === u.id || u.aprova)) {
      await db.query(`UPDATE public.sla_exclusao SET status = 'cancelado', decidido_por_nome = $2, decidido_em = NOW() WHERE id = $1 AND status = 'pendente'`, [id, u.nome]);
      return res.json({ ok: true });
    }
    if (p.status === 'aprovado' && u.aprova) {   // "Voltar ao SLA": só quem aprova reverte; o histórico fica
      await db.query(`UPDATE public.sla_exclusao SET status = 'revertido', decidido_por_nome = $2, decidido_em = NOW(), decisao_obs = COALESCE($3, decisao_obs) WHERE id = $1 AND status = 'aprovado'`, [id, u.nome, txt(req.body?.obs, 500) || null]);
      return res.json({ ok: true });
    }
    res.status(403).json({ error: 'Você não pode alterar este pedido.' });
  } catch (e) { console.error('[sla-exclusoes] cancelar:', e.message); res.status(500).json({ error: 'Erro ao cancelar' }); }
});

module.exports = router;
