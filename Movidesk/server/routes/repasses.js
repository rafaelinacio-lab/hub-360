'use strict';
// Visão de repasse de chamados entre equipes (sugestão MEL-0001).
// O Movidesk não devolve o histórico de equipe do chamado; por isso um gatilho em silver.ticket (criado pelo carregador,
// ver ensureTables em movidesk-loader.js) grava cada troca de ownerteam em silver.ticket_equipe_historico.
// Repasse = troca real de equipe (maiúsculas/espaços não contam). Só existe histórico a partir de quando o gatilho foi criado
// (mais as trocas que o log de cargas já tinha visto); chamados repassados antes disso não aparecem.
const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');
const { escopoVertical, filtrarLinhas } = require('../utils/verticalScope');

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const MAX_DIAS = 366;
const LIMITE_LISTA = 1000;

router.get('/', authMiddleware, requireTabAccess('movidesk'), async (req, res) => {
  try {
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);   // Brasília
    let ate = ymd(req.query.ate) || hoje;
    let de = ymd(req.query.de) || new Date(Date.parse(ate + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
    if (de > ate) [de, ate] = [ate, de];
    if ((Date.parse(ate) - Date.parse(de)) / 86400000 > MAX_DIAS) return res.status(400).json({ error: `Escolha um período de até ${MAX_DIAS} dias.` });
    const equipeFiltro = String(req.query.equipe || '').trim().slice(0, 120);

    const r = await db.query(`
      SELECT h.ticket_id::text AS ticket_id, h.trocado_em AS criado_em, h.de_equipe AS de, h.para_equipe AS para,
             t.subject AS assunto, t.status, t.service_full AS servico, t.ownerteam AS equipe_atual, t.clientorganization AS cliente
        FROM silver.ticket_equipe_historico h LEFT JOIN silver.ticket t ON t.ticket_id = h.ticket_id
       WHERE h.trocado_em >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND h.trocado_em <  (($2::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       ORDER BY h.trocado_em DESC`, [de, ate]);

    const esc = await escopoVertical(req.user.id);
    let linhas = filtrarLinhas(r.rows, esc, (l) => ({ servico: l.servico, equipe: l.servico ? null : l.equipe_atual }));
    const equipes = [...new Set(linhas.flatMap((l) => [l.de, l.para]))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    if (equipeFiltro) linhas = linhas.filter((l) => l.de === equipeFiltro || l.para === equipeFiltro);

    const pares = new Map(), saiu = new Map(), entrou = new Map();
    for (const l of linhas) {
      const k = l.de + '\u0000' + l.para;
      pares.set(k, (pares.get(k) || 0) + 1);
      saiu.set(l.de, (saiu.get(l.de) || 0) + 1);
      entrou.set(l.para, (entrou.get(l.para) || 0) + 1);
    }
    const ordenar = (m) => [...m].map(([equipe, total]) => ({ equipe, total })).sort((a, b) => b.total - a.total);
    res.json({
      periodo: { de, ate },
      desde: (await db.query(`SELECT MIN(trocado_em) AS m FROM silver.ticket_equipe_historico`)).rows[0]?.m || null,
      equipes,
      resumo: { repasses: linhas.length, chamados: new Set(linhas.map((l) => l.ticket_id)).size },
      pares: [...pares].map(([k, total]) => { const [de2, para] = k.split('\u0000'); return { de: de2, para, total }; }).sort((a, b) => b.total - a.total),
      origem: ordenar(saiu),
      destino: ordenar(entrou),
      chamados: linhas.slice(0, LIMITE_LISTA),
      truncado: linhas.length > LIMITE_LISTA,
    });
  } catch (e) {
    if (e.code === '42P01') return res.json({ periodo: null, desde: null, equipes: [], resumo: { repasses: 0, chamados: 0 }, pares: [], origem: [], destino: [], chamados: [], truncado: false });   // histórico ainda não criado
    console.error('[repasses]', e);
    res.status(500).json({ error: 'Erro ao montar a visão de repasses: ' + e.message });
  }
});

module.exports = router;
