'use strict';
// Núcleo do controle de horas (Política POL-SLA-001): leitura de configuração, apuração por cliente/competência e a ROTINA AUTOMÁTICA
// que lança as horas técnicas de crédito sozinha ao fim de cada mês. Usado por routes/slaHoras.js e por routes/geral.js (saldo).
const db = require('../db/remote');
const P = require('./slaPolitica');
const CF_CLASSIFICACAO = 23946;
const FECHADOS = `'Resolved','Closed','Resolvido','Fechado'`;

let _prontas = null;
function prepararTabelas() {
  if (!_prontas) _prontas = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS public.sla_cliente_plano (organizacao_id TEXT PRIMARY KEY, organizacao_nome TEXT, plano TEXT NOT NULL, observacao TEXT, atualizado_por TEXT, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS public.sla_credito (id BIGSERIAL PRIMARY KEY, organizacao_id TEXT NOT NULL, organizacao_nome TEXT, competencia TEXT, tipo TEXT NOT NULL,
      horas NUMERIC(8,2) NOT NULL, motivo TEXT, validade DATE, origem JSONB, criado_por TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_sla_credito_competencia ON public.sla_credito (organizacao_id, competencia) WHERE tipo = 'credito'`);
    await db.query(`CREATE INDEX IF NOT EXISTS ix_sla_credito_org ON public.sla_credito (organizacao_id, criado_em)`);
  })().catch((e) => { _prontas = null; throw e; });
  return _prontas;
}

// ── configuração ───────────────────────────────────────────────────────────
async function lerConfig() {
  const r = await db.query(`SELECT value FROM config WHERE key = 'sla_politica'`).catch(() => ({ rows: [] }));
  let salvo = null; try { salvo = r.rows[0] ? JSON.parse(r.rows[0].value) : null; } catch (_) { /* usa o padrão */ }
  return P.normalizar(salvo);
}
// Mesma configuração com cache de 1 min, para quem calcula SLA a cada requisição (Painel Geral, SLA por chamado).
let _cfgCache = null, _cfgCacheEm = 0;
async function lerConfigEmCache() {
  if (!_cfgCache || Date.now() - _cfgCacheEm > 60 * 1000) { _cfgCache = await lerConfig(); _cfgCacheEm = Date.now(); }
  return _cfgCache;
}
// ── apuração mensal ──────────────────────────────────────────────────────────
const ehAgente = (a) => a.is_public && (['1', '3'].includes(String(a.criado_por_profile_type)) || (a.criado_por_profile_type == null && /@viasoft\.com\.br$/i.test(a.criado_por_email || '')));
async function carregarChamados(competencia, cfg) {
  const [ano, mes] = competencia.split('-').map(Number);
  const ini = `${competencia}-01T00:00:00-03:00`;
  const prox = mes === 12 ? `${ano + 1}-01` : `${ano}-${String(mes + 1).padStart(2, '0')}`;
  const fim = `${prox}-01T00:00:00-03:00`;
  const tk = (await db.query(`
    SELECT t.ticket_id::text AS id, t.subject, t.createddate AS criado_em, COALESCE(t.resolved_in, t.closed_in) AS encerrado_em, t.urgency AS urgencia,
           o.organizacao_id, COALESCE(NULLIF(btrim(o.organizacao_nome), ''), 'Sem organização') AS organizacao_nome
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
      LEFT JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id
     WHERE translate(lower(cf.valor_texto), 'éèêáàâãíóôõúç', 'eeeaaaaiooouc') = 'suporte tecnico'
       AND t.basestatus IN (${FECHADOS}) AND COALESCE(t.resolved_in, t.closed_in) >= $1::timestamptz AND COALESCE(t.resolved_in, t.closed_in) < $2::timestamptz`, [ini, fim])).rows;
  const ids = tk.map((t) => t.id);
  const acoes = new Map();
  for (let i = 0; i < ids.length; i += 3000) {
    const r = await db.query(`SELECT ticket_id::text AS id, criado_em, status, is_public, criado_por_profile_type, criado_por_email, criado_por_nome
        FROM silver.ticket_acao WHERE ticket_id = ANY($1::bigint[]) ORDER BY criado_em`, [ids.slice(i, i + 3000)]);
    for (const a of r.rows) { if (!acoes.has(a.id)) acoes.set(a.id, []); acoes.get(a.id).push(a); }
  }
  // Nomes dos clientes de cada chamado: serve para reconhecer, nas ações antigas SEM perfil/e-mail do autor, quem é da equipe.
  const clientes = new Map();
  for (let i = 0; i < ids.length; i += 3000) {
    const r = await db.query(`SELECT ticket_id::text AS id, nome FROM silver.ticket_cliente WHERE ticket_id = ANY($1::bigint[])`, [ids.slice(i, i + 3000)]).catch(() => ({ rows: [] }));
    for (const c of r.rows) { if (!clientes.has(c.id)) clientes.set(c.id, new Set()); if (c.nome) clientes.get(c.id).add(P.semAcento(c.nome)); }
  }
  const auto = new Set(cfg.autoresAutomaticos.map(P.semAcento));
  return tk.map((t) => {
    const lista = acoes.get(t.id) || [], nomesCli = clientes.get(t.id) || new Set();
    const abertura = new Date(t.criado_em);
    const publicas = lista.filter((a) => a.is_public);
    // Agente confirmado: perfil 1/3 ou e-mail @viasoft. Sem perfil nem e-mail (ações antigas): estimado pelo nome (não é um dos clientes do chamado).
    const classe = (a) => (ehAgente(a) ? 'perfil' : (a.is_public && a.criado_por_profile_type == null && !a.criado_por_email && a.criado_por_nome && !nomesCli.has(P.semAcento(a.criado_por_nome)) ? 'estimado' : null));
    const candidatas = lista.filter((a) => classe(a) && new Date(a.criado_em) > abertura);
    const humanas = candidatas.filter((a) => !auto.has(P.semAcento(a.criado_por_nome)));
    const pr = humanas[0] || null;
    let motivo = null;
    if (!pr) motivo = !lista.length ? 'sem ações gravadas no banco para este chamado' : !publicas.length ? 'só há notas internas (nenhuma ação pública)'
      : candidatas.length ? 'só há respostas de autores automáticos' : 'nenhuma resposta pública de agente identificada (autor sem perfil ou só ações do cliente)';
    return { ...t, eventos: lista.filter((a) => a.status).map((a) => ({ em: a.criado_em, status: a.status })), primeiraRespostaEm: pr ? pr.criado_em : null,
      prOrigem: pr ? classe(pr) : null, prMotivo: motivo, prPor: pr ? pr.criado_por_nome : null };
  });
}
async function planosMap() {
  return new Map((await db.query(`SELECT organizacao_id, plano FROM public.sla_cliente_plano`)).rows.map((r) => [r.organizacao_id, r.plano]));
}
const compOk = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''));
async function apurar(competencia, cfg) {
  const [chamados, planos] = await Promise.all([carregarChamados(competencia, cfg), planosMap()]);
  const por = new Map();
  for (const c of chamados) {
    const chave = c.organizacao_id || `sem:${c.organizacao_nome}`;
    if (!por.has(chave)) por.set(chave, { organizacao_id: c.organizacao_id || null, nome: c.organizacao_nome, plano: planos.get(c.organizacao_id) || cfg.planoPadrao, planoDefinido: planos.has(c.organizacao_id), itens: [] });
    const g = por.get(chave);
    g.itens.push({ c, av: P.avaliarChamado({ criadoEm: c.criado_em, resolvidoEm: c.encerrado_em, urgencia: c.urgencia, eventos: c.eventos, primeiraRespostaEm: c.primeiraRespostaEm, contornoEm: null }, g.plano, cfg) });
  }
  const clientes = [...por.values()].map((g) => ({ organizacao_id: g.organizacao_id, nome: g.nome, plano: g.plano, planoDefinido: g.planoDefinido, ...P.apurarCliente(g.itens.map((i) => i.av), cfg), _itens: g.itens }))
    .sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));
  return { competencia, clientes, chamados: chamados.length };
}


// ── Reparo dos autores das ações ──────────────────────────────────────────────────
// Ações gravadas sem o autor (nome, e-mail e perfil nulos) impedem saber quem respondeu primeiro. Este reparo reconsulta no Movidesk
// (mesma gravação da carga, com createdBy) os chamados de Suporte Técnico encerrados na competência que têm ação pública sem autor.
// Roda sozinho antes de cada apuração (até `limite` chamados por rodada) e também pode ser disparado pela tela.
const _tentados = new Set();   // chamados já reconsultados neste processo (evita insistir quando o Movidesk também não informa o autor)
const _reparo = { rodando: false, competencia: null, total: 0, feitos: 0, falhas: 0, em: null };
async function idsSemAutor(competencia, limite) {
  const [ano, mes] = competencia.split('-').map(Number);
  const ini = `${competencia}-01T00:00:00-03:00`, fim = `${mes === 12 ? ano + 1 : ano}-${String(mes === 12 ? 1 : mes + 1).padStart(2, '0')}-01T00:00:00-03:00`;
  const r = await db.query(`
    SELECT t.ticket_id::text AS id FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
     WHERE translate(lower(cf.valor_texto), 'éèêáàâãíóôõúç', 'eeeaaaaiooouc') = 'suporte tecnico'
       AND t.basestatus IN (${FECHADOS}) AND COALESCE(t.resolved_in, t.closed_in) >= $1::timestamptz AND COALESCE(t.resolved_in, t.closed_in) < $2::timestamptz
       AND EXISTS (SELECT 1 FROM silver.ticket_acao a WHERE a.ticket_id = t.ticket_id AND a.is_public
                    AND a.criado_por_profile_type IS NULL AND a.criado_por_email IS NULL AND a.criado_por_nome IS NULL)
     ORDER BY t.ticket_id DESC LIMIT $3`, [ini, fim, limite + _tentados.size]);
  return r.rows.map((x) => x.id).filter((id) => !_tentados.has(id)).slice(0, limite);
}
async function repararAutores(competencia, { limite = 1500, paralelo = 5 } = {}) {
  if (_reparo.rodando) return { ignorado: 'já existe um reparo em andamento', ..._reparo };
  _reparo.rodando = true; Object.assign(_reparo, { competencia, total: 0, feitos: 0, falhas: 0, em: new Date().toISOString() });
  try {
    const ids = await idsSemAutor(competencia, limite);
    _reparo.total = ids.length;
    if (!ids.length) return { ..._reparo };
    const loader = require('../scripts/movidesk-loader');
    let i = 0;
    const trab = async () => {
      while (i < ids.length) {
        const id = ids[i++]; _tentados.add(id);
        try { await loader.sincronizarTicket(id); } catch (e) { _reparo.falhas++; }
        _reparo.feitos++;
      }
    };
    await Promise.all(Array.from({ length: paralelo }, trab));
    return { ..._reparo };
  } finally { _reparo.rodando = false; }
}
const estadoReparo = () => ({ ..._reparo });

// ── Lançamento AUTOMÁTICO das horas técnicas ─────────────────────────────────────────
// Para cada cliente, percorre os meses já encerrados (a partir de cfg.automatico.desde) em ordem. Cada mês com chamados avaliados entra numa
// "bolsa"; quando a bolsa chega a cfg.minimoElegiveis chamados avaliados, ou completa 3 competências (Seção 20.5), a apuração é fechada:
// o crédito vai para a competência mais recente e as anteriores ficam registradas com 0 h ("acumulada"). Idempotente: o índice único
// (cliente, competência) impede lançar duas vezes, então pode rodar quantas vezes quiser.
const mesIdx = (c) => { const [a, m] = c.split('-').map(Number); return a * 12 + (m - 1); };
const mesDe = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
const primeiroDiaSeguinte = (comp) => { const i = mesIdx(comp) + 1; return `${mesDe(i)}-01`; };
const competenciasEncerradas = (desde) => {
  const atual = mesIdx(new Date().toISOString().slice(0, 7)), ini = Math.max(mesIdx(desde), atual - 12), out = [];
  for (let i = ini; i < atual; i++) out.push(mesDe(i));
  return out;
};
let _rodando = false;
async function processarCompetencias({ por = 'automático', forcar = false } = {}) {
  if (_rodando) return { ignorado: 'já existe uma apuração em andamento' };
  _rodando = true;
  try {
    await prepararTabelas();
    const cfg = await lerConfig();
    if (!cfg.automatico.ativo && !forcar) return { ignorado: 'lançamento automático desligado' };
    const comps = competenciasEncerradas(cfg.automatico.desde);
    const feitos = (await db.query(`SELECT organizacao_id, competencia FROM public.sla_credito WHERE tipo = 'credito'`)).rows;
    const jaTem = new Set(feitos.map((x) => `${x.organizacao_id}|${x.competencia}`));
    const bolsas = new Map();   // organizacao_id -> { nome, plano, meses: [{ comp, av:[] }] }
    const resumo = { competencias: comps, lancados: [], acumulando: [], semCredito: 0 };
    for (const comp of comps) {
      await repararAutores(comp).catch((e) => console.warn('[sla-horas] reparo de autores ignorado:', e.message));   // Primeira Resposta depende de saber quem respondeu
      const ap = await apurar(comp, cfg);
      for (const cl of ap.clientes) {
        if (!cl.organizacao_id) continue;
        const id = cl.organizacao_id;
        if (jaTem.has(`${id}|${comp}`)) { bolsas.delete(id); continue; }   // já apurado (manual ou rodada anterior)
        const av = cl._itens.map((i) => i.av).filter((a) => a.dentro !== null);
        if (!av.length) continue;
        const b = bolsas.get(id) || { nome: cl.nome, plano: cl.plano, meses: [] };
        b.nome = cl.nome; b.plano = cl.plano; b.meses.push({ comp, av }); bolsas.set(id, b);
        const total = b.meses.reduce((n, m) => n + m.av.length, 0);
        const span = mesIdx(comp) - mesIdx(b.meses[0].comp) + 1;
        if (total < cfg.minimoElegiveis && span < 3) continue;           // continua acumulando
        const ult = apurarBolsa(b, cfg);
        const origem = JSON.stringify({ meses: b.meses.map((m) => m.comp), pct: ult.pct, avaliados: ult.avaliados, dentro: ult.dentro, plano: b.plano, gatilho: ult.gatilhoCritico });
        const validade = ult.creditoSugerido > 0 ? P.somaMeses(primeiroDiaSeguinte(comp), cfg.validadeMeses) : null;
        for (const m of b.meses.slice(0, -1)) {
          await db.query(`INSERT INTO public.sla_credito (organizacao_id, organizacao_nome, competencia, tipo, horas, motivo, origem, criado_por) VALUES ($1,$2,$3,'credito',0,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [id, b.nome, m.comp, `Apuração acumulada e fechada em ${comp}`, origem, por]);
        }
        const motivo = ult.pct == null ? 'Sem chamados avaliados' : `Cumprimento global ${ult.pct.toFixed(2)}% (${ult.dentro}/${ult.avaliados})${b.meses.length > 1 ? ` acumulado em ${b.meses.length} competências` : ''}${ult.gatilhoCritico ? ' · gatilho de chamado Crítico' : ''}`;
        const ins = await db.query(`INSERT INTO public.sla_credito (organizacao_id, organizacao_nome, competencia, tipo, horas, motivo, validade, origem, criado_por)
          VALUES ($1,$2,$3,'credito',$4,$5,$6::date,$7,$8) ON CONFLICT DO NOTHING RETURNING id`, [id, b.nome, comp, ult.creditoSugerido, motivo, validade, origem, por]);
        for (const m of b.meses) jaTem.add(`${id}|${m.comp}`);
        if (ins.rows.length) { if (ult.creditoSugerido > 0) resumo.lancados.push({ nome: b.nome, competencia: comp, horas: ult.creditoSugerido }); else resumo.semCredito++; }
        bolsas.delete(id);
      }
    }
    for (const [, b] of bolsas) resumo.acumulando.push({ nome: b.nome, meses: b.meses.map((m) => m.comp), avaliados: b.meses.reduce((n, m) => n + m.av.length, 0) });
    await gravarStatus({ em: new Date().toISOString(), por, ok: true, ...resumo, acumulando: resumo.acumulando.length, lancados: resumo.lancados.length, detalhesLancados: resumo.lancados.slice(0, 30) });
    if (resumo.lancados.length) console.log(`[sla-horas] ${por}: ${resumo.lancados.length} crédito(s) de horas técnicas lançado(s)`);
    return resumo;
  } catch (e) {
    console.error('[sla-horas] apuração automática falhou:', e.message);
    await gravarStatus({ em: new Date().toISOString(), por, ok: false, erro: e.message }).catch(() => {});
    throw e;
  } finally { _rodando = false; }
}
function apurarBolsa(b, cfg) { return P.apurarCliente(b.meses.flatMap((m) => m.av), cfg); }
async function gravarStatus(st) {
  await db.query(`INSERT INTO config (key, value) VALUES ('sla_horas_auto_status', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(st)]);
}
async function lerStatus() {
  const r = await db.query(`SELECT value FROM config WHERE key = 'sla_horas_auto_status'`).catch(() => ({ rows: [] }));
  try { return r.rows[0] ? JSON.parse(r.rows[0].value) : null; } catch (_) { return null; }
}
// Roda ao subir o servidor e depois a cada hora (as contas só mudam quando um mês fecha; o resto é idempotente).
let _timer = null;
function iniciarAutomatico() {
  if (_timer) return;
  const rodar = () => processarCompetencias().catch(() => {});
  setTimeout(rodar, 2 * 60 * 1000);
  _timer = setInterval(rodar, 60 * 60 * 1000);
  if (_timer.unref) _timer.unref();
}
// Saldo de horas técnicas de todos os clientes: Map(organizacao_id -> saldo). Cache curto: o Painel Geral chama a cada abertura.
let _saldosCache = { em: 0, valor: null };
async function saldosPorCliente() {
  if (_saldosCache.valor && Date.now() - _saldosCache.em < 60 * 1000) return _saldosCache.valor;
  await prepararTabelas();
  const rows = (await db.query(`SELECT organizacao_id, competencia, tipo, horas::float AS horas, criado_em, validade FROM public.sla_credito ORDER BY criado_em`)).rows;
  const por = new Map();
  for (const l of rows) { if (!por.has(l.organizacao_id)) por.set(l.organizacao_id, []); por.get(l.organizacao_id).push(l); }
  const out = {};
  for (const [id, l] of por) {
    // últimos créditos concedidos (com horas), do mais novo para o mais antigo — para mostrar de onde veio o saldo
    const creditos = l.filter((x) => x.tipo === 'credito' && Number(x.horas) > 0).sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em)).slice(0, 4)
      .map((x) => ({ competencia: x.competencia || null, horas: Number(x.horas), validade: x.validade ? new Date(x.validade).toISOString().slice(0, 10) : null }));
    out[id] = { ...P.saldoExtrato(l), creditos };
  }
  _saldosCache = { em: Date.now(), valor: out };
  return out;
}
const invalidarSaldos = () => { _saldosCache = { em: 0, valor: null }; };
module.exports = { repararAutores, estadoReparo, prepararTabelas, lerConfig, lerConfigEmCache, apurar, compOk, processarCompetencias, iniciarAutomatico, saldosPorCliente, invalidarSaldos, lerStatus, primeiroDiaSeguinte };
