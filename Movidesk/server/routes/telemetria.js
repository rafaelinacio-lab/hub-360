'use strict';
/**
 * routes/telemetria.js
 *
 * Telemetria de uso do Hub 360: quem usa, o quê, quando e quanto.
 *
 * POST /telemetria/eventos   — qualquer usuário logado envia lotes de eventos
 *                              (o usuário vem SEMPRE da sessão, nunca do corpo)
 * GET  /telemetria/resumo    — admin: relatório de uso por período
 *
 * Eventos (public.hub_telemetria):
 *   view    — a pessoa abriu uma aba do menu
 *   pagina  — uma tela foi carregada (inclui as abas internas)
 *   click   — clique em botão/link/linha (só o RÓTULO do controle; nunca texto
 *             digitado nem valores de campos)
 *   ativo   — segundos de uso ativo (aba visível e com interação recente)
 *
 * Os dados ficam 180 dias e só admin consulta.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');

const TZ = 'America/Sao_Paulo';
const RETENCAO_DIAS = 180;
const TIPOS = new Set(['view', 'pagina', 'click', 'ativo']);
const MAX_POR_LOTE = 100;

let _pronta = null;
function garantirTabela() {
  if (!_pronta) {
    _pronta = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.hub_telemetria (
          id      BIGSERIAL PRIMARY KEY,
          ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          user_id INTEGER,
          email   TEXT,
          sessao  TEXT,
          tipo    TEXT NOT NULL,
          aba     TEXT,
          pagina  TEXT,
          alvo    TEXT,
          seg     INTEGER
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS hub_telemetria_ts_idx ON public.hub_telemetria (ts)`);
      await db.query(`CREATE INDEX IF NOT EXISTS hub_telemetria_user_ts_idx ON public.hub_telemetria (user_id, ts)`);
    })().catch((e) => { _pronta = null; throw e; });
  }
  return _pronta;
}

async function expurgar() {
  try {
    await garantirTabela();
    await db.query(`DELETE FROM public.hub_telemetria WHERE ts < NOW() - ($1::int * INTERVAL '1 day')`, [RETENCAO_DIAS]);
  } catch (e) { console.warn('[telemetria] expurgo falhou:', e.message); }
}
setTimeout(expurgar, 60 * 1000).unref();
setInterval(expurgar, 24 * 3600 * 1000).unref();

const limpa = (v, max) => {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return s || null;
};

// ===== POST /telemetria/eventos =====
const limite = rateLimit({ name: 'telemetria/eventos', windowMs: 60 * 1000, max: 60 });
router.post('/eventos', authMiddleware, limite, async (req, res) => {
  const lista = Array.isArray(req.body?.eventos) ? req.body.eventos.slice(0, MAX_POR_LOTE) : [];
  const sessao = limpa(req.body?.sessao, 60);
  const ok = lista.filter((e) => e && TIPOS.has(e.tipo));
  if (!ok.length) return res.json({ gravados: 0 });
  try {
    await garantirTabela();
    const agora = Date.now();
    const col = { ts: [], tipo: [], aba: [], pagina: [], alvo: [], seg: [] };
    for (const e of ok) {
      // aceita o horário do navegador só se for dos últimos 10 min (evita relógio errado)
      const t = Number(e.t);
      col.ts.push(new Date(t > agora - 10 * 60 * 1000 && t <= agora + 60 * 1000 ? t : agora).toISOString());
      col.tipo.push(e.tipo);
      col.aba.push(limpa(e.aba, 40));
      col.pagina.push(limpa(e.pagina, 60));
      col.alvo.push(e.tipo === 'click' ? limpa(e.alvo, 80) : null);
      col.seg.push(e.tipo === 'ativo' ? Math.max(0, Math.min(120, parseInt(e.seg, 10) || 0)) : null);
    }
    await db.query(
      `INSERT INTO public.hub_telemetria (ts, user_id, email, sessao, tipo, aba, pagina, alvo, seg)
       SELECT u.ts::timestamptz, $1::int, $2::text, $3::text, u.tipo, u.aba, u.pagina, u.alvo, u.seg::int
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) AS u(ts, tipo, aba, pagina, alvo, seg)`,
      [req.user.id, req.user.email, sessao, col.ts, col.tipo, col.aba, col.pagina, col.alvo, col.seg.map((x) => (x == null ? null : String(x)))]
    );
    res.json({ gravados: ok.length });
  } catch (e) {
    console.error('[telemetria] erro ao gravar:', e.message);
    res.status(500).json({ error: 'Erro ao gravar telemetria' });
  }
});

// ===== GET /telemetria/resumo?dias=30&usuario=ID =====
router.get('/resumo', authMiddleware, requireRole('admin'), async (req, res) => {
  const dias = Math.min(365, Math.max(1, parseInt(req.query.dias, 10) || 30));
  const usuario = parseInt(req.query.usuario, 10) || null;
  try {
    await garantirTabela();
    const params = [dias];
    let filtro = `t.ts >= NOW() - ($1::int * INTERVAL '1 day')`;
    if (usuario) { params.push(usuario); filtro += ` AND t.user_id = $${params.length}`; }
    const dia = `(t.ts AT TIME ZONE '${TZ}')`;

    const [kpi, usuarios, abas, alvos, heat, serie, semAcesso, lista] = await Promise.all([
      db.query(`
        SELECT COUNT(DISTINCT t.user_id)::int AS usuarios,
               COUNT(*) FILTER (WHERE t.tipo = 'view')::int AS acessos,
               COUNT(*) FILTER (WHERE t.tipo = 'click')::int AS cliques,
               COALESCE(SUM(t.seg) FILTER (WHERE t.tipo = 'ativo'), 0)::int AS seg_ativos,
               COUNT(DISTINCT t.sessao)::int AS sessoes
          FROM public.hub_telemetria t WHERE ${filtro}`, params),
      db.query(`
        SELECT t.user_id, COALESCE(u.name, MAX(t.email), 'Desconhecido') AS nome, MAX(t.email) AS email,
               COUNT(*) FILTER (WHERE t.tipo = 'view')::int AS acessos,
               COUNT(*) FILTER (WHERE t.tipo = 'click')::int AS cliques,
               COALESCE(SUM(t.seg) FILTER (WHERE t.tipo = 'ativo'), 0)::int AS seg_ativos,
               COUNT(DISTINCT ${dia}::date)::int AS dias_ativos,
               MAX(t.ts) AS ultima,
               MODE() WITHIN GROUP (ORDER BY t.aba) FILTER (WHERE t.tipo = 'view') AS aba_top
          FROM public.hub_telemetria t LEFT JOIN users u ON u.id = t.user_id
         WHERE ${filtro}
         GROUP BY t.user_id, u.name
         ORDER BY cliques DESC, acessos DESC LIMIT 200`, params),
      db.query(`
        SELECT COALESCE(t.aba, '—') AS aba,
               COUNT(*) FILTER (WHERE t.tipo = 'view')::int AS acessos,
               COUNT(*) FILTER (WHERE t.tipo = 'click')::int AS cliques,
               COUNT(DISTINCT t.user_id)::int AS usuarios,
               COALESCE(SUM(t.seg) FILTER (WHERE t.tipo = 'ativo'), 0)::int AS seg_ativos
          FROM public.hub_telemetria t WHERE ${filtro}
         GROUP BY 1 ORDER BY cliques DESC, acessos DESC`, params),
      db.query(`
        SELECT COALESCE(t.aba, '—') AS aba, t.alvo, COUNT(*)::int AS cliques, COUNT(DISTINCT t.user_id)::int AS usuarios
          FROM public.hub_telemetria t WHERE ${filtro} AND t.tipo = 'click' AND t.alvo IS NOT NULL
         GROUP BY 1, 2 ORDER BY cliques DESC LIMIT 30`, params),
      db.query(`
        SELECT EXTRACT(DOW FROM ${dia})::int AS dow, EXTRACT(HOUR FROM ${dia})::int AS hora, COUNT(*)::int AS n
          FROM public.hub_telemetria t WHERE ${filtro} AND t.tipo IN ('view', 'click')
         GROUP BY 1, 2`, params),
      db.query(`
        SELECT to_char(${dia}::date, 'YYYY-MM-DD') AS dia, COUNT(DISTINCT t.user_id)::int AS usuarios,
               COUNT(*) FILTER (WHERE t.tipo = 'view')::int AS acessos,
               COUNT(*) FILTER (WHERE t.tipo = 'click')::int AS cliques
          FROM public.hub_telemetria t WHERE ${filtro}
         GROUP BY 1 ORDER BY 1`, params),
      usuario ? Promise.resolve({ rows: [] }) : db.query(`
        SELECT u.id, u.name, u.email, u.last_login FROM users u
         WHERE COALESCE(u.is_active, TRUE)
           AND NOT EXISTS (SELECT 1 FROM public.hub_telemetria t WHERE t.user_id = u.id AND t.ts >= NOW() - ($1::int * INTERVAL '1 day'))
         ORDER BY u.name LIMIT 200`, [dias]),
      db.query(`SELECT id, name FROM users WHERE COALESCE(is_active, TRUE) ORDER BY name`),
    ]);

    res.json({
      dias, usuario,
      kpi: kpi.rows[0],
      usuarios: usuarios.rows,
      abas: abas.rows,
      alvos: alvos.rows,
      heat: heat.rows,
      serie: serie.rows,
      semAcesso: semAcesso.rows,
      listaUsuarios: lista.rows,
    });
  } catch (e) {
    console.error('[telemetria] erro no resumo:', e.message);
    res.status(500).json({ error: 'Erro ao montar o relatório de uso' });
  }
});

module.exports = router;
