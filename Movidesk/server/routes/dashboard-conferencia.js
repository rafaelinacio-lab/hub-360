'use strict';
// Conferência do Dashboard com o Movidesk: compara, ao vivo, os chamados que o painel está mostrando
// com o status real no Movidesk. Corrige o banco (silver.ticket) só quando a pessoa pede ("aplicar").
// Serve para pegar chamados encerrados no Movidesk que o cron (que só traz chamados abertos) nunca
// mais viu e que, por isso, continuam "abertos" no banco.
const express = require('express');
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const { movidesk, escopoEquipe } = require('../utils/movideskPeople');
const tickets = require('./tickets');

const router = express.Router();
router.use(authMiddleware);

const ATIVOS = ['New', 'InAttendance', 'Stopped', 'InProgress'];
const ROLES = ['admin', 'supervisor', 'atendente'];
const limite = rateLimit({ name: 'dashboard/conferencia', windowMs: 10 * 60 * 1000, max: 8 });

router.post('/', limite, async (req, res) => {
  try {
    const papel = (await db.query(`SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user.id])).rows[0]?.name;
    if (!ROLES.includes(papel)) return res.status(403).json({ error: 'Seu perfil não pode conferir chamados.' });
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((x) => Number(String(x).replace(/\D/g, ''))).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ error: 'Nenhum chamado para conferir.' });
    if (ids.length > 300) return res.status(400).json({ error: 'Máximo de 300 chamados por conferência.' });
    const aplicar = req.body?.aplicar === true;

    const banco = new Map((await db.query(
      `SELECT ticket_id::bigint AS id, subject, status, basestatus, ownerteam FROM silver.ticket WHERE ticket_id::bigint = ANY($1::bigint[])`, [ids])).rows.map((r) => [Number(r.id), r]));
    const divergencias = [], falhas = [];
    const fila = [...ids];
    const trabalhar = async () => {
      while (fila.length) {
        const id = fila.shift(); const b = banco.get(id);
        try {
          const t = await movidesk('GET', '/tickets', { query: { id, $select: 'id,status,baseStatus,ownerTeam,lastUpdate' } });
          if (!t || !t.id) { divergencias.push({ id, assunto: b?.subject, motivo: 'nao_encontrado', banco: { status: b?.status, base: b?.basestatus }, movidesk: null }); continue; }
          const mudouStatus = String(t.status || '') !== String(b?.status || '') || String(t.baseStatus || '') !== String(b?.basestatus || '');
          const mudouEquipe = String(t.ownerTeam || '') !== String(b?.ownerteam || '');
          if (!mudouStatus && !mudouEquipe) continue;
          divergencias.push({
            id, assunto: b?.subject, motivo: ATIVOS.includes(t.baseStatus) ? (mudouStatus ? 'status' : 'equipe') : 'encerrado',
            banco: { status: b?.status, base: b?.basestatus, equipe: b?.ownerteam }, movidesk: { status: t.status, base: t.baseStatus, equipe: t.ownerTeam, lastUpdate: t.lastUpdate },
          });
        } catch (e) { falhas.push({ id, motivo: String(e.message || e).slice(0, 140) }); }
      }
    };
    await Promise.all([trabalhar(), trabalhar(), trabalhar(), trabalhar()]);

    // Direção inversa: chamados abertos da equipe NO MOVIDESK que o painel não está mostrando — e por quê.
    let faltando = [], resumo = null;
    try {
      const esc = await escopoEquipe(req.user, false);
      const alvo = esc.filtrar && esc.equipes[0] ? String(esc.equipes[0]).trim().toLowerCase() : null;
      if (alvo) {
        const nomes = (await db.query(`SELECT DISTINCT ownerteam FROM silver.ticket WHERE lower(ownerteam) LIKE '%' || $1 || '%' AND ownerteam IS NOT NULL LIMIT 10`, [alvo])).rows.map((r) => r.ownerteam);
        const vivos = [];
        for (const nome of nomes) {
          for (let skip = 0; skip < 600; skip += 100) {
            const lote = await movidesk('GET', '/tickets', { query: {
              $select: 'id,subject,status,baseStatus,ownerTeam',
              $filter: `ownerTeam eq '${nome.replace(/'/g, "''")}' and baseStatus ne 'Resolved' and baseStatus ne 'Closed' and baseStatus ne 'Canceled'`,
              $orderby: 'id asc', $top: 100, $skip: skip } });
            const arr = Array.isArray(lote) ? lote : [];
            vivos.push(...arr);
            if (arr.length < 100) break;
          }
        }
        const noPainel = new Set(ids.map(Number));
        const ausentes = vivos.filter((t) => ATIVOS.includes(t.baseStatus) && !noPainel.has(Number(t.id)));
        if (ausentes.length) {
          const dbRows = new Map((await db.query(`
            SELECT t.ticket_id::bigint AS id, t.status, t.basestatus,
                   (SELECT string_agg(DISTINCT cf.valor_texto, ', ') FROM silver.ticket_campo_customizado cf WHERE cf.ticket_id = t.ticket_id::bigint AND cf.custom_field_id::text = '23946') AS classificacao
              FROM silver.ticket t WHERE t.ticket_id::bigint = ANY($1::bigint[])`, [ausentes.map((t) => Number(t.id))])).rows.map((r) => [Number(r.id), r]));
          faltando = ausentes.map((t) => {
            const b = dbRows.get(Number(t.id));
            let motivo = 'nao_carregado';                                   // o cron ainda não trouxe para o banco
            if (b) motivo = !b.classificacao ? 'sem_classificacao' : (!/suporte t[eé]cnico/i.test(b.classificacao) ? 'outra_classificacao' : (!ATIVOS.includes(b.basestatus) ? 'status_antigo' : 'outro'));
            return { id: Number(t.id), assunto: t.subject, status: t.status, motivo, classificacao: b ? b.classificacao : null, statusBanco: b ? b.status : null };
          });
        }
        const contar = (arr, f) => arr.reduce((m, x) => { const k = f(x) || '—'; m[k] = (m[k] || 0) + 1; return m; }, {});
        resumo = {
          movidesk: { total: vivos.filter((t) => ATIVOS.includes(t.baseStatus)).length, porStatus: contar(vivos.filter((t) => ATIVOS.includes(t.baseStatus)), (t) => t.status) },
          painel: { total: ids.length, porStatus: contar([...banco.values()], (r) => r.status) },
          equipe: nomes.join(' · '),
        };
      }
    } catch (e) { console.warn('[conferencia] não consegui listar os chamados da equipe no Movidesk:', e.message); }

    let aplicados = 0;
    if (aplicar) {
      for (const d of divergencias) {
        if (!d.movidesk) continue;
        await db.query(`UPDATE silver.ticket SET status = $2, basestatus = $3, ownerteam = $4, last_update = COALESCE($5::timestamptz, last_update) WHERE ticket_id::bigint = $1`,
          [d.id, d.movidesk.status, d.movidesk.base, d.movidesk.equipe || null, d.movidesk.lastUpdate || null]);
        aplicados++;
      }
      if (aplicados && tickets.limparCache) tickets.limparCache();
      console.log(`[conferencia] ${req.user.email} corrigiu ${aplicados} chamado(s) no banco a partir do Movidesk.`);
    }
    res.json({ verificados: ids.length - falhas.length, falhas, divergencias: divergencias.sort((a, b) => a.id - b.id), aplicados, faltando, resumo });
  } catch (e) {
    console.error('[conferencia]', e);
    res.status(500).json({ error: e.message || 'Erro ao conferir com o Movidesk' });
  }
});

module.exports = router;
