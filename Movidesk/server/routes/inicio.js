'use strict';
// Tela "Início": o que a pessoa vê ao abrir o Hub — saudação do dia, resumo DELA e da EQUIPE (= vertical(es) em Pessoas;
// sem vertical = Hub inteiro), "o que mudou desde a última visita" e atalhos pelo uso real. Vale para TODOS os perfis.
//   GET /api/inicio?escopo=equipe|hub   (hub só para quem não é filtrado por vertical: admin ou perfil sem vertical)
// Regras: SLA e "vencido" pela RÉGUA DO HUB (utils/slaRegraHub.js + política de SLA); equipe = chamados de Suporte Técnico
// do escopo; o usuário só recebe os próprios números e agregados da equipe. Cada seção que falhar volta null — a tela
// nunca cai por causa de uma parte. Tabela nova: public.hub_inicio_visita (a de saudações fica em utils/inicioSaudacao.js).
const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { escopoVertical, pertence, norm } = require('../utils/verticalScope');
const slaHub = require('../utils/slaRegraHub');
const P = require('../utils/slaPolitica');
const { lerConfigEmCache } = require('../utils/slaHorasCore');
const { getTabPermissions } = require('./config');
const saudacao = require('../utils/inicioSaudacao');

const SESSAO_MS = 30 * 60 * 1000;
const BRT_MS = -3 * 3600 * 1000;   // Brasília = UTC-3 (sem horário de verão)
const FECHADOS_SQL = `'Resolved','Closed','Canceled','Resolvido','Fechado','Cancelado'`;
const RESOLVIDOS_SQL = `'Resolved','Closed','Resolvido','Fechado'`;
const SEM_ACENTO_SQL = (x) => `lower(translate(${x}, 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'))`;
const CLASSIF_JOIN = `LEFT JOIN LATERAL (SELECT valor_texto FROM silver.ticket_campo_customizado
    WHERE ticket_id = t.ticket_id AND custom_field_id = 23946 AND NULLIF(btrim(valor_texto), '') IS NOT NULL ORDER BY item_ordem LIMIT 1) cf ON true`;
const ABAS = {   // aba (data-view do shell) → [rótulo, chave de permissão | null = sempre | 'admin']
  dashboard: ['Dashboard', 'dashboard'], movidesk: ['Movidesk', 'movidesk'], chamados: ['Curadoria', 'chamados'], ouvidoria: ['Ouvidoria', 'ouvidoria'],
  gcc: ['GCC', 'gcc'], jira: ['Jira', 'jira'], satisfacao: ['Satisfação', 'satisfacao'], incidentes: ['Incidentes', 'incidentes'],
  reincidencias: ['Reincidências', 'reincidencias'], melhorias: ['Melhorias', 'nao-guest'], configuracoes: ['Configurações', 'admin'],
};

// ── tempo (Brasília) ──────────────────────────────────────────────────────────────────────────────────────
const brt = (ms) => new Date(ms + BRT_MS);                                   // campos UTC do Date = relógio de Brasília
const diaDe = (ms) => brt(ms).toISOString().slice(0, 10);                     // 'YYYY-MM-DD'
const numeroDoDia = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86400000);
const inicioDoMes = (ms, deslocar = 0) => { const b = brt(ms); return Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + deslocar, 1, 3, 0, 0); };   // instante UTC
const periodoDe = (ms) => { const h = brt(ms).getUTCHours(); return h < 12 ? 'manha' : h < 18 ? 'tarde' : 'noite'; };
const dataBr = (ms) => { const [y, m, d] = diaDe(ms).split('-'); return `${d}/${m}/${y}`; };
const primeiroNomeDe = (nome) => { const p = String(nome || '').trim().split(/\s+/)[0] || ''; return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : 'colega'; };

// ── escopo de vertical em SQL (mesma regra de pertence(): 1º nível do serviço; equipe só sem serviço) ────────────────────
function sqlVertical(alias, p) {
  const n1 = `btrim(split_part(${alias}.service_full, ' > ', 1))`;
  const eq = `COALESCE(NULLIF(${alias}.owner_team, ''), ${alias}.ownerteam, '')`;
  return `(${SEM_ACENTO_SQL(n1)} = ANY($${p}::text[]) OR (COALESCE(btrim(${alias}.service_full), '') = '' AND EXISTS (SELECT 1 FROM unnest($${p}::text[]) v WHERE v <> '' AND strpos(${SEM_ACENTO_SQL(eq)}, v) > 0)))`;
}
const alvosDe = (esc) => [...new Set(esc.verticais.map(norm).filter(Boolean))].sort();

// ── cache simples em memória (com chamadas em andamento compartilhadas) ───────────────────────────────────────
const _cache = new Map();
async function comCache(chave, ttlMs, fn) {
  const c = _cache.get(chave);
  if (c && Date.now() - c.em < ttlMs) return c.v;
  if (c && c.p) return c.p;
  const p = fn().then((v) => { _cache.set(chave, { v, em: Date.now() }); return v; }).catch((e) => { _cache.delete(chave); throw e; });
  _cache.set(chave, { ...(c || {}), p, em: c ? c.em : 0 });
  return p;
}
setInterval(() => { const lim = Date.now() - 10 * 60 * 1000; for (const [k, v] of _cache) if (v.em < lim && !v.p) _cache.delete(k); }, 5 * 60 * 1000).unref();

// ── visitas e telemetria (_visitas é trocável nos testes) ─────────────────────────────────────────────────────
let _tabelaVisita = null;
const _visitas = {
  async garantir() {
    if (!_tabelaVisita) {
      _tabelaVisita = (async () => {
        await db.query(`CREATE TABLE IF NOT EXISTS public.hub_inicio_visita (id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL, visto_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await db.query(`CREATE INDEX IF NOT EXISTS hub_inicio_visita_user_idx ON public.hub_inicio_visita (user_id, visto_em DESC)`);
      })().catch((e) => { _tabelaVisita = null; throw e; });
    }
    return _tabelaVisita;
  },
  async registradas(userId) {   // instantes (ms) das visitas já registradas, mais recentes primeiro
    await this.garantir();
    const r = await db.query(`SELECT visto_em FROM public.hub_inicio_visita WHERE user_id = $1 ORDER BY visto_em DESC LIMIT 400`, [userId]);
    return r.rows.map((x) => new Date(x.visto_em).getTime());
  },
  async registrar(userId) { await this.garantir(); await db.query(`INSERT INTO public.hub_inicio_visita (user_id) VALUES ($1)`, [userId]); },
  async eventos(userId) {   // instantes (ms) dos eventos de telemetria do usuário (leitura; sem a tabela, vazio)
    try {
      const r = await db.query(`SELECT ts FROM public.hub_telemetria WHERE user_id = $1 ORDER BY ts DESC LIMIT 800`, [userId]);
      return r.rows.map((x) => new Date(x.ts).getTime());
    } catch { return []; }
  },
  async diasComVisita(userId) {   // dias (BRT) com visita registrada ou 'view' na telemetria
    const dias = new Set();
    try { (await db.query(`SELECT DISTINCT (visto_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS d FROM public.hub_inicio_visita WHERE user_id = $1`, [userId])).rows.forEach((x) => dias.add(x.d)); } catch { /* tabela nova */ }
    try { (await db.query(`SELECT DISTINCT (ts AT TIME ZONE 'America/Sao_Paulo')::date::text AS d FROM public.hub_telemetria WHERE user_id = $1 AND tipo = 'view' AND ts > NOW() - INTERVAL '120 days'`, [userId])).rows.forEach((x) => dias.add(x.d)); } catch { /* sem telemetria */ }
    return dias;
  },
  async ultimaAbaAntes(userId, ateMs) {
    try {
      const r = await db.query(`SELECT aba FROM public.hub_telemetria WHERE user_id = $1 AND tipo = 'view' AND aba IS NOT NULL AND aba <> 'inicio' AND ts < $2 ORDER BY ts DESC LIMIT 1`, [userId, new Date(ateMs)]);
      return r.rows[0] ? r.rows[0].aba : null;
    } catch { return null; }
  },
  async abasMaisUsadas(userId) {
    try {
      const r = await db.query(`SELECT aba, COUNT(*)::int AS n FROM public.hub_telemetria WHERE user_id = $1 AND tipo = 'view' AND aba IS NOT NULL AND aba <> 'inicio'
        AND ts > NOW() - INTERVAL '30 days' GROUP BY aba ORDER BY n DESC LIMIT 20`, [userId]);
      return r.rows;
    } catch { return []; }
  },
};

// "Sessão" = sequência de atividade com intervalos de até 30 min (visitas registradas + telemetria). anterior = o fim da
// atividade imediatamente antes da sessão atual (ou, se nada aconteceu nos últimos 30 min, a atividade mais recente).
async function calcularVisita(userId, agoraMs) {
  const [registradas, eventos, diasSet] = await Promise.all([_visitas.registradas(userId).catch(() => []), _visitas.eventos(userId), _visitas.diasComVisita(userId).catch(() => new Set())]);
  const tempos = [...registradas, ...eventos].sort((a, b) => b - a);
  let inicioSessao = agoraMs, anterior = null;
  if (tempos.length && agoraMs - tempos[0] <= SESSAO_MS) {
    let i = 0;
    while (i + 1 < tempos.length && tempos[i] - tempos[i + 1] <= SESSAO_MS) i++;
    inicioSessao = tempos[i]; anterior = tempos[i + 1] != null ? tempos[i + 1] : null;
  } else if (tempos.length) {
    anterior = tempos[0];
  }
  // registra a visita (no máximo 1 a cada 30 min)
  if (!registradas.length || agoraMs - registradas[0] > SESSAO_MS) await _visitas.registrar(userId).catch((e) => console.warn('[inicio] não registrou a visita:', e.message));
  const hoje = diaDe(agoraMs);
  diasSet.add(hoje);
  let sequencia = 0;
  for (let n = numeroDoDia(hoje); diasSet.has(new Date(n * 86400000).toISOString().slice(0, 10)); n--) sequencia++;
  const diasDesde = anterior != null ? Math.max(0, numeroDoDia(hoje) - numeroDoDia(diaDe(anterior))) : null;
  const ultimaAba = await _visitas.ultimaAbaAntes(userId, inicioSessao);
  return { primeira: anterior == null, anterior: anterior != null ? new Date(anterior).toISOString() : null, anteriorMs: anterior, diasDesde, sequencia, ultimaAba };
}

// ── chamados ──────────────────────────────────────────────────────────────────────────────────────────────
// Base GLOBAL (todas as verticais), em cache de 2 min e recarregada em segundo plano enquanto alguém usa a tela: o resumo da
// equipe e o resumo dele saem dela em memória (pertence()), então o custo das varreduras de silver.ticket é pago uma vez
// por janela e não por usuário. Três consultas: A) abertos (todas as classificações) com a régua do Hub aplicada aos de
// Suporte Técnico; B) resolvidos agregados por (serviço, equipe, responsável, mês); C) criados hoje por (serviço, equipe).
async function carregarAbertos() {
  const r = await db.query(`
    SELECT t.ticket_id::text AS ticket_id, t.createddate AS criado_em, t.status AS status_movidesk, t.urgency AS urgencia,
           t.ownerteam AS equipe, btrim(split_part(COALESCE(t.service_full, ''), ' > ', 1)) AS servico,
           COALESCE(NULLIF(t.owner_team, ''), t.ownerteam, '') AS equipe_escopo, lower(COALESCE(t.owneremail, '')) AS dono,
           cf.valor_texto AS classificacao, COALESCE(cl.fora_sla, false) AS sla_fora_cliente
      FROM silver.ticket t ${CLASSIF_JOIN} ${slaHub.sqlLateralClienteFora('t')}
     WHERE t.basestatus NOT IN (${FECHADOS_SQL})`);
  const rows = r.rows;
  const st = rows.filter((x) => x.classificacao === 'Suporte Técnico');   // só estes têm SLA (régua do Hub)
  const ev = new Map();
  if (st.length) {
    const ac = await db.query(`SELECT ticket_id::text AS id, criado_em, status FROM silver.ticket_acao WHERE ticket_id = ANY($1::bigint[]) AND status IS NOT NULL ORDER BY criado_em`, [st.map((x) => x.ticket_id)]);
    for (const a of ac.rows) { if (!ev.has(a.id)) ev.set(a.id, []); ev.get(a.id).push({ em: a.criado_em, status: a.status }); }
  }
  const cfg = await lerConfigEmCache();
  slaHub.marcarPendentes(st, ev, cfg);
  return { rows, ev, cfg };
}
// "Cliente fora do SLA" (Coronel Vivida, MP Agrotech, AD Tech, só Viasoft) de cada chamado resolvido: muda raramente, então fica em
// memória e só os chamados novos vão ao banco (a busca por chamado custa ~0,1 ms só depois de achar o cliente).
const _foraSla = new Map();
async function foraSlaDe(ids) {
  const faltam = ids.filter((id) => !_foraSla.has(id));
  for (let i = 0; i < faltam.length; i += 5000) {
    const lote = faltam.slice(i, i + 5000);
    const r = await db.query(`SELECT t.ticket_id::text AS id, COALESCE(cl.fora_sla, false) AS fora FROM silver.ticket t ${slaHub.sqlLateralClienteFora('t')} WHERE t.ticket_id = ANY($1::bigint[])`, [lote]);
    r.rows.forEach((x) => _foraSla.set(x.id, x.fora));
  }
  if (_foraSla.size > 200000) _foraSla.clear();
}
async function carregarResolvidos(agoraMs) {
  const mes = new Date(inicioDoMes(agoraMs)), ant = new Date(inicioDoMes(agoraMs, -1));
  const hoje0 = new Date(`${diaDe(agoraMs)}T00:00:00-03:00`), hoje1 = new Date(hoje0.getTime() + 86400000);
  const svc = `btrim(split_part(COALESCE(t.service_full, ''), ' > ', 1))`, eq = `COALESCE(NULLIF(t.owner_team, ''), t.ownerteam, '')`, dono = `lower(COALESCE(t.owneremail, ''))`;
  const [sla, simples, fechados] = await Promise.all([
    // SLA (régua do Hub): chamados de Suporte Técnico com tempo líquido guardado (utils/slaLiquido.js), resolvidos desde o mês anterior
    db.query(`
      SELECT t.ticket_id::text AS id, ${svc} AS servico, ${eq} AS equipe, ${dono} AS dono, (t.resolved_in >= $1) AS no_mes, s.minutos, ${slaHub.sqlMetaH('t.urgency')} AS meta
        FROM silver.ticket_sla_liquido s JOIN silver.ticket t ON t.ticket_id = s.ticket_id AND t.resolved_in = s.resolvido_em
       WHERE s.resolvido_em >= $2 AND s.minutos IS NOT NULL AND t.basestatus IN (${RESOLVIDOS_SQL}) AND ${slaHub.sqlEquipeConta('t.ownerteam')}
         AND ${slaHub.sqlMetaH('t.urgency')} IS NOT NULL`, [mes, ant]),
    // resolvidos de qualquer classificação por responsável (para "resolvidos no mês")
    db.query(`SELECT ${svc} AS servico, ${eq} AS equipe, ${dono} AS dono, (t.resolved_in >= $1) AS no_mes, COUNT(*)::int AS n
                FROM silver.ticket t WHERE t.resolved_in >= $2 AND t.basestatus IN (${RESOLVIDOS_SQL}) GROUP BY 1, 2, 3, 4`, [mes, ant]),
    // fechados hoje (Suporte Técnico)
    db.query(`SELECT ${svc} AS servico, ${eq} AS equipe, COUNT(*)::int AS n FROM silver.ticket t ${CLASSIF_JOIN}
               WHERE COALESCE(t.resolved_in, t.closed_in) >= $1 AND COALESCE(t.resolved_in, t.closed_in) < $2 AND cf.valor_texto = 'Suporte Técnico' GROUP BY 1, 2`, [hoje0, hoje1]),
  ]);
  await foraSlaDe(sla.rows.map((x) => x.id));
  const grupos = new Map();   // (servico|equipe|dono|periodo) -> linha agregada
  const linha = (g, periodo) => {
    const k = `${g.servico}|${g.equipe}|${g.dono || ''}|${periodo}`;
    if (!grupos.has(k)) grupos.set(k, { servico: g.servico, equipe: g.equipe, dono: g.dono || '', periodo, resolvidos: 0, fecharam: 0, base: 0, dentro: 0 });
    return grupos.get(k);
  };
  for (const x of sla.rows) {
    if (_foraSla.get(x.id)) continue;
    const l = linha(x, x.no_mes ? 'mes' : 'ant');
    l.base++; if (x.minutos / 60 <= x.meta) l.dentro++;
  }
  for (const x of simples.rows) linha(x, x.no_mes ? 'mes' : 'ant').resolvidos += x.n;
  for (const x of fechados.rows) linha({ ...x, dono: '' }, 'hoje').fecharam += x.n;
  return [...grupos.values()];
}
async function carregarCriadosHoje(agoraMs) {
  const hoje0 = new Date(`${diaDe(agoraMs)}T00:00:00-03:00`);
  const r = await db.query(`
    SELECT btrim(split_part(COALESCE(t.service_full, ''), ' > ', 1)) AS servico, COALESCE(NULLIF(t.owner_team, ''), t.ownerteam, '') AS equipe, COUNT(*)::int AS n
      FROM silver.ticket t ${CLASSIF_JOIN} WHERE t.createddate >= $1 AND cf.valor_texto = 'Suporte Técnico' GROUP BY 1, 2`, [hoje0]);
  return r.rows;
}
let _ultimoUso = 0;
async function globais(agoraMs) {
  _ultimoUso = Date.now();
  return comCache('globais', 120 * 1000, async () => {
    const [abertos, resolvidos, criados] = await Promise.all([carregarAbertos(), carregarResolvidos(agoraMs), carregarCriadosHoje(agoraMs)]);
    return { abertos, resolvidos, criados };
  });
}
// aquece a base ~25 s depois de o servidor subir, para o primeiro acesso do dia não pagar a carga fria
setTimeout(() => { _ultimoUso = Date.now(); globais(Date.now()).catch((e) => console.warn('[inicio] aquecimento falhou:', e.message)); }, 25 * 1000).unref();
// recarrega a base em segundo plano a cada ~100 s, mas só enquanto a tela foi usada nos últimos 15 min
setInterval(() => {
  if (Date.now() - _ultimoUso > 15 * 60 * 1000) return;
  const antigo = _cache.get('globais');
  Promise.all([carregarAbertos(), carregarResolvidos(Date.now()), carregarCriadosHoje(Date.now())])
    .then(([abertos, resolvidos, criados]) => { _cache.set('globais', { v: { abertos, resolvidos, criados }, em: Date.now() }); })
    .catch((e) => { console.warn('[inicio] recarga em segundo plano falhou:', e.message); if (antigo) _cache.set('globais', antigo); });
}, 100 * 1000).unref();

// Quem pertence ao escopo da pessoa (mesma regra de pertence(): 1º nível do serviço; equipe só quando não há serviço)
const noEscopo = (esc, alvos, g) => !alvos || pertence(esc.verticais, { servico: g.servico, equipe: g.servico ? null : g.equipe_escopo || g.equipe });
const contar = (rows, f) => rows.reduce((n, x) => n + (f(x) ? 1 : 0), 0);
const soma = (rows, campo, f = () => true) => rows.reduce((n, x) => n + (f(x) ? x[campo] : 0), 0);
const pctDe = (dentro, base) => (base ? Math.round((dentro / base) * 1000) / 10 : null);

// Quando o prazo de cada pendente (não vencido, não pausado) acaba hoje: restante da meta ≤ minutos úteis que sobram hoje.
function vencemHoje(rows, cfg, agoraMs) {
  const fimDoDia = new Date(`${diaDe(agoraMs)}T23:59:59-03:00`);
  const sobra = P.minutosUteis(new Date(agoraMs), fimDoDia, cfg);
  if (sobra <= 0) return 0;
  return contar(rows, (x) => x.sla_hub === 'no_prazo' && x.sla_meta_h != null && x.sla_meta_h * 60 - x.sla_aberto_min > 0 && x.sla_meta_h * 60 - x.sla_aberto_min <= sobra);
}

// Resumo da EQUIPE (a partir da base global)
function resumoEquipe(G, esc, alvos) {
  const pend = G.abertos.rows.filter((x) => x.classificacao === 'Suporte Técnico' && noEscopo(esc, alvos, x));
  const res = G.resolvidos.filter((g) => noEscopo(esc, alvos, g));
  const total = pend.length, vencidos = contar(pend, (x) => x.sla_hub === 'vencido');
  const mes = { base: soma(res, 'base', (g) => g.periodo === 'mes'), dentro: soma(res, 'dentro', (g) => g.periodo === 'mes') };
  const ant = { base: soma(res, 'base', (g) => g.periodo === 'ant'), dentro: soma(res, 'dentro', (g) => g.periodo === 'ant') };
  const pausados = contar(pend, (x) => x.sla_hub === 'pausado'), noPrazo = contar(pend, (x) => x.sla_hub === 'no_prazo');
  return {
    pend,
    resumo: {
      classificacao: 'Suporte Técnico', pendentes: total, vencidos, pctVencido: total ? Math.round((vencidos / total) * 1000) / 10 : 0,
      pausados, noPrazo, foraSla: total - vencidos - pausados - noPrazo,
      entraramHoje: soma(G.criados.filter((g) => noEscopo(esc, alvos, g)), 'n'), fecharamHoje: soma(res, 'fecharam'),
      slaMes: pctDe(mes.dentro, mes.base), slaMesAnterior: pctDe(ant.dentro, ant.base), baseSlaMes: mes.base,
    },
  };
}
// Resumo DELE (também da base global: abertos pelo e-mail do responsável; resolvidos/SLA pelas linhas agregadas dele)
function resumoDele(G, email, agoraMs) {
  const e = String(email || '').toLowerCase();
  const pend = e ? G.abertos.rows.filter((x) => x.dono === e) : [];
  const res = e ? G.resolvidos.filter((g) => g.dono === e) : [];
  const mes = { base: soma(res, 'base', (g) => g.periodo === 'mes'), dentro: soma(res, 'dentro', (g) => g.periodo === 'mes') };
  const ant = { base: soma(res, 'base', (g) => g.periodo === 'ant'), dentro: soma(res, 'dentro', (g) => g.periodo === 'ant') };
  const resolvidosMes = soma(res, 'resolvidos', (g) => g.periodo === 'mes');
  const abertos = pend.length;
  return {
    pend,
    resumo: {
      vinculado: abertos > 0 || resolvidosMes > 0 || mes.base > 0 || ant.base > 0, abertos,
      vencidos: contar(pend, (x) => x.sla_hub === 'vencido'), vencemHoje: vencemHoje(pend.filter((x) => x.sla_hub), G.abertos.cfg, agoraMs),
      pausados: contar(pend, (x) => x.sla_hub === 'pausado'), resolvidosMes, slaMes: pctDe(mes.dentro, mes.base), slaMesAnterior: pctDe(ant.dentro, ant.base), baseSlaMes: mes.base,
    },
  };
}

// O que mudou desde a última visita: 1 consulta de contagens + o SLA do mês como estava na última visita (parte da tabela
// pequena ticket_sla_liquido); os vencidos novos saem dos pendentes já carregados.
async function mudancas(email, esc, alvos, G, equipe, agoraMs, anteriorMs) {
  if (anteriorMs == null) return null;
  const desde = new Date(anteriorMs), e = String(email || '').toLowerCase();
  const params = alvos ? [desde, e, alvos] : [desde, e];
  const escSql = alvos ? ` AND ${sqlVertical('t', 3)}` : '';
  const [cont, slaAntes] = await Promise.all([
    db.query(`
      SELECT COUNT(*) FILTER (WHERE t.createddate > $1 AND cf.valor_texto = 'Suporte Técnico'${escSql})::int AS novos_equipe,
             COUNT(*) FILTER (WHERE t.resolved_in > $1 AND t.basestatus IN (${RESOLVIDOS_SQL}) AND cf.valor_texto = 'Suporte Técnico'${escSql})::int AS resolvidos_equipe,
             COUNT(*) FILTER (WHERE t.createddate > $1 AND lower(t.owneremail) = $2)::int AS minha_fila
        FROM silver.ticket t ${CLASSIF_JOIN} WHERE t.createddate > $1 OR t.resolved_in > $1`, params),
    anteriorMs >= inicioDoMes(agoraMs) ? slaAteInstante(alvos, anteriorMs, agoraMs) : Promise.resolve(null),
  ]);
  const novosVenc = contar(equipe.pend, (x) => x.sla_hub === 'vencido' && new Date(x.criado_em).getTime() < anteriorMs
    && P.minutosLiquidos(x.criado_em, desde, G.abertos.ev.get(String(x.ticket_id)) || [], G.abertos.cfg) / 60 <= x.sla_meta_h);
  const c = cont.rows[0];
  return {
    desde: desde.toISOString(), novosNaMinhaFila: c.minha_fila, novosNaEquipe: c.novos_equipe, resolvidosEquipe: c.resolvidos_equipe, vencidosNovos: novosVenc,
    slaDeltaPp: slaAntes != null && slaAntes.pct != null && equipe.resumo.slaMes != null ? Math.round((equipe.resumo.slaMes - slaAntes.pct) * 10) / 10 : null,
  };
}
// SLA (régua do Hub) dos resolvidos do mês até `ateMs`, partindo da tabela ticket_sla_liquido (pequena)
async function slaAteInstante(alvos, ateMs, agoraMs) {
  const params = [new Date(inicioDoMes(agoraMs)), new Date(ateMs)];
  let escSql = '';
  if (alvos) { params.push(alvos); escSql = ` AND ${sqlVertical('t', 3)}`; }
  const r = await db.query(`
    SELECT COUNT(*)::int AS base, COUNT(*) FILTER (WHERE s.minutos / 60.0 <= ${slaHub.sqlMetaH('t.urgency')})::int AS dentro
      FROM silver.ticket_sla_liquido s JOIN silver.ticket t ON t.ticket_id = s.ticket_id AND t.resolved_in = s.resolvido_em
      ${CLASSIF_JOIN} ${slaHub.sqlLateralClienteFora('t')}
     WHERE s.resolvido_em >= $1 AND s.resolvido_em < $2 AND s.minutos IS NOT NULL AND t.basestatus IN (${RESOLVIDOS_SQL})
       AND cf.valor_texto = 'Suporte Técnico' AND ${slaHub.sqlEquipeConta('t.ownerteam')} AND NOT COALESCE(cl.fora_sla, false)
       AND ${slaHub.sqlMetaH('t.urgency')} IS NOT NULL${escSql}`, params);
  return { base: r.rows[0].base, pct: pctDe(r.rows[0].dentro, r.rows[0].base) };
}

// Atalhos: abas que a pessoa mais usou (30 dias) e que ela pode abrir
async function atalhosDe(userId, papel) {
  const usos = await _visitas.abasMaisUsadas(userId);
  if (!usos.length) return [];
  let perm = null;
  if (papel !== 'admin') perm = await new Promise((ok) => getTabPermissions((err, m) => ok(err ? null : (m[papel] || []))));
  const pode = (aba) => {
    const chave = (ABAS[aba] || [])[1];
    if (!chave) return false;
    if (papel === 'admin') return true;
    if (chave === 'admin') return false;
    if (chave === 'nao-guest') return papel !== 'guest';
    return Array.isArray(perm) ? perm.includes(chave) : papel !== 'guest' || chave === 'dashboard';
  };
  return usos.filter((u) => pode(u.aba)).slice(0, 4).map((u) => ({ aba: u.aba, rotulo: ABAS[u.aba][0], vezes: u.n }));
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const pct1 = (n) => String(n).replace('.', ',');
function dicasDe({ meu, equipe, desde }) {
  const d = [];
  if (meu && meu.vencemHoje > 0) d.push(`${plural(meu.vencemHoje, 'chamado seu vence', 'chamados seus vencem')} hoje`);
  if (meu && meu.vencidos > 0) d.push(`${plural(meu.vencidos, 'chamado seu já passou', 'chamados seus já passaram')} da meta`);
  if (desde && desde.vencidosNovos > 0) d.push(`${plural(desde.vencidosNovos, 'chamado da equipe venceu', 'chamados da equipe venceram')} desde a sua última visita`);
  if (equipe && equipe.baseSlaMes >= 20 && equipe.slaMes != null && equipe.slaMesAnterior != null && equipe.slaMes !== equipe.slaMesAnterior) {
    const dif = Math.round((equipe.slaMes - equipe.slaMesAnterior) * 10) / 10;
    d.push(`O SLA da equipe está ${pct1(Math.abs(dif))} pp ${dif > 0 ? 'acima' : 'abaixo'} do mês passado (${pct1(equipe.slaMes)}% contra ${pct1(equipe.slaMesAnterior)}%)`);
  }
  if (meu && meu.resolvidosMes > 0) d.push(`Você resolveu ${plural(meu.resolvidosMes, 'chamado', 'chamados')} este mês`);
  if (equipe && (equipe.entraramHoje || equipe.fecharamHoje)) d.push(`Hoje a equipe recebeu ${equipe.entraramHoje} e fechou ${equipe.fecharamHoje}`);
  return d.slice(0, 3);
}

router.get('/', authMiddleware, async (req, res) => {
  const t0 = Date.now();
  try {
    const agoraMs = Date.now();
    const userId = req.user.id;
    const u = (await db.query(`SELECT u.name, u.email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0] || {};
    const esc = await escopoVertical(userId);
    const papel = esc.papel || u.role || null;
    const temVertical = esc.verticais.length > 0, podeVerHub = !esc.filtrar;
    const usarHub = !temVertical || (String(req.query.escopo || '') === 'hub' && podeVerHub);
    const alvos = usarHub ? null : alvosDe(esc);
    const verticais = esc.vertical ? esc.vertical.split(', ') : [];
    const secao = async (nome, fn) => { try { return await fn(); } catch (e) { console.warn(`[inicio] seção ${nome} falhou:`, e.message); return null; } };

    const visita = await secao('visita', () => calcularVisita(userId, agoraMs)) || { primeira: true, anterior: null, anteriorMs: null, diasDesde: null, sequencia: 1, ultimaAba: null };
    const G = await secao('base', () => globais(agoraMs));
    const meuR = G ? await secao('meu', async () => resumoDele(G, u.email, agoraMs)) : null;
    const equipeR = G ? await secao('equipe', async () => resumoEquipe(G, esc, alvos)) : null;
    const meu = meuR ? meuR.resumo : null;

    // saudação do dia: começa já (só precisa da fila dele) e roda junto com atalhos e "desde a última visita".
    // Nunca derruba a tela: sem tabela/IA, usa o banco de frases só em memória.
    const cfg = G ? G.abertos.cfg : await lerConfigEmCache().catch(() => null);
    const feriado = cfg && (cfg.feriados || []).find((f) => f.data === diaDe(agoraMs + 86400000));
    const b = brt(agoraMs);
    const contexto = {
      dia: diaDe(agoraMs), dataBr: dataBr(agoraMs), periodo: periodoDe(agoraMs), dow: b.getUTCDay(), diaMes: b.getUTCDate(), mes: b.getUTCMonth() + 1,
      primeiroNome: primeiroNomeDe(u.name), primeira: visita.primeira, diasDesde: visita.diasDesde, sequencia: visita.sequencia, feriadoAmanha: feriado ? feriado.nome : null,
      vinculado: !!(meu && meu.vinculado), filaAbertos: meu ? meu.abertos : 0, filaVencidos: meu ? meu.vencidos : 0, vencemHoje: meu ? meu.vencemHoje : 0,
    };
    const pSaudacao = saudacao.obterSaudacao({ userId, userEmail: u.email, contexto }).catch((e) => {
      console.warn('[inicio] saudação do dia falhou, usando o banco em memória:', e.message);
      return { texto: saudacao.doBanco(contexto, new Set(), `${userId}:${contexto.dia}`), origem: 'banco' };
    });
    const [atalhos, desde] = await Promise.all([
      secao('atalhos', () => atalhosDe(userId, papel)),
      equipeR ? secao('desde', () => mudancas(u.email, esc, alvos, G, equipeR, agoraMs, visita.anteriorMs)) : null,
    ]);
    const equipe = equipeR ? { rotulo: usarHub ? 'Todas as verticais' : verticais.join(', '), escopo: usarHub ? 'hub' : 'equipe', ...equipeR.resumo } : null;
    const sd = await pSaudacao;

    res.json({
      geradoEm: new Date(agoraMs).toISOString(),
      usuario: { nome: u.name || '', primeiroNome: contexto.primeiroNome, papel, verticais, temVertical, podeVerHub },
      saudacao: { texto: sd.texto, periodo: contexto.periodo, dia: contexto.dia, origem: sd.origem },
      visita: { primeira: visita.primeira, anterior: visita.anterior, diasDesde: visita.diasDesde, sequencia: visita.sequencia, ultimaAba: visita.ultimaAba },
      meu, equipe, desdeUltimaVisita: desde, atalhos: atalhos || [], dicas: dicasDe({ meu, equipe, desde }),
      _ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[inicio] erro:', e.message);
    res.status(500).json({ error: 'Não foi possível montar a tela inicial agora.' });
  }
});

router._visitas = _visitas;   // só para testes
module.exports = router;
