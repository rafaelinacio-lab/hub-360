'use strict';
// Conferência do Dashboard com o Movidesk: compara, ao vivo, os chamados que o painel está mostrando
// com o status real no Movidesk. Corrige o banco (silver.ticket) só quando a pessoa pede ("aplicar").
// Serve para pegar chamados encerrados no Movidesk que o cron (que só traz chamados abertos) nunca
// mais viu e que, por isso, continuam "abertos" no banco.
const express = require('express');
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const { movidesk } = require('../utils/movideskPeople');
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
    res.json({ verificados: ids.length - falhas.length, falhas, divergencias: divergencias.sort((a, b) => a.id - b.id), aplicados });
  } catch (e) {
    console.error('[conferencia]', e);
    res.status(500).json({ error: e.message || 'Erro ao conferir com o Movidesk' });
  }
});

module.exports = router;
