'use strict';
// Configurações do assistente de IA (Central do chamado e Incidentes), editadas em Configurações → Assistente de IA.
// Ficam num único JSON na tabela `config` (chave `ai_assist_settings`). Tudo é validado e limitado aqui,
// no servidor: o navegador nunca decide o modelo, os limites de tokens ou o que vai para a OpenAI.
const db = require('../db/remote');

const CHAVE = 'ai_assist_settings';
const MODELOS = {
  'gpt-4o-mini': 'GPT-4o mini — rápido e econômico (recomendado)',
  'gpt-4.1-mini': 'GPT-4.1 mini — mais capaz, ainda econômico',
  'gpt-4o': 'GPT-4o — mais preciso, custo maior',
  'gpt-4.1': 'GPT-4.1 — o mais preciso, custo maior',
};
const CRIATIVIDADE = { baixa: 0.2, media: 0.4, alta: 0.7 };   // "Mais fiel" · "Equilibrado" · "Mais criativo"
const TAMANHO_RESPOSTA = { curta: 500, media: 900, longa: 1500 };
const TONS = ['padrao', 'empatico', 'objetivo'];

const PADRAO = {
  geral: { modelo: process.env.AI_ASSIST_MODEL || 'gpt-4o-mini', diretrizes: '', limiteChamadosPor10min: 40, limiteIncidentesPor10min: 30 },
  resposta: { ativo: true, tomPadrao: 'padrao', criatividade: 'media', tamanho: 'media', maxPerguntas: 3, contextoCaracteres: 12000, instrucaoExtra: '' },
  corrigir: { ativo: true, maxCaracteres: 8000, instrucaoExtra: '' },
  cliente: { ativo: true, janelaDias: 90, mesesHistorico: 12, termosGcc: 'gcc, churn', contextoCaracteres: 9000, criatividade: 'baixa', instrucaoExtra: '' },
  incidenteResumo: { ativo: true, maxHipoteses: 3, maxPassos: 5, maxRiscos: 3, chamadosNoContexto: 60, eventosNoContexto: 40, usarMetas: true, criatividade: 'baixa', instrucaoExtra: '' },
  reincidencia: { ativo: true, diasPadrao: 30, maxTickets: 80, minClientesSistemico: 3, autoHoras: 24, criatividade: 'baixa', instrucaoExtra: '', promptBase: '' },
  incidentePosmortem: { ativo: true, maxPorques: 5, maxAcoes: 6, criatividade: 'baixa', instrucaoExtra: '' },
  incidenteComunicado: { ativo: true, publicoPadrao: 'clientes', tipoPadrao: 'atualizacao', palavrasClientes: 120, palavrasEquipe: 180, estilo: 'simples', criatividade: 'media', instrucaoExtra: '' },
};

const num = (v, min, max, pad) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : pad; };
const txt = (v, max, pad = '') => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : pad);
const esc = (v, lista, pad) => (lista.includes(v) ? v : pad);
const bool = (v, pad) => (typeof v === 'boolean' ? v : pad);

// Aceita um objeto parcial e devolve sempre um objeto completo e válido.
function normalizar(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const g = e.geral || {}, r = e.resposta || {}, c = e.corrigir || {}, cl = e.cliente || {}, ir = e.incidenteResumo || {}, ip = e.incidentePosmortem || {}, rc = e.reincidencia || {}, ic = e.incidenteComunicado || {};
  const P = PADRAO;
  const cri = (v, pad) => esc(v, Object.keys(CRIATIVIDADE), pad);
  return {
    geral: {
      modelo: esc(g.modelo, Object.keys(MODELOS), P.geral.modelo in MODELOS ? P.geral.modelo : 'gpt-4o-mini'),
      diretrizes: txt(g.diretrizes, 1500),
      limiteChamadosPor10min: num(g.limiteChamadosPor10min, 5, 300, P.geral.limiteChamadosPor10min),
      limiteIncidentesPor10min: num(g.limiteIncidentesPor10min, 5, 300, P.geral.limiteIncidentesPor10min),
    },
    resposta: {
      ativo: bool(r.ativo, P.resposta.ativo), tomPadrao: esc(r.tomPadrao, TONS, P.resposta.tomPadrao),
      criatividade: cri(r.criatividade, P.resposta.criatividade), tamanho: esc(r.tamanho, Object.keys(TAMANHO_RESPOSTA), P.resposta.tamanho),
      maxPerguntas: num(r.maxPerguntas, 0, 6, P.resposta.maxPerguntas), contextoCaracteres: num(r.contextoCaracteres, 3000, 30000, P.resposta.contextoCaracteres),
      instrucaoExtra: txt(r.instrucaoExtra, 800),
    },
    corrigir: { ativo: bool(c.ativo, P.corrigir.ativo), maxCaracteres: num(c.maxCaracteres, 500, 12000, P.corrigir.maxCaracteres), instrucaoExtra: txt(c.instrucaoExtra, 800) },
    cliente: {
      ativo: bool(cl.ativo, P.cliente.ativo), janelaDias: esc(Number(cl.janelaDias), [30, 90, 180, 365], P.cliente.janelaDias),
      mesesHistorico: esc(Number(cl.mesesHistorico), [3, 6, 12, 24], P.cliente.mesesHistorico),
      termosGcc: txt(cl.termosGcc, 200, P.cliente.termosGcc).split(/[,;\n]/).map((s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '')).filter(Boolean).slice(0, 8).join(', '),
      contextoCaracteres: num(cl.contextoCaracteres, 3000, 30000, P.cliente.contextoCaracteres),
      criatividade: cri(cl.criatividade, P.cliente.criatividade), instrucaoExtra: txt(cl.instrucaoExtra, 800),
    },
    incidenteResumo: {
      ativo: bool(ir.ativo, P.incidenteResumo.ativo), maxHipoteses: num(ir.maxHipoteses, 0, 5, P.incidenteResumo.maxHipoteses),
      maxPassos: num(ir.maxPassos, 1, 8, P.incidenteResumo.maxPassos), maxRiscos: num(ir.maxRiscos, 0, 5, P.incidenteResumo.maxRiscos),
      chamadosNoContexto: num(ir.chamadosNoContexto, 10, 200, P.incidenteResumo.chamadosNoContexto), eventosNoContexto: num(ir.eventosNoContexto, 10, 100, P.incidenteResumo.eventosNoContexto),
      usarMetas: bool(ir.usarMetas, P.incidenteResumo.usarMetas), criatividade: cri(ir.criatividade, P.incidenteResumo.criatividade), instrucaoExtra: txt(ir.instrucaoExtra, 800),
    },
    reincidencia: {
      ativo: bool(rc.ativo, P.reincidencia.ativo), diasPadrao: esc(Number(rc.diasPadrao), [7, 15, 30, 60, 90], P.reincidencia.diasPadrao),
      maxTickets: num(rc.maxTickets, 20, 150, P.reincidencia.maxTickets), minClientesSistemico: num(rc.minClientesSistemico, 2, 10, P.reincidencia.minClientesSistemico),
      autoHoras: esc(Number(rc.autoHoras), [0, 6, 12, 24, 48], P.reincidencia.autoHoras),
      criatividade: cri(rc.criatividade, P.reincidencia.criatividade), instrucaoExtra: txt(rc.instrucaoExtra, 800), promptBase: txt(rc.promptBase, 14000),
    },
    incidentePosmortem: {
      ativo: bool(ip.ativo, P.incidentePosmortem.ativo), maxPorques: num(ip.maxPorques, 1, 7, P.incidentePosmortem.maxPorques),
      maxAcoes: num(ip.maxAcoes, 1, 12, P.incidentePosmortem.maxAcoes), criatividade: cri(ip.criatividade, P.incidentePosmortem.criatividade), instrucaoExtra: txt(ip.instrucaoExtra, 800),
    },
    incidenteComunicado: {
      ativo: bool(ic.ativo, P.incidenteComunicado.ativo), publicoPadrao: esc(ic.publicoPadrao, ['clientes', 'interno'], P.incidenteComunicado.publicoPadrao),
      tipoPadrao: esc(ic.tipoPadrao, ['inicial', 'atualizacao', 'resolucao'], P.incidenteComunicado.tipoPadrao),
      palavrasClientes: num(ic.palavrasClientes, 40, 400, P.incidenteComunicado.palavrasClientes), palavrasEquipe: num(ic.palavrasEquipe, 40, 600, P.incidenteComunicado.palavrasEquipe),
      estilo: esc(ic.estilo, ['simples', 'formal'], P.incidenteComunicado.estilo), criatividade: cri(ic.criatividade, P.incidenteComunicado.criatividade), instrucaoExtra: txt(ic.instrucaoExtra, 800),
    },
  };
}

let cache = null, cacheAte = 0;
async function obter() {
  if (cache && Date.now() < cacheAte) return cache;
  let salvo = null;
  try {
    const row = await new Promise((ok, ko) => db.get('SELECT value FROM config WHERE key = ?', [CHAVE], (err, r) => (err ? ko(err) : ok(r))));
    if (row && row.value) salvo = JSON.parse(row.value);
  } catch { /* usa os padrões */ }
  cache = normalizar(salvo); cacheAte = Date.now() + 15000;
  return cache;
}

async function salvar(entrada) {
  const limpo = normalizar(entrada);
  await new Promise((ok, ko) => db.run(
    `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [CHAVE, JSON.stringify(limpo)], (err) => (err ? ko(err) : ok())));
  cache = limpo; cacheAte = Date.now() + 15000;
  return limpo;
}

// Trechos de prompt vindos das configurações (sempre como texto confiável da empresa, nunca dos chamados).
function diretrizes(S) { return S.geral.diretrizes ? `\nDiretrizes da empresa (confiáveis; siga sempre): ${S.geral.diretrizes}` : ''; }
function extra(txtExtra) { return txtExtra ? `\nOrientação adicional da empresa para esta tarefa (confiável): ${txtExtra}` : ''; }
const temperatura = (nivel) => CRIATIVIDADE[nivel] ?? 0.3;

module.exports = { PADRAO, MODELOS, CRIATIVIDADE, TAMANHO_RESPOSTA, TONS, normalizar, obter, salvar, diretrizes, extra, temperatura };
