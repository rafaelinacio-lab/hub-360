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
const { lerConfigEmCache } = require('../utils/slaHorasCore');
const { sqlLateralClienteFora } = require('../utils/slaRegraHub');
const { linhaDoTempo, resumoPorEquipe } = require('../utils/repassesTempo');

// Por enquanto só admin vê esta visão (também no servidor, não só na tela)
async function soAdmin(req, res, next) {
  try {
    const r = await db.query(`SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user && req.user.id]);
    if (r.rows[0] && r.rows[0].name === 'admin') return next();
    res.status(403).json({ error: 'Esta visão está disponível só para administradores por enquanto.' });
  } catch (e) { res.status(500).json({ error: 'Erro ao verificar o perfil' }); }
}

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const MAX_DIAS = 366;
const LIMITE_LISTA = 1000;

router.get('/', authMiddleware, soAdmin, requireTabAccess('movidesk'), async (req, res) => {
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

    // Tempo com cada equipe e SLA em cada repasse: linha do tempo completa dos chamados que aparecem (todos os repasses deles, não só os do período)
    const ids = [...new Set(linhas.map((l) => l.ticket_id))];
    const desde = (await db.query(`SELECT MIN(trocado_em) AS m FROM silver.ticket_equipe_historico`)).rows[0]?.m || null;
    const linhasDoTempo = new Map();
    if (ids.length) {
      const [cfg, hist, info, ac] = await Promise.all([
        lerConfigEmCache(),
        db.query(`SELECT ticket_id::text AS id, de_equipe, para_equipe, trocado_em FROM silver.ticket_equipe_historico WHERE ticket_id = ANY($1::bigint[]) ORDER BY ticket_id, trocado_em, id`, [ids]),
        db.query(`SELECT t.ticket_id::text AS id, t.createddate, t.urgency, COALESCE(t.resolved_in, t.closed_in) AS fechado_em, cf.valor_texto AS classificacao, COALESCE(cl.fora_sla, false) AS fora_cliente
                    FROM silver.ticket t
                    LEFT JOIN LATERAL (SELECT valor_texto FROM silver.ticket_campo_customizado WHERE ticket_id = t.ticket_id AND custom_field_id = 23946 AND NULLIF(btrim(valor_texto), '') IS NOT NULL ORDER BY item_ordem LIMIT 1) cf ON true
                    ${sqlLateralClienteFora('t')}
                   WHERE t.ticket_id = ANY($1::bigint[])`, [ids]),
        db.query(`SELECT ticket_id::text AS id, criado_em, status FROM silver.ticket_acao WHERE ticket_id = ANY($1::bigint[]) AND status IS NOT NULL ORDER BY criado_em`, [ids]),
      ]);
      const trs = new Map(), ev = new Map();
      hist.rows.forEach((x) => { if (!trs.has(x.id)) trs.set(x.id, []); trs.get(x.id).push({ de: x.de_equipe, para: x.para_equipe, em: x.trocado_em }); });
      ac.rows.forEach((x) => { if (!ev.has(x.id)) ev.set(x.id, []); ev.get(x.id).push({ em: x.criado_em, status: x.status }); });
      const agora = new Date();
      info.rows.forEach((t) => {
        if (!t.createddate) return;
        const l = linhaDoTempo({ id: t.id, criadoEm: t.createddate, urgencia: t.urgency, classificacao: t.classificacao, foraCliente: t.fora_cliente, fechadoEm: t.fechado_em },
          trs.get(t.id) || [], ev.get(t.id) || [], cfg, agora, desde);
        if (l) linhasDoTempo.set(t.id, l);
      });
    }
    // cada repasse da lista ganha o tempo na equipe de origem e o SLA no momento do repasse
    linhas.forEach((l) => {
      const lt = linhasDoTempo.get(l.ticket_id); if (!lt) return;
      const trsT = (lt.segs || []);
      const i = trsT.findIndex((sg, k) => k > 0 && Math.abs(sg.de - new Date(l.criado_em).getTime()) < 1000 && sg.equipe === l.para);
      const origem = i > 0 ? trsT[i - 1] : null;
      l.min_origem = origem ? origem.min : null;
      l.acum_min = origem ? origem.acumMin : null;
      l.meta_h = lt.metaH;
      l.vencido_no_repasse = lt.metaH == null || !origem ? null : origem.acumMin > lt.metaH * 60;
      l.sla_atual = lt.sla; l.total_min = lt.totalMin; l.aberto = lt.aberto; l.inicio_estimado = lt.inicioEstimado;
      l.passagens = trsT.map((sg) => ({ equipe: sg.equipe, min: sg.min, estourouAqui: sg.estourouAqui, emAndamento: sg.emAndamento, estimada: sg.estimada }));
    });

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
      desde,
      por_equipe: resumoPorEquipe([...new Set(linhas.map((l) => l.ticket_id))].map((id) => linhasDoTempo.get(id)).filter(Boolean)),
      equipes,
      resumo: { repasses: linhas.length, chamados: new Set(linhas.map((l) => l.ticket_id)).size },
      pares: [...pares].map(([k, total]) => { const [de2, para] = k.split('\u0000'); return { de: de2, para, total }; }).sort((a, b) => b.total - a.total),
      origem: ordenar(saiu),
      destino: ordenar(entrou),
      chamados: linhas.slice(0, LIMITE_LISTA),
      truncado: linhas.length > LIMITE_LISTA,
    });
  } catch (e) {
    if (e.code === '42P01') return res.json({ periodo: null, desde: null, equipes: [], por_equipe: [], resumo: { repasses: 0, chamados: 0 }, pares: [], origem: [], destino: [], chamados: [], truncado: false });   // histórico ainda não criado
    console.error('[repasses]', e);
    res.status(500).json({ error: 'Erro ao montar a visão de repasses: ' + e.message });
  }
});

module.exports = router;
