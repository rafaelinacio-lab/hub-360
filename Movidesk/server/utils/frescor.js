'use strict';
/**
 * "Última atualização" de cada painel: quando os DADOS daquela aba foram atualizados de verdade
 * (não quando o navegador os buscou). GET /api/frescor/:aba → { atualizadoEm, fonte }.
 *
 *  - abas de chamados: fim da última carga concluída (silver.carga_log) que alimenta aquela aba;
 *  - Jira: data de gravação dos JSONs do extrator;
 *  - Incidentes / Melhorias / Reincidências: última gravação nas tabelas do próprio Hub.
 */
const fs = require('fs');
const path = require('path');
const db = require('../db/remote');

const CACHE_MS = 30 * 1000;
const cache = new Map();   // aba -> { em, valor }

// Cargas que só regravam partes do banco (correções) não contam como "dados atualizados".
const MODOS_FORA = ['backfill-basico', 'atualizacao-inteligente'];
// Cada aba lê chamados de um recorte; ouvidoria e gcc têm carga própria, o resto é alimentado pelas demais cargas.
const MODOS_TODOS = ['full', 'full-anos', 'incremental', 'geral'];

function rotuloModo(m) {
  const mapa = { full: 'carga completa', 'full-anos': 'carga completa por ano', incremental: 'carga incremental', geral: 'carga do Painel Geral', ouvidoria: 'carga da Ouvidoria', gcc: 'carga do GCC' };
  if (mapa[m]) return mapa[m];
  return /^rapido:/.test(m || '') ? 'carga rápida de pendentes' : `carga "${m}"`;
}

async function ultimaCarga(filtroModo, params = []) {
  const r = await db.query(
    `SELECT mode, finished_at FROM silver.carga_log
     WHERE status = 'done' AND finished_at IS NOT NULL AND mode NOT LIKE 'fix-%' AND mode <> ALL($1::text[]) ${filtroModo}
     ORDER BY finished_at DESC LIMIT 1`, [MODOS_FORA, ...params]);
  const x = r.rows[0];
  return x ? { atualizadoEm: x.finished_at, fonte: `Movidesk — ${rotuloModo(x.mode)}` } : { atualizadoEm: null, fonte: 'Movidesk — nenhuma carga concluída' };
}

async function jira() {
  const dir = path.resolve(__dirname, '../../', process.env.JIRA_DATA_DIR || '../Jira');
  let maior = 0;
  for (const f of ['dashboard_data.json', 'tdc_data.json', 'abertos_data.json', 'fechados_data.json', 'sprint_data.json', 'issues_raw.json', 'qualidade_data.json']) {
    try { maior = Math.max(maior, fs.statSync(path.join(dir, f)).mtimeMs); } catch (_) { /* arquivo ainda não gerado */ }
  }
  return { atualizadoEm: maior ? new Date(maior) : null, fonte: 'Jira — extrator (arquivos gerados)' };
}

async function unico(sql, fonte) {
  const v = (await db.query(sql)).rows[0]?.t || null;
  return { atualizadoEm: v, fonte };
}

const FONTES = {
  dashboard:     () => ultimaCarga(`AND mode NOT IN ('ouvidoria','gcc')`),
  geral:         () => ultimaCarga(`AND mode NOT IN ('ouvidoria','gcc')`),
  'painel-tv':   () => ultimaCarga(`AND mode NOT IN ('ouvidoria','gcc')`),
  curadoria:     () => ultimaCarga(`AND mode NOT IN ('ouvidoria','gcc')`),
  satisfacao:    () => ultimaCarga(`AND mode NOT IN ('ouvidoria','gcc')`),
  ouvidoria:     () => ultimaCarga(`AND (mode = 'ouvidoria' OR mode = ANY($2::text[]))`, [MODOS_TODOS]),
  gcc:           () => ultimaCarga(`AND (mode = 'gcc' OR mode = ANY($2::text[]))`, [MODOS_TODOS]),
  jira,
  incidentes:    () => unico(`SELECT GREATEST((SELECT MAX(atualizado_em) FROM public.incidente), (SELECT MAX(criado_em) FROM public.incidente_evento)) AS t`, 'Hub — última alteração em incidentes'),
  melhorias:     () => unico(`SELECT MAX(atualizado_em) AS t FROM public.melhoria`, 'Hub — última alteração em melhorias'),
  reincidencias: () => unico(`SELECT GREATEST((SELECT MAX(analisado_em) FROM public.reincidencia_par), (SELECT MAX(criado_em) FROM public.reincidencia_analise)) AS t`, 'Hub — última análise de reincidências'),
};

async function frescor(aba) {
  const f = FONTES[aba];
  if (!f) return null;
  const c = cache.get(aba);
  if (c && Date.now() - c.em < CACHE_MS) return c.valor;
  let valor;
  try {
    const r = await f();
    valor = { atualizadoEm: r.atualizadoEm ? new Date(r.atualizadoEm).toISOString() : null, fonte: r.fonte };
  } catch (e) {
    // tabela ainda não criada (primeiro uso) etc.: sem data em vez de erro na tela
    valor = { atualizadoEm: null, fonte: 'sem registro de atualização' };
  }
  cache.set(aba, { em: Date.now(), valor });
  return valor;
}

module.exports = { frescor, ABAS: Object.keys(FONTES) };
