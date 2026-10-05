'use strict';
/**
 * routes/chats.js
 *
 * Acompanhamento dos atendimentos por CHAT (Movidesk Chat / Zenvia NLU).
 * Cada atendimento de chat é um chamado com chatWidget/chatGroup preenchidos; este módulo
 * copia só esses chamados pra public.hub_chat (sem mexer na carga principal em silver.*)
 * e atualiza a cada poucos minutos, o que dá uma visão quase em tempo real.
 *
 * GET  /chats/resumo?dias=7   — ao vivo (hoje), por grupo, por dia e por hora, últimos chats
 * POST /chats/sincronizar     — admin: busca chats antigos (reprocessamento), body { dias }
 *
 * Observação: chatTalkTime e chatWaitingTime só vêm preenchidos quando o chat termina; a unidade
 * (segundos) é a presumida a partir dos exemplos da API e deve ser conferida com um chat conhecido.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { requireTabAccess, getToken } = require('./config');

const MOVI_TICKETS = 'https://apimovidesk.viasoftcloud.com.br/public/v1/tickets';
const SELECT = ['id', 'origin', 'createdDate', 'lastUpdate', 'status', 'baseStatus', 'ownerTeam', 'chatWidget', 'chatGroup', 'chatTalkTime', 'chatWaitingTime'].join(',');
const TZ = 'America/Sao_Paulo';
const ABERTOS = ['New', 'InAttendance', 'InProgress', 'Stopped'];      // baseStatus de chamado ainda aberto
const PAGINA = 100;
const ESPERA_ENTRE_PAGINAS_MS = 2200;                                   // respeita o limite de chamadas da API
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _pronta = null;
function garantirTabela() {
  if (!_pronta) {
    _pronta = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.hub_chat (
          ticket_id      BIGINT PRIMARY KEY,
          criado_em      TIMESTAMPTZ,
          atualizado_em  TIMESTAMPTZ,
          status         TEXT,
          base_status    TEXT,
          origem         TEXT,
          widget         TEXT,
          grupo          TEXT,
          equipe         TEXT,
          tempo_conversa NUMERIC,
          tempo_espera   NUMERIC,
          coletado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS hub_chat_criado_idx ON public.hub_chat (criado_em)`);
      await db.query(`CREATE INDEX IF NOT EXISTS hub_chat_base_idx ON public.hub_chat (base_status)`);
    })().catch((e) => { _pronta = null; throw e; });
  }
  return _pronta;
}

// ── coleta no Movidesk ────────────────────────────────────────────────────
const job = { rodando: false, ultimaOk: null, ultimaMsg: '', ultimosGravados: 0 };
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function gravar(lista) {
  if (!lista.length) return;
  const col = (fn) => lista.map(fn);
  await db.query(
    `INSERT INTO public.hub_chat (ticket_id, criado_em, atualizado_em, status, base_status, origem, widget, grupo, equipe, tempo_conversa, tempo_espera, coletado_em)
     SELECT u.id::bigint, u.criado::timestamptz, u.atualizado::timestamptz, u.status, u.base, u.origem, u.widget, u.grupo, u.equipe, u.conversa::numeric, u.espera::numeric, NOW()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS u(id, criado, atualizado, status, base, origem, widget, grupo, equipe, conversa, espera)
     ON CONFLICT (ticket_id) DO UPDATE SET
       criado_em = EXCLUDED.criado_em, atualizado_em = EXCLUDED.atualizado_em, status = EXCLUDED.status, base_status = EXCLUDED.base_status,
       origem = EXCLUDED.origem, widget = EXCLUDED.widget, grupo = EXCLUDED.grupo, equipe = EXCLUDED.equipe,
       tempo_conversa = EXCLUDED.tempo_conversa, tempo_espera = EXCLUDED.tempo_espera, coletado_em = NOW()`,
    [col((t) => String(t.id)), col((t) => t.createdDate || null), col((t) => t.lastUpdate || null), col((t) => t.status || null),
      col((t) => t.baseStatus || null), col((t) => (t.origin == null ? null : String(t.origin))), col((t) => t.chatWidget || null),
      col((t) => t.chatGroup || null), col((t) => t.ownerTeam || null), col((t) => num(t.chatTalkTime)), col((t) => num(t.chatWaitingTime))]
  );
}

// Busca os chats alterados desde `desde` (ISO) e grava. Devolve quantos gravou.
async function sincronizar({ desde, maxPaginas }) {
  if (job.rodando) return { ocupado: true };
  job.rodando = true;
  let gravados = 0;
  try {
    await garantirTabela();
    const token = await new Promise((ok, ko) => getToken((e, t) => (e ? ko(e) : ok(t))));
    const filtro = encodeURIComponent(`chatWidget ne null and lastUpdate ge ${desde}`);
    for (let pag = 0; pag < maxPaginas; pag++) {
      const url = `${MOVI_TICKETS}?token=${encodeURIComponent(token)}&$select=${encodeURIComponent(SELECT)}&$filter=${filtro}`
        + `&$orderby=${encodeURIComponent('lastUpdate desc')}&$top=${PAGINA}&$skip=${pag * PAGINA}`;
      const r = await fetch(url);
      if (!r.ok) {
        const corpo = (await r.text().catch(() => '')).replace(token, '***').slice(0, 200);
        throw new Error(`Movidesk respondeu ${r.status}: ${corpo}`);
      }
      const dados = await r.json();
      const lista = Array.isArray(dados) ? dados : [];
      await gravar(lista);
      gravados += lista.length;
      if (lista.length < PAGINA) break;
      await sleep(ESPERA_ENTRE_PAGINAS_MS);
    }
    job.ultimaOk = new Date().toISOString(); job.ultimaMsg = 'ok'; job.ultimosGravados = gravados;
    return { gravados };
  } catch (e) {
    job.ultimaMsg = e.message;
    throw e;
  } finally { job.rodando = false; }
}

// Rotina automática: a cada 2 min traz o que mudou desde a última coleta (com folga de 10 min).
async function rotina() {
  try {
    await garantirTabela();
    const ult = (await db.query(`SELECT max(coletado_em) AS u FROM public.hub_chat`)).rows[0].u;
    const desde = ult ? new Date(new Date(ult).getTime() - 10 * 60 * 1000) : new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await sincronizar({ desde: desde.toISOString().replace(/\.\d+Z$/, 'Z'), maxPaginas: 10 });
  } catch (e) {
    if (!/Token nao configurado/i.test(e.message)) console.warn('[chats] sincronização falhou:', e.message);
  }
}
if (process.env.CHATS_SYNC !== '0') {
  setTimeout(() => { rotina(); setInterval(rotina, 2 * 60 * 1000).unref(); }, 45 * 1000).unref();
}

// ── rotas ─────────────────────────────────────────────────────────────────
router.use(authMiddleware);

router.get('/resumo', requireTabAccess('movidesk'), async (req, res) => {
  const dias = Math.min(90, Math.max(1, parseInt(req.query.dias, 10) || 7));
  try {
    await garantirTabela();
    const dia = `(criado_em AT TIME ZONE '${TZ}')`;
    const hoje = `${dia}::date = (NOW() AT TIME ZONE '${TZ}')::date`;
    const fim = `base_status IN ('Resolved','Closed')`;
    const [vivo, antigos, grupoHoje, geralHoje, porDia, porHora, recentes, meta] = await Promise.all([
      db.query(`SELECT COALESCE(grupo, 'Sem grupo') AS grupo, COALESCE(status, base_status) AS status, count(*)::int AS n, min(criado_em) AS mais_antigo
                  FROM public.hub_chat WHERE base_status = ANY($1::text[]) AND criado_em >= NOW() - INTERVAL '24 hours'
                 GROUP BY 1, 2 ORDER BY 1, 2`, [ABERTOS]),
      db.query(`SELECT count(*)::int AS n FROM public.hub_chat WHERE base_status = ANY($1::text[]) AND criado_em < NOW() - INTERVAL '24 hours'`, [ABERTOS]),
      db.query(`SELECT COALESCE(grupo, 'Sem grupo') AS grupo, count(*)::int AS total,
                       count(*) FILTER (WHERE ${fim})::int AS encerrados,
                       round(avg(tempo_espera) FILTER (WHERE tempo_espera IS NOT NULL))::int AS espera_media,
                       round(avg(tempo_conversa) FILTER (WHERE tempo_conversa IS NOT NULL))::int AS conversa_media
                  FROM public.hub_chat WHERE ${hoje} GROUP BY 1 ORDER BY total DESC`),
      db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE ${fim})::int AS encerrados,
                       round(avg(tempo_espera) FILTER (WHERE tempo_espera IS NOT NULL))::int AS espera_media,
                       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY tempo_espera) FILTER (WHERE tempo_espera IS NOT NULL))::numeric)::int AS espera_p90,
                       round(avg(tempo_conversa) FILTER (WHERE tempo_conversa IS NOT NULL))::int AS conversa_media,
                       count(*) FILTER (WHERE tempo_espera IS NOT NULL)::int AS com_espera
                  FROM public.hub_chat WHERE ${hoje}`),
      db.query(`SELECT to_char(${dia}::date, 'YYYY-MM-DD') AS dia, count(*)::int AS total,
                       round(avg(tempo_espera) FILTER (WHERE tempo_espera IS NOT NULL))::int AS espera_media,
                       round(avg(tempo_conversa) FILTER (WHERE tempo_conversa IS NOT NULL))::int AS conversa_media
                  FROM public.hub_chat WHERE criado_em >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY 1 ORDER BY 1`, [dias]),
      db.query(`SELECT EXTRACT(HOUR FROM ${dia})::int AS hora, count(*)::int AS total,
                       count(DISTINCT ${dia}::date)::int AS dias
                  FROM public.hub_chat WHERE criado_em >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY 1 ORDER BY 1`, [dias]),
      db.query(`SELECT ticket_id::text AS id, criado_em, COALESCE(status, base_status) AS status, base_status, COALESCE(grupo, 'Sem grupo') AS grupo, widget, tempo_espera, tempo_conversa
                  FROM public.hub_chat ORDER BY criado_em DESC NULLS LAST LIMIT 40`),
      db.query(`SELECT count(*)::int AS total, max(coletado_em) AS ultima_coleta, min(criado_em) AS desde FROM public.hub_chat`),
    ]);
    res.json({
      dias, vivo: vivo.rows, abertosAntigos: antigos.rows[0].n, grupoHoje: grupoHoje.rows, hoje: geralHoje.rows[0],
      porDia: porDia.rows, porHora: porHora.rows, recentes: recentes.rows, meta: meta.rows[0],
      job: { rodando: job.rodando, ultimaOk: job.ultimaOk, msg: job.ultimaMsg }, agora: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[chats] erro no resumo:', e.message);
    res.status(500).json({ error: 'Erro ao montar o painel de chats' });
  }
});

// Reprocessamento manual (admin): traz chats dos últimos N dias, em segundo plano.
router.post('/sincronizar', requireRole('admin'), async (req, res) => {
  const dias = Math.min(180, Math.max(1, parseInt(req.body?.dias, 10) || 30));
  if (job.rodando) return res.status(409).json({ error: 'Já existe uma coleta em andamento.' });
  const desde = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  sincronizar({ desde, maxPaginas: 200 }).catch((e) => console.warn('[chats] reprocessamento falhou:', e.message));
  res.json({ iniciado: true, dias });
});

module.exports = router;
