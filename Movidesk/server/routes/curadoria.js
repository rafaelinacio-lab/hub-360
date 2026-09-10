const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { decryptToken } = require('../utils/crypto');
const datalake = require('../utils/datalakeClient');
const {
  getToken, getCuradoriaPromptAnalise, getCuradoriaQueryConfig,
  getCuradoriaMovideskConfig, sanitizeRawWhere,
  getCuradoriaSlaThresholds, getCuradoriaPromptSlaEstouro,
  requireTabAccess
} = require('./config');

const CURADORIA_COLUMNS = [
  'ticket_id',
  'servico',
  'owner',
  'status',
  'urgencia',
  'processado',
  'actions',
  'solicitante',
  'perfil_cliente',
  'resumo',
  'organizacao',
  'convertido',
  'analise_fato',
  'causa',
  'acao',
  'fato',
  'modulo_x_rotina',
  'equipe',
  'urgencia_sugerida',
  'performance_suporte',
  'owner_team',
  'total_acoes',
  'total_cliente',
  'total_agente',
  'tempo_resol_dias',
  'tempo_resol_h_uteis',
  'tempo_resp_owner',
  'tabela_acoes',
  'comportamento_cliente',
  'perfil_cliente_descricao',
  'padrao_suporte',
  'dinamica_conversa',
  'pontos_criticos',
  'conclusao',
  'evidencias_urgencia',
  'cliente_nao_fez',
  'impacto_real',
  'nota_urgencia',
  'nota_urgencia_descricao',
  'justificativa_urgencia',
  'recomendacao_atendente',
  'sentimento',
  'satisfacao',
  'alertas',
  'causa_normalizada',
  'modulo_rotina_normalizado',
  'fato_palavras_chave',
  'fato_categoria_principal',
  'relacao_fato_causa',
  'impacto_inferido',
  'par_agrupamento',
  'diagnostico_raw',
  'analise_completa',
  'processado_em',
  'competencias',
  'sla_estouro',
  'aberto_em',
  'resolvido_em',
  'satisfacao_pesquisa',
  'satisfacao_pesquisa_comentario',
  'satisfacao_pesquisa_respondido_em',
  'satisfacao_pesquisa_verificado_em'
];

const NUMERIC_COLUMNS = new Set([
  'ticket_id',
  'processado',
  'convertido',
  'total_acoes',
  'total_cliente',
  'total_agente',
  'tempo_resol_dias',
  'tempo_resol_h_uteis',
  'satisfacao_pesquisa',
  'nota_urgencia',
  'satisfacao'
]);

function normalizeCuradoriaRow(row = {}) {
  const normalized = {};

  CURADORIA_COLUMNS.forEach((column) => {
    const value = row[column];
    if (value === undefined || value === null) {
      normalized[column] = NUMERIC_COLUMNS.has(column) ? null : '';
      return;
    }
    normalized[column] = value;
  });

  return normalized;
}

function getCuradoriaQueryConfigPromise() {
  return new Promise((resolve, reject) => {
    getCuradoriaQueryConfig((err, config) => err ? reject(err) : resolve(config));
  });
}

function getCuradoriaMovideskConfigPromise() {
  return new Promise((resolve, reject) => {
    getCuradoriaMovideskConfig((err, config) => err ? reject(err) : resolve(config));
  });
}

function getCuradoriaPromptAnalisePromise() {
  return new Promise((resolve, reject) => {
    getCuradoriaPromptAnalise((err, config) => err ? reject(err) : resolve(config));
  });
}

function getCuradoriaSlaThresholdsPromise() {
  return new Promise((resolve, reject) => {
    getCuradoriaSlaThresholds((err, config) => err ? reject(err) : resolve(config));
  });
}

function getCuradoriaPromptSlaEstouroPromise() {
  return new Promise((resolve, reject) => {
    getCuradoriaPromptSlaEstouro((err, template) => err ? reject(err) : resolve(template));
  });
}

// Monta a cláusula WHERE de uma query de curadoria a partir da config (modo guiado ou avançado/raw).
// `sanitizeRawWhere` já foi aplicado no momento de salvar a config — reaplicar aqui é defesa em
// profundidade contra um valor gravado diretamente no banco por fora da rota de salvar.
function buildCuradoriaWhereClause(queryCfg, defaultGuidedWhere) {
  if (queryCfg.mode === 'raw' && queryCfg.rawWhere) {
    return `(${sanitizeRawWhere(queryCfg.rawWhere)})`;
  }
  return defaultGuidedWhere;
}

let competenciasColumnReady = null;
function ensureCompetenciasColumn() {
  if (!competenciasColumnReady) {
    competenciasColumnReady = db.queryDatabase(
      'movidesk_curadoria',
      `ALTER TABLE public.curadoria_chamados ADD COLUMN IF NOT EXISTS competencias JSONB`
    ).catch((err) => {
      competenciasColumnReady = null; // permite tentar novamente na próxima chamada
      throw err;
    });
  }
  return competenciasColumnReady;
}

let slaEstouroColumnReady = null;
function ensureSlaEstouroColumn() {
  if (!slaEstouroColumnReady) {
    slaEstouroColumnReady = db.queryDatabase(
      'movidesk_curadoria',
      `ALTER TABLE public.curadoria_chamados ADD COLUMN IF NOT EXISTS sla_estouro JSONB`
    ).catch((err) => {
      slaEstouroColumnReady = null; // permite tentar novamente na próxima chamada
      throw err;
    });
  }
  return slaEstouroColumnReady;
}

router.get('/', authMiddleware, requireTabAccess('chamados'), async (req, res) => {
  try {
    await ensureCompetenciasColumn();
    await ensureSatisfacaoPesquisaColumns();
    await ensureSlaEstouroColumn();
    const queryCfg = await getCuradoriaQueryConfigPromise();
    const listagemCfg = queryCfg.listagem;

    // processado=1: já passou pela análise de IA. satisfacao_pesquisa IS NOT NULL: tem
    // nota real do cliente mesmo que a análise de IA ainda não tenha rodado nesse chamado
    // (são pipelines independentes) — sem essa segunda condição, chamados com satisfação
    // real já sincronizada mas ainda não processados pela IA ficavam invisíveis na tela.
    // Configurável em Configurações → Curadoria Avançado → Consulta ao Banco (Listagem).
    const defaultGuidedWhere = `processado = 1${listagemCfg.guided.includeSatisfacaoSemProcessar ? ' OR satisfacao_pesquisa IS NOT NULL' : ''}`;
    const whereClause = buildCuradoriaWhereClause(listagemCfg, defaultGuidedWhere);
    const orderDir = listagemCfg.guided.orderDir === 'ASC' ? 'ASC' : 'DESC';
    const limit = Number.isFinite(listagemCfg.guided.limit) ? listagemCfg.guided.limit : 2000;

    const result = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT
        ${CURADORIA_COLUMNS.join(',\n        ')}
      FROM public.curadoria_chamados
      WHERE ${whereClause}
      ORDER BY ticket_id ${orderDir}
      LIMIT ${limit}`
    );

    const rows = result.rows || [];

    // Data de abertura do chamado vem de `aberto_em` (já está em curadoria_chamados).
    // Antes fazia um cruzamento com a tabela `tickets` do banco principal para pegar
    // createdDate, mas essa tabela só guarda os chamados atualmente abertos (sync
    // incremental) — o histórico processado pela curadoria nunca dava match, então
    // esse campo sempre voltava nulo.
    res.json(rows.map(row => normalizeCuradoriaRow(row)));
  } catch (error) {
    console.error('Erro ao buscar curadoria:', error);
    res.status(500).json({ error: 'Erro ao carregar dados de curadoria' });
  }
});

// ===== POST /curadoria/competencias =====
// Persiste, por chamado, as competências identificadas pela IA (chave -> percentual 0-100).
// Usado pela tela de curadoria para gravar o resultado da análise "chamado por chamado"
// na primeira vez que um atendente é aberto, evitando reprocessar os mesmos chamados depois.
router.post('/competencias', authMiddleware, requireTabAccess('chamados'), async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ error: 'updates deve ser uma lista não vazia' });

  try {
    await ensureCompetenciasColumn();

    for (const item of updates) {
      const ticketId = Number(item?.ticket_id);
      if (!Number.isFinite(ticketId)) continue;
      const competencias = item?.competencias && typeof item.competencias === 'object' ? item.competencias : {};

      await db.queryDatabase(
        'movidesk_curadoria',
        `UPDATE public.curadoria_chamados SET competencias = $1 WHERE ticket_id = $2`,
        [JSON.stringify(competencias), ticketId]
      );
    }

    return res.json({ updated: updates.length });
  } catch (error) {
    console.error('Erro ao salvar competências:', error);
    return res.status(500).json({ error: 'Erro ao salvar competências' });
  }
});

// ===== POST /curadoria/competencias/reset =====
// Apaga as competências já calculadas (volta a coluna pra NULL) para que sejam recalculadas
// da próxima vez que cada atendente for aberto na tela de Curadoria. Usado quando o admin
// acrescenta uma competência nova ou muda o prompt de uma existente — o resultado antigo,
// gerado com os critérios anteriores, deixa de fazer sentido e precisa ser refeito.
router.post('/competencias/reset', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    await ensureCompetenciasColumn();
    const result = await db.queryDatabase(
      'movidesk_curadoria',
      `UPDATE public.curadoria_chamados SET competencias = NULL WHERE competencias IS NOT NULL`
    );
    return res.json({ reset: result.rowCount || 0 });
  } catch (error) {
    console.error('Erro ao resetar competências:', error);
    return res.status(500).json({ error: 'Erro ao resetar competências' });
  }
});

// ===== Processamento de chamados pendentes (processado = 0) via IA =====
// Reimplementa dentro do painel o que hoje roda num workflow n8n externo:
// pega um chamado ainda não analisado, manda o texto bruto (`actions`) pra IA
// com um prompt de análise comportamental, valida o JSON de resposta e grava
// de volta no banco (processado = 1 + todos os campos de diagnóstico).

const FERIADOS_FIXOS = new Set(['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25']);
const FERIADOS_MOVEIS = new Set([
  '2020-02-24', '2020-02-25', '2020-04-10', '2020-06-11',
  '2021-02-15', '2021-02-16', '2021-04-02', '2021-06-03',
  '2022-02-28', '2022-03-01', '2022-04-15', '2022-06-16',
  '2023-02-20', '2023-02-21', '2023-04-07', '2023-06-08',
  '2024-02-12', '2024-02-13', '2024-03-29', '2024-05-30',
  '2025-03-03', '2025-03-04', '2025-04-18', '2025-06-19',
  '2026-02-16', '2026-02-17', '2026-04-03', '2026-06-04',
  '2027-02-08', '2027-02-09', '2027-03-26', '2027-05-27',
  '2028-02-28', '2028-02-29', '2028-04-14', '2028-06-15',
  '2029-02-12', '2029-02-13', '2029-03-30', '2029-05-31',
  '2030-03-04', '2030-03-05', '2030-04-19', '2030-06-20'
]);
function normalizeUrgencia(u) {
  return String(u || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
function pad(n) { return String(n).padStart(2, '0'); }
function toDateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toMonthDayKey(d) { return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isFeriado(d) { return FERIADOS_FIXOS.has(toMonthDayKey(d)) || FERIADOS_MOVEIS.has(toDateKey(d)); }
function isDiaUtil(d) { const dw = d.getDay(); return dw !== 0 && dw !== 6 && !isFeriado(d); }
function setHora(d, h, m, s = 0, ms = 0) { const x = new Date(d); x.setHours(h, m, s, ms); return x; }
function proximoDiaUtil(d) { const x = new Date(d); x.setDate(x.getDate() + 1); x.setHours(7, 45, 0, 0); while (!isDiaUtil(x)) { x.setDate(x.getDate() + 1); } return x; }
function calcularSlaInicio(aberto) {
  if (!aberto) return null;
  const dt = new Date(aberto);
  if (!isDiaUtil(dt)) return proximoDiaUtil(dt);
  const tot = dt.getHours() * 60 + dt.getMinutes();
  if (tot >= 465 && tot < 720) return dt;
  if (tot >= 720 && tot < 810) return setHora(dt, 13, 30, 0, 0);
  if (tot >= 810 && tot < 1080) return dt;
  return proximoDiaUtil(dt);
}
function calcularMinutosUteis(inicio, fim) {
  if (!inicio || !fim || fim <= inicio) return 0;
  let total = 0;
  let cursor = new Date(inicio); cursor.setSeconds(0, 0);
  const fimC = new Date(fim); fimC.setSeconds(0, 0);
  while (cursor < fimC) {
    if (!isDiaUtil(cursor)) { cursor = proximoDiaUtil(cursor); continue; }
    const iM = setHora(cursor, 7, 45, 0, 0), fM = setHora(cursor, 12, 0, 0, 0);
    if (cursor < fM) { const de = cursor > iM ? cursor : iM; const ate = fimC < fM ? fimC : fM; if (ate > de) total += (ate - de) / 60000; }
    const iT = setHora(cursor, 13, 30, 0, 0), fT = setHora(cursor, 18, 0, 0, 0);
    if (cursor < fT) { const de = cursor > iT ? cursor : iT; const ate = fimC < fT ? fimC : fT; if (ate > de) total += (ate - de) / 60000; }
    cursor = proximoDiaUtil(cursor);
  }
  return Math.round(total);
}
function formatarLegivel(m) {
  if (m === null || m === undefined) return null;
  if (m === 0) return '0min';
  const d = Math.floor(m / 525), r = m % 525, h = Math.floor(r / 60), mn = r % 60;
  const p = [];
  if (d > 0) p.push(`${d}d util`);
  if (h > 0) p.push(`${h}h`);
  if (mn > 0) p.push(`${mn}min`);
  return p.join(' ');
}

function calcularTiming(abertoEm, resolvidoEm) {
  const dtA = abertoEm ? new Date(abertoEm) : null;
  const dtR = resolvidoEm ? new Date(resolvidoEm) : null;
  const slaInicioDt = calcularSlaInicio(dtA);
  let minUteis = null, horasUteis = null, diasUteis = null, legivel = 'ticket ainda aberto', foraExpediente = null;
  if (!dtA) { legivel = 'data de abertura indisponivel'; }
  else if (dtR) {
    minUteis = calcularMinutosUteis(slaInicioDt, dtR);
    horasUteis = Math.round((minUteis / 60) * 100) / 100;
    diasUteis = Math.round((minUteis / 525) * 100) / 100;
    legivel = formatarLegivel(minUteis);
  }
  if (dtA && slaInicioDt) foraExpediente = dtA.getTime() !== slaInicioDt.getTime();
  return {
    aberto_em: abertoEm || null,
    sla_inicio_em: slaInicioDt ? slaInicioDt.toISOString() : null,
    resolvido_em: resolvidoEm || null,
    tempo_resolucao_min_uteis: minUteis,
    tempo_resolucao_horas_uteis: horasUteis,
    tempo_resolucao_dias_uteis: diasUteis,
    tempo_resolucao_legivel: legivel,
    abertura_fora_expediente: foraExpediente
  };
}

const CURADORIA_ANALYSIS_SCHEMA = `{
  "tabela_acoes": [{"id": 1, "origem": "Abertura|Cliente|Suporte|Sistema", "criado_por": "Nome Real", "ator": "Cliente|Suporte"}],
  "total_acoes": 0, "total_cliente": 0, "total_agente": 0,
  "tempo_resposta_owner": {"total_acoes_owner": 0, "tempo_medio_resposta_min": 0, "tempo_medio_resposta_legivel": "Xd Yh Zmin", "intervalos_minutos": [], "observacao": ""},
  "tempo_primeira_resposta_owner": {"primeira_acao_cliente_id": 0, "primeira_acao_cliente_data": "", "primeira_acao_cliente_autor": "", "primeira_resposta_owner_id": 0, "primeira_resposta_owner_data": "", "tempo_primeira_resposta_min": 0.00, "tempo_primeira_resposta_legivel": "", "sla_primeiro_contato_min": 0, "sla_primeiro_contato_status": "cumprido|violado|indisponivel", "sla_primeiro_contato_excesso_min": 0.00, "observacao": ""},
  "tempo_resolucao": {"aberto_em": "", "sla_inicio_em": "", "resolvido_em": "", "tempo_resolucao_min_uteis": 0, "tempo_resolucao_horas_uteis": 0, "tempo_resolucao_dias_uteis": 0, "tempo_resolucao_legivel": "", "abertura_fora_expediente": false, "observacao": ""},
  "comportamento_cliente": {"nome": "", "perfil": "", "pontos": [], "padrao_emocional": ""},
  "perfil_cliente": "neutro|moderado|ansioso|agressivo|detalhista|leigo",
  "perfil_cliente_descricao": "",
  "comportamento_suporte": [{"nome": "", "ids": [], "pontos": []}],
  "padrao_suporte": "",
  "dinamica_conversa": {"cliente_para_suporte": "", "suporte_para_cliente": "", "tempo_resposta": ""},
  "pontos_criticos": {"acertos": [], "melhorias": []},
  "conclusao": "",
  "urgencia": "critica",
  "evidencias_urgencia": [{"comportamento": "", "indicacao": ""}],
  "cliente_nao_fez": [],
  "impacto_real": "",
  "diagnostico": {"causa": "", "causa_normalizada": "", "modulo_rotina": "", "modulo_rotina_normalizado": "", "fato": "", "fato_palavras_chave": [], "fato_categoria_principal": "", "compilado_causa_modulo_fato": "", "relacao_fato_causa": "", "impacto_inferido": "", "par_agrupamento": ""},
  "nota_urgencia": 4,
  "nota_urgencia_descricao": "",
  "justificativa_urgencia": "",
  "recomendacao_atendente": "",
  "sentimento": "neutro",
  "satisfacao": 5,
  "alertas": [],
  "sla_estouro": {"responsavel": "cliente|suporte|nao_estourou|indisponivel", "justificativa": "", "evidencias": [{"acao_id": 0, "autor": "", "data": "", "trecho": ""}]}
}`;

// Substitui placeholders {{chave}} no template configurável pelo valor real do ticket/timing.
// Mesmo mecanismo de renderConfiguredPrompt (server/routes/tickets.js) — regex tolerante a espaços.
function renderPromptTemplate(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value ?? '');
  }
  return rendered;
}

// Critério (editável via Configurações → Curadoria Avançado, chave curadoria_prompt_sla_estouro)
// usado pela IA pra decidir, quando o chamado estoura o SLA de resolução, se o atraso foi por
// culpa do cliente ou do suporte. Reaproveita a MESMA chamada de análise principal (já recebe
// a tabela de ações com timestamps), em vez de disparar uma segunda chamada de IA.
async function buildSlaEstouroInstructions(row, timing) {
  const [thresholds, template] = await Promise.all([
    getCuradoriaSlaThresholdsPromise(),
    getCuradoriaPromptSlaEstouroPromise()
  ]);
  const slaResolucaoHoras = thresholds[normalizeUrgencia(row.urgencia)] ?? '';
  return renderPromptTemplate(template, {
    slaResolucaoHoras,
    tempoResolucaoHorasUteis: timing.tempo_resolucao_horas_uteis
  });
}

// O texto de REGRAS/CAMPOS PRE-CALCULADOS é editável via Configurações → Curadoria Avançado
// (chave curadoria_prompt_analise). O schema de saída (CURADORIA_ANALYSIS_SCHEMA) é sempre
// acrescentado pelo backend — é o contrato com validateCuradoriaAnalysis/persistCuradoriaAnalysis,
// então não pode ser alterado pelo usuário sem quebrar a gravação no banco.
async function buildCuradoriaSystemPrompt(row, timing) {
  const promptCfg = await getCuradoriaPromptAnalisePromise();
  const instructions = renderPromptTemplate(promptCfg.template, {
    solicitante: row.solicitante || '',
    fato: row.fato || '',
    causa: row.causa || '',
    moduloXRotina: row.modulo_x_rotina || '',
    owner: row.owner || '',
    abertoEm: timing.aberto_em || '',
    slaInicioEm: timing.sla_inicio_em || '',
    resolvidoEm: timing.resolvido_em || '',
    tempoResolucaoMinUteis: timing.tempo_resolucao_min_uteis,
    tempoResolucaoHorasUteis: timing.tempo_resolucao_horas_uteis,
    tempoResolucaoDiasUteis: timing.tempo_resolucao_dias_uteis,
    tempoResolucaoLegivel: timing.tempo_resolucao_legivel,
    aberturaForaExpediente: timing.abertura_fora_expediente
  });
  const slaEstouroInstructions = await buildSlaEstouroInstructions(row, timing);

  return `${instructions}

${slaEstouroInstructions}

RESPONDA EXATAMENTE neste formato JSON:

${CURADORIA_ANALYSIS_SCHEMA}`;
}

async function getOpenAiApiKey() {
  const row = await new Promise((resolve, reject) => {
    db.get('SELECT value FROM config WHERE key = ?', ['openai_api_key'], (err, r) => err ? reject(err) : resolve(r));
  });
  if (!row) return null;
  try { return decryptToken(row.value); } catch { return null; }
}

function cleanJsonText(text) {
  return String(text || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function extractTextFromResponsesPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') chunks.push(part.text);
      if (typeof part?.output_text === 'string') chunks.push(part.output_text);
    }
  }
  return chunks.join('\n').trim();
}

// gpt-4o-mini deixa "justificativa_urgencia"/"recomendacao_atendente" vazios com este schema
// grande e aninhado (confirmado em teste isolado); gpt-4.1-mini (mesmo do workflow n8n
// original) preenche corretamente os mesmos campos com o schema completo. Esse é só o
// fallback — modelo/temperatura reais vêm de curadoria_prompt_analise (Configurações → Curadoria Avançado).
const CURADORIA_MODEL = 'gpt-4.1-mini';

async function callCuradoriaLLM(systemPrompt, actionsText, ticketId, model = CURADORIA_MODEL, temperature = 0, source = 'curadoria_processamento') {
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) throw new Error('Chave da API GPT nao configurada no servidor');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'user', content: [{ type: 'input_text', text: `Analise o ticket abaixo e retorne APENAS um objeto JSON valido com todos os campos preenchidos com dados reais do ticket.\n\nACOES DO TICKET:\n${actionsText}` }] }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Falha na chamada a IA: ${response.status} ${errText}`);
  }

  const payload = await response.json();
  const text = extractTextFromResponsesPayload(payload);

  try {
    const usage = payload?.usage || {};
    const inputTok = usage.input_tokens || 0, outputTok = usage.output_tokens || 0;
    if (inputTok > 0 || outputTok > 0) {
      const prices = { 'gpt-4o-mini': [0.15, 0.60], 'gpt-4.1-mini': [0.40, 1.60], 'gpt-4o': [5.00, 15.00], 'gpt-4.1': [2.00, 8.00] };
      const [pi, po] = prices[model] || prices['gpt-4o-mini'];
      db.run(
        `INSERT INTO ai_usage_log (source, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [source, model, inputTok, outputTok, inputTok + outputTok, ((inputTok * pi) + (outputTok * po)) / 1_000_000, JSON.stringify({ ticket_id: ticketId })],
        () => {}
      );
    }
  } catch (_) {}

  return JSON.parse(cleanJsonText(text));
}

function validateCuradoriaAnalysis(parsed) {
  const erros = [];
  const vv = { urgencia: ['critica', 'alta', 'media', 'baixa'], sentimento: ['negativo', 'neutro', 'positivo'] };
  if (!vv.urgencia.includes(parsed.urgencia)) erros.push(`urgencia "${parsed.urgencia}" invalida.`);
  if (!vv.sentimento.includes(parsed.sentimento)) erros.push(`sentimento "${parsed.sentimento}" invalido.`);
  if (typeof parsed.satisfacao !== 'number' || !Number.isInteger(parsed.satisfacao) || parsed.satisfacao < 1 || parsed.satisfacao > 10) erros.push('satisfacao invalida.');
  if (typeof parsed.nota_urgencia !== 'number' || !Number.isInteger(parsed.nota_urgencia) || parsed.nota_urgencia < 1 || parsed.nota_urgencia > 4) erros.push('nota_urgencia invalida.');
  if (!Array.isArray(parsed.alertas)) erros.push('alertas deve ser array.');
  if (!Array.isArray(parsed.tabela_acoes)) erros.push('tabela_acoes deve ser array.');
  if (typeof parsed.total_agente !== 'number' || parsed.total_agente < 0) erros.push('total_agente invalido.');
  if (typeof parsed.total_cliente !== 'number' || parsed.total_cliente < 0) erros.push('total_cliente invalido.');
  if (typeof parsed.total_acoes !== 'number' || parsed.total_acoes < 0) erros.push('total_acoes invalido.');
  for (const campo of ['conclusao', 'justificativa_urgencia', 'impacto_real', 'recomendacao_atendente']) {
    if (!parsed[campo] || typeof parsed[campo] !== 'string' || !parsed[campo].trim()) erros.push(`${campo} e obrigatorio.`);
  }
  if (!parsed.diagnostico || typeof parsed.diagnostico !== 'object') erros.push('diagnostico e obrigatorio.');
  const slaResponsaveis = ['cliente', 'suporte', 'nao_estourou', 'indisponivel'];
  if (!parsed.sla_estouro || typeof parsed.sla_estouro !== 'object' || !slaResponsaveis.includes(parsed.sla_estouro.responsavel)) {
    erros.push('sla_estouro invalido.');
  }
  return erros;
}

async function persistCuradoriaAnalysis(ticketId, raw, timing) {
  const diag = raw.diagnostico || {};
  const jsonb = (v) => v === undefined ? null : JSON.stringify(v);

  await ensureSlaEstouroColumn();
  await db.queryDatabase(
    'movidesk_curadoria',
    `UPDATE public.curadoria_chamados SET
      processado = 1,
      perfil_cliente = $2,
      perfil_cliente_descricao = $3,
      comportamento_cliente = $4::jsonb,
      performance_suporte = $5,
      padrao_suporte = $6,
      dinamica_conversa = $7::jsonb,
      pontos_criticos = $8::jsonb,
      conclusao = $9,
      tabela_acoes = $10::jsonb,
      total_acoes = $11,
      total_cliente = $12,
      total_agente = $13,
      urgencia_sugerida = $14,
      evidencias_urgencia = $15::jsonb,
      cliente_nao_fez = $16::jsonb,
      impacto_real = $17,
      nota_urgencia = $18,
      nota_urgencia_descricao = $19,
      justificativa_urgencia = $20,
      recomendacao_atendente = $21,
      sentimento = $22,
      satisfacao = $23,
      alertas = $24::jsonb,
      fato = $25,
      causa = $26,
      causa_normalizada = $27,
      modulo_rotina_normalizado = $28,
      fato_palavras_chave = $29::jsonb,
      fato_categoria_principal = $30,
      analise_fato = $31,
      relacao_fato_causa = $32,
      impacto_inferido = $33,
      par_agrupamento = $34,
      diagnostico_raw = $35::jsonb,
      analise_completa = $36::jsonb,
      processado_em = NOW(),
      tempo_resposta_owner = $37,
      convertido = 1,
      tempo_resol_dias = $38,
      tempo_resol_h_uteis = $39,
      tempo_resp_owner = $40,
      sla_estouro = $41::jsonb
    WHERE ticket_id = $1`,
    [
      ticketId,
      raw.perfil_cliente || null,
      raw.perfil_cliente_descricao || null,
      jsonb({ items: raw.comportamento_cliente }),
      jsonb({ items: raw.comportamento_suporte }),
      raw.padrao_suporte || null,
      jsonb({ items: raw.dinamica_conversa }),
      jsonb({ items: raw.pontos_criticos }),
      raw.conclusao || null,
      jsonb({ items: raw.tabela_acoes }),
      raw.total_acoes,
      raw.total_cliente,
      raw.total_agente,
      raw.urgencia || null,
      jsonb({ items: raw.evidencias_urgencia }),
      jsonb({ items: raw.cliente_nao_fez }),
      raw.impacto_real || null,
      raw.nota_urgencia,
      raw.nota_urgencia_descricao || null,
      raw.justificativa_urgencia || null,
      raw.recomendacao_atendente || null,
      raw.sentimento || null,
      raw.satisfacao,
      jsonb({ items: raw.alertas }),
      diag.fato || null,
      diag.causa || null,
      diag.causa_normalizada || null,
      diag.modulo_rotina_normalizado || null,
      jsonb({ items: diag.fato_palavras_chave }),
      diag.fato_categoria_principal || null,
      diag.compilado_causa_modulo_fato || null,
      diag.relacao_fato_causa || null,
      diag.impacto_inferido || null,
      diag.par_agrupamento || null,
      jsonb(diag),
      jsonb(raw),
      raw.tempo_resposta_owner?.tempo_medio_resposta_min ?? null,
      raw.tempo_resolucao?.tempo_resolucao_legivel || timing.tempo_resolucao_legivel || null,
      raw.tempo_resolucao?.tempo_resolucao_horas_uteis ?? timing.tempo_resolucao_horas_uteis,
      raw.tempo_resposta_owner?.tempo_medio_resposta_legivel || null,
      jsonb(raw.sla_estouro)
    ]
  );
}

async function processOneCuradoriaTicket(row) {
  const timing = calcularTiming(row.aberto_em, row.resolvido_em);
  const systemPrompt = await buildCuradoriaSystemPrompt(row, timing);
  const promptCfg = await getCuradoriaPromptAnalisePromise();
  const raw = await callCuradoriaLLM(systemPrompt, row.actions || '', row.ticket_id, promptCfg.model, promptCfg.temperature);
  const erros = validateCuradoriaAnalysis(raw);
  if (erros.length) throw new Error(`Resposta da IA invalida: ${erros.join(' ')}`);
  await persistCuradoriaAnalysis(row.ticket_id, raw, timing);
}

// Estado do job em memória (mesmo padrão do runSync/getSyncState em tickets.js): sobrevive
// à navegação do usuário e a fechar a aba, mas não a um restart do servidor. O job roda
// inteiro no backend, chamado por chamado, e o frontend só consulta o progresso via polling.
let curadoriaProcessingState = {
  running: false, total: 0, processed: 0, failed: 0, currentTicketId: null,
  startedAt: null, finishedAt: null, stopRequested: false, recentErrors: []
};
let activeCuradoriaProcessing = null;

async function runCuradoriaProcessingLoop() {
  try {
    // Busca a lista inteira de pendentes UMA vez, no início. Se buscássemos "o próximo
    // pendente" a cada iteração, um chamado que falha (continua com processado = 0)
    // seria pego de novo na iteração seguinte, travando o job num loop infinito.
    const queryCfg = await getCuradoriaQueryConfigPromise();
    const pendentesCfg = queryCfg.pendentes;
    const defaultGuidedWhere = `processado = ${pendentesCfg.guided.processadoValue}`;
    const whereClause = buildCuradoriaWhereClause(pendentesCfg, defaultGuidedWhere);
    const orderDir = pendentesCfg.guided.orderDir === 'DESC' ? 'DESC' : 'ASC';

    const pendingResult = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT ticket_id, actions, fato, causa, modulo_x_rotina, owner, solicitante, aberto_em, resolvido_em, urgencia
       FROM public.curadoria_chamados WHERE ${whereClause} ORDER BY ticket_id ${orderDir}`
    );
    curadoriaProcessingState.total = pendingResult.rows.length;

    for (const row of pendingResult.rows) {
      if (curadoriaProcessingState.stopRequested) break;
      curadoriaProcessingState.currentTicketId = row.ticket_id;
      try {
        await processOneCuradoriaTicket(row);
        curadoriaProcessingState.processed++;
      } catch (err) {
        curadoriaProcessingState.failed++;
        curadoriaProcessingState.recentErrors.unshift({ ticket_id: row.ticket_id, error: err.message, at: new Date().toISOString() });
        if (curadoriaProcessingState.recentErrors.length > 20) curadoriaProcessingState.recentErrors.length = 20;
        console.error(`Erro ao processar chamado ${row.ticket_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Erro fatal no job de processamento de curadoria:', err.message);
  } finally {
    curadoriaProcessingState.running = false;
    curadoriaProcessingState.currentTicketId = null;
    curadoriaProcessingState.finishedAt = new Date().toISOString();
    activeCuradoriaProcessing = null;
  }
}

function startCuradoriaProcessingJob() {
  if (activeCuradoriaProcessing) return curadoriaProcessingState; // já rodando — não inicia outro em paralelo

  curadoriaProcessingState = {
    running: true, total: 0, processed: 0, failed: 0, currentTicketId: null,
    startedAt: new Date().toISOString(), finishedAt: null, stopRequested: false, recentErrors: []
  };
  activeCuradoriaProcessing = runCuradoriaProcessingLoop();
  return curadoriaProcessingState;
}

// ===== GET /curadoria/pending-count =====
router.get('/pending-count', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT COUNT(*) FROM public.curadoria_chamados WHERE processado = 0`
    );
    res.json({ count: Number(result.rows[0].count) || 0 });
  } catch (error) {
    console.error('Erro ao contar chamados pendentes:', error);
    res.status(500).json({ error: 'Erro ao contar chamados pendentes' });
  }
});

// ===== POST /curadoria/process-pending =====
// Inicia (ou retorna o estado de) o job de processamento em segundo plano. Responde na hora;
// o processamento continua rodando no servidor mesmo se o usuário sair da tela.
router.post('/process-pending', authMiddleware, requireRole('admin'), (req, res) => {
  const state = startCuradoriaProcessingJob();
  res.json(state);
});

// ===== GET /curadoria/process-pending/status =====
// Consultado via polling pelo frontend para atualizar a barra de progresso em tempo real.
router.get('/process-pending/status', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(curadoriaProcessingState);
});

// ===== POST /curadoria/process-pending/stop =====
// Sinaliza pro job parar após o chamado que está em andamento (não interrompe no meio de uma
// chamada à IA já em curso, pra não deixar um chamado pela metade).
router.post('/process-pending/stop', authMiddleware, requireRole('admin'), (req, res) => {
  curadoriaProcessingState.stopRequested = true;
  res.json({ stopping: true });
});

// ===== Recálculo de estouro de SLA (cliente x suporte) para chamados já processados =====
// Diferente do processamento de pendentes acima, NÃO refaz a análise comportamental inteira —
// só chama a IA com o critério de estouro de SLA (curadoria_prompt_sla_estouro) e grava de volta
// unicamente a coluna sla_estouro. Existe porque chamados processados antes desse critério
// existir nunca tiveram esse campo preenchido (ver buildSlaEstouroInstructions).
const SLA_ESTOURO_ONLY_SCHEMA = `{
  "sla_estouro": {"responsavel": "cliente|suporte|nao_estourou|indisponivel", "justificativa": "", "evidencias": [{"acao_id": 0, "autor": "", "data": "", "trecho": ""}]}
}`;

async function recalcularSlaEstouroTicket(row) {
  const timing = calcularTiming(row.aberto_em, row.resolvido_em);
  const instructions = await buildSlaEstouroInstructions(row, timing);
  const systemPrompt = `${instructions}\n\nRESPONDA EXATAMENTE neste formato JSON:\n\n${SLA_ESTOURO_ONLY_SCHEMA}`;
  const promptCfg = await getCuradoriaPromptAnalisePromise();

  const raw = await callCuradoriaLLM(
    systemPrompt, row.actions || '', row.ticket_id,
    promptCfg.model, promptCfg.temperature, 'curadoria_sla_estouro_recalculo'
  );

  const slaResponsaveis = ['cliente', 'suporte', 'nao_estourou', 'indisponivel'];
  if (!raw.sla_estouro || typeof raw.sla_estouro !== 'object' || !slaResponsaveis.includes(raw.sla_estouro.responsavel)) {
    throw new Error('Resposta da IA invalida para sla_estouro');
  }

  await ensureSlaEstouroColumn();
  await db.queryDatabase(
    'movidesk_curadoria',
    `UPDATE public.curadoria_chamados SET sla_estouro = $2::jsonb WHERE ticket_id = $1`,
    [row.ticket_id, JSON.stringify(raw.sla_estouro)]
  );
}

let slaEstouroRecalcState = {
  running: false, total: 0, processed: 0, failed: 0, currentTicketId: null,
  startedAt: null, finishedAt: null, stopRequested: false, recentErrors: []
};
let activeSlaEstouroRecalc = null;

async function runSlaEstouroRecalcLoop() {
  try {
    const pendingResult = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT ticket_id, actions, aberto_em, resolvido_em, urgencia
       FROM public.curadoria_chamados WHERE processado = 1 ORDER BY ticket_id ASC`
    );
    slaEstouroRecalcState.total = pendingResult.rows.length;

    for (const row of pendingResult.rows) {
      if (slaEstouroRecalcState.stopRequested) break;
      slaEstouroRecalcState.currentTicketId = row.ticket_id;
      try {
        await recalcularSlaEstouroTicket(row);
        slaEstouroRecalcState.processed++;
      } catch (err) {
        slaEstouroRecalcState.failed++;
        slaEstouroRecalcState.recentErrors.unshift({ ticket_id: row.ticket_id, error: err.message, at: new Date().toISOString() });
        if (slaEstouroRecalcState.recentErrors.length > 20) slaEstouroRecalcState.recentErrors.length = 20;
        console.error(`Erro ao recalcular SLA do chamado ${row.ticket_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Erro fatal no job de recalculo de SLA:', err.message);
  } finally {
    slaEstouroRecalcState.running = false;
    slaEstouroRecalcState.currentTicketId = null;
    slaEstouroRecalcState.finishedAt = new Date().toISOString();
    activeSlaEstouroRecalc = null;
  }
}

function startSlaEstouroRecalcJob() {
  if (activeSlaEstouroRecalc) return slaEstouroRecalcState; // já rodando — não inicia outro em paralelo

  slaEstouroRecalcState = {
    running: true, total: 0, processed: 0, failed: 0, currentTicketId: null,
    startedAt: new Date().toISOString(), finishedAt: null, stopRequested: false, recentErrors: []
  };
  activeSlaEstouroRecalc = runSlaEstouroRecalcLoop();
  return slaEstouroRecalcState;
}

// ===== GET /curadoria/sla-estouro/count =====
router.get('/sla-estouro/count', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT COUNT(*) FROM public.curadoria_chamados WHERE processado = 1`
    );
    res.json({ count: Number(result.rows[0].count) || 0 });
  } catch (error) {
    console.error('Erro ao contar chamados para recalculo de SLA:', error);
    res.status(500).json({ error: 'Erro ao contar chamados' });
  }
});

// ===== POST /curadoria/sla-estouro/recalcular =====
router.post('/sla-estouro/recalcular', authMiddleware, requireRole('admin'), (req, res) => {
  const state = startSlaEstouroRecalcJob();
  res.json(state);
});

// ===== GET /curadoria/sla-estouro/recalcular/status =====
router.get('/sla-estouro/recalcular/status', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(slaEstouroRecalcState);
});

// ===== POST /curadoria/sla-estouro/recalcular/stop =====
router.post('/sla-estouro/recalcular/stop', authMiddleware, requireRole('admin'), (req, res) => {
  slaEstouroRecalcState.stopRequested = true;
  res.json({ stopping: true });
});

// ===== POST /curadoria/prompt-analise/test =====
// Testa um template de prompt (ainda não salvo) contra um chamado real, sem persistir o
// resultado. Usado pelo botão "Testar com este chamado" em Configurações → Curadoria Avançado,
// pra validar o prompt antes de rodar de verdade no processamento em lote.
router.post('/prompt-analise/test', authMiddleware, requireRole('admin'), async (req, res) => {
  const { ticketId, template, model, temperature } = req.body;
  const id = Number(ticketId);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Informe um ticket_id válido' });
  if (!template || typeof template !== 'string' || !template.trim()) {
    return res.status(400).json({ error: 'Template do prompt não pode estar vazio' });
  }

  try {
    const result = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT ticket_id, actions, fato, causa, modulo_x_rotina, owner, solicitante, aberto_em, resolvido_em, urgencia
       FROM public.curadoria_chamados WHERE ticket_id = $1`,
      [id]
    );
    const row = result.rows?.[0];
    if (!row) return res.status(404).json({ error: `Chamado ${id} não encontrado em curadoria_chamados` });

    const timing = calcularTiming(row.aberto_em, row.resolvido_em);
    const instructions = renderPromptTemplate(template, {
      solicitante: row.solicitante || '',
      fato: row.fato || '',
      causa: row.causa || '',
      moduloXRotina: row.modulo_x_rotina || '',
      owner: row.owner || '',
      abertoEm: timing.aberto_em || '',
      slaInicioEm: timing.sla_inicio_em || '',
      resolvidoEm: timing.resolvido_em || '',
      tempoResolucaoMinUteis: timing.tempo_resolucao_min_uteis,
      tempoResolucaoHorasUteis: timing.tempo_resolucao_horas_uteis,
      tempoResolucaoDiasUteis: timing.tempo_resolucao_dias_uteis,
      tempoResolucaoLegivel: timing.tempo_resolucao_legivel,
      aberturaForaExpediente: timing.abertura_fora_expediente
    });
    const slaEstouroInstructions = await buildSlaEstouroInstructions(row, timing);
    const systemPrompt = `${instructions}\n\n${slaEstouroInstructions}\n\nRESPONDA EXATAMENTE neste formato JSON:\n\n${CURADORIA_ANALYSIS_SCHEMA}`;

    const raw = await callCuradoriaLLM(systemPrompt, row.actions || '', row.ticket_id, model || CURADORIA_MODEL, temperature ?? 0);
    const erros = validateCuradoriaAnalysis(raw);
    res.json({ raw, errors: erros });
  } catch (error) {
    console.error('Erro ao testar prompt de análise:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== Sincronização de satisfação do cliente (pesquisa Movidesk) =====
// Descoberta ao investigar a API: o endpoint de listagem (/survey/responses) não pagina
// de forma confiável — $skip devolve sempre os mesmos itens e $filter (por data OU por
// ticketId) é simplesmente ignorado (testado com data no futuro e com ticketId específico,
// ambos continuaram devolvendo "as ~100 respostas mais recentes" de qualquer jeito).
// A alternativa que funciona: o próprio endpoint de TICKET (que já sabemos filtrar bem
// por id) traz a pesquisa embutida no campo `satisfactionSurveyResponses`. Por isso a
// sincronização busca UM CHAMADO POR VEZ (fila de pendentes, igual ao processamento de IA),
// respeitando o limite de ~10 requisições/minuto do Movidesk.

const API_TICKET_URL = 'https://api.movidesk.com/public/v1/tickets';

function normalizeSurveyValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(5, Math.round(value)));
  }
  return null;
}

let satisfacaoColumnReady = null;
function ensureSatisfacaoPesquisaColumns() {
  if (!satisfacaoColumnReady) {
    satisfacaoColumnReady = db.queryDatabase(
      'movidesk_curadoria',
      `ALTER TABLE public.curadoria_chamados ADD COLUMN IF NOT EXISTS satisfacao_pesquisa SMALLINT;
       ALTER TABLE public.curadoria_chamados ADD COLUMN IF NOT EXISTS satisfacao_pesquisa_comentario TEXT;
       ALTER TABLE public.curadoria_chamados ADD COLUMN IF NOT EXISTS satisfacao_pesquisa_respondido_em TEXT;
       ALTER TABLE public.curadoria_chamados ADD COLUMN IF NOT EXISTS satisfacao_pesquisa_verificado_em TEXT;`
    ).catch((err) => {
      satisfacaoColumnReady = null;
      throw err;
    });
  }
  return satisfacaoColumnReady;
}

function getMovideskTokenPromise() {
  return new Promise((resolve, reject) => {
    getToken((err, token) => err ? reject(err) : resolve(token));
  });
}

// O Movidesk limita a ~10 requisições/minuto (da CONTA inteira, não por endpoint). Excedendo
// isso, a API não devolve um 429 "educado" — ela derruba a conexão, o que aparece pro Node
// como "fetch failed" genérico (erro de rede, não resposta HTTP). Por isso toda chamada às
// APIs do Movidesk usadas aqui (satisfação e módulo x rotina) passa por este MESMO limitador
// compartilhado antes de sair, com folga sob o limite real — se as duas tarefas rodarem ao
// mesmo tempo, elas dividem a mesma cota em vez de somarem e estourarem o limite juntas.
const MOVIDESK_MIN_INTERVAL_MS = 6500; // ~9 req/min — fallback; valor real vem de curadoria_movidesk_config
let lastMovideskRequestAt = 0;
async function throttleMovideskRequest(rateLimitMs = MOVIDESK_MIN_INTERVAL_MS) {
  const wait = rateLimitMs - (Date.now() - lastMovideskRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastMovideskRequestAt = Date.now();
}

// EXCEÇÃO DOCUMENTADA à leitura exclusiva da apidatalake: a pesquisa de
// satisfação (satisfactionSurveyResponses) não é ingerida em lugar nenhum da
// apidatalake hoje — não existe tabela silver/gold nem endpoint pra isso
// (só um custom field manual "Satisfação:", sem relação com a pesquisa
// automática pós-atendimento). Migrar depende do time da apidatalake
// estender o pipeline pra trazer esse dado do Movidesk; até lá, esta função
// continua chamando a API do Movidesk direto.
//
// Busca a pesquisa de satisfação de UM chamado específico, com retry cobrindo tanto
// respostas HTTP de erro quanto falhas de rede. `selectFields` e `rateLimitMs` vêm de
// curadoria_movidesk_config (Configurações → Curadoria Avançado).
async function fetchTicketSatisfaction(token, ticketId, movideskCfg, attempt = 0) {
  const rateLimitMs = movideskCfg.rateLimitMs || MOVIDESK_MIN_INTERVAL_MS;
  await throttleMovideskRequest(rateLimitMs);
  const selectFields = movideskCfg.satisfacao?.selectFields || 'id,satisfactionSurveyResponses';
  const url = `${API_TICKET_URL}?token=${encodeURIComponent(token)}&id=${ticketId}&$select=${selectFields}`;

  let res;
  try {
    res = await fetch(url);
  } catch (networkErr) {
    if (attempt < 4) {
      await new Promise(r => setTimeout(r, (attempt + 1) * rateLimitMs));
      return fetchTicketSatisfaction(token, ticketId, movideskCfg, attempt + 1);
    }
    throw new Error(`Falha de rede ao buscar satisfação do chamado ${ticketId}: ${networkErr.message}`);
  }

  if (!res.ok) {
    if (attempt < 4) {
      await new Promise(r => setTimeout(r, (attempt + 1) * rateLimitMs));
      return fetchTicketSatisfaction(token, ticketId, movideskCfg, attempt + 1);
    }
    throw new Error(`Falha ao buscar satisfação do chamado ${ticketId}: ${res.status}`);
  }
  const data = await res.json();
  return data?.satisfactionSurveyResponses || [];
}

// A pesquisa ativa usa o modelo "smiley faces" (1-5). Se houver mais de uma resposta
// (ex: pesquisa reenviada), usa a mais recente.
function extractSatisfaction(responses) {
  const withSmiley = (responses || []).filter(r => r.satisfactionSurveySmileyFacesResponse != null);
  if (!withSmiley.length) return null;
  const [latest] = [...withSmiley].sort((a, b) => String(b.responseDate || '').localeCompare(String(a.responseDate || '')));
  const nota = normalizeSurveyValue(latest.satisfactionSurveySmileyFacesResponse);
  if (nota === null) return null;
  return { nota, comentario: latest.comments || null, respondidoEm: latest.responseDate || null };
}

let surveyProcessingState = {
  running: false, total: 0, processed: 0, updated: 0, skipped: 0, currentTicketId: null,
  startedAt: null, finishedAt: null, stopRequested: false, error: null
};
let activeSurveyProcessing = null;

async function runSurveySyncLoop() {
  try {
    await ensureSatisfacaoPesquisaColumns();
    const token = await getMovideskTokenPromise();
    const movideskCfg = await getCuradoriaMovideskConfigPromise();

    const pending = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT ticket_id FROM public.curadoria_chamados WHERE satisfacao_pesquisa_verificado_em IS NULL ORDER BY ticket_id DESC`
    );
    surveyProcessingState.total = pending.rows.length;

    for (const row of pending.rows) {
      if (surveyProcessingState.stopRequested) break;
      surveyProcessingState.currentTicketId = row.ticket_id;

      try {
        const responses = await fetchTicketSatisfaction(token, row.ticket_id, movideskCfg);
        const sat = extractSatisfaction(responses);
        const verificadoEm = new Date().toISOString();

        if (sat) {
          await db.queryDatabase(
            'movidesk_curadoria',
            `UPDATE public.curadoria_chamados
             SET satisfacao_pesquisa = $1, satisfacao_pesquisa_comentario = $2,
                 satisfacao_pesquisa_respondido_em = $3, satisfacao_pesquisa_verificado_em = $4
             WHERE ticket_id = $5`,
            [sat.nota, sat.comentario, sat.respondidoEm, verificadoEm, row.ticket_id]
          );
          surveyProcessingState.updated++;
        } else {
          // Verificado, mas o cliente não respondeu a pesquisa — marca como visto pra não
          // ficar tentando de novo a cada execução (satisfacao_pesquisa continua NULL).
          await db.queryDatabase(
            'movidesk_curadoria',
            `UPDATE public.curadoria_chamados SET satisfacao_pesquisa_verificado_em = $1 WHERE ticket_id = $2`,
            [verificadoEm, row.ticket_id]
          );
          surveyProcessingState.skipped++;
        }
      } catch (err) {
        surveyProcessingState.skipped++;
        console.error(`Erro ao buscar satisfação do chamado ${row.ticket_id}:`, err.message);
      }

      surveyProcessingState.processed++;
    }
  } catch (err) {
    surveyProcessingState.error = err.message;
    console.error('Erro na sincronização de satisfação:', err.message);
  } finally {
    surveyProcessingState.running = false;
    surveyProcessingState.currentTicketId = null;
    surveyProcessingState.finishedAt = new Date().toISOString();
    activeSurveyProcessing = null;
  }
}

function startSurveySyncJob() {
  if (activeSurveyProcessing) return surveyProcessingState;
  surveyProcessingState = {
    running: true, total: 0, processed: 0, updated: 0, skipped: 0, currentTicketId: null,
    startedAt: new Date().toISOString(), finishedAt: null, stopRequested: false, error: null
  };
  activeSurveyProcessing = runSurveySyncLoop();
  return surveyProcessingState;
}

// ===== GET /curadoria/survey/pending-count =====
router.get('/survey/pending-count', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    await ensureSatisfacaoPesquisaColumns();
    const result = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT COUNT(*) FROM public.curadoria_chamados WHERE satisfacao_pesquisa_verificado_em IS NULL`
    );
    res.json({ count: Number(result.rows[0].count) || 0 });
  } catch (error) {
    console.error('Erro ao contar pendentes de satisfação:', error);
    res.status(500).json({ error: 'Erro ao contar pendentes de satisfação' });
  }
});

// ===== POST /curadoria/survey/sync =====
router.post('/survey/sync', authMiddleware, requireRole('admin'), (req, res) => {
  const state = startSurveySyncJob();
  res.json(state);
});

// ===== GET /curadoria/survey/sync/status =====
router.get('/survey/sync/status', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(surveyProcessingState);
});

// ===== POST /curadoria/survey/sync/stop =====
router.post('/survey/sync/stop', authMiddleware, requireRole('admin'), (req, res) => {
  surveyProcessingState.stopRequested = true;
  res.json({ stopping: true });
});

// ===== Sincronização de Módulo x Rotina (campo customizado) =====
// O campo customizado 59786 (ex: "TalentRH - Módulo X Rotina") vem via
// GET /tickets/:id/campos da apidatalake (escopo tickets:read, já liberado
// pro perfil painel-sla) — não precisa mais chamar a API do Movidesk direto
// nem do movidesk_token. datalakeClient.js já trata retry/backoff de 429/5xx.

const MODULO_CUSTOM_FIELD_ID = 59786; // fallback; valor real vem de curadoria_movidesk_config.moduloRotina.customFieldId

let moduloColumnReady = null;
function ensureModuloVerificadoColumn() {
  if (!moduloColumnReady) {
    moduloColumnReady = db.queryDatabase(
      'movidesk_curadoria',
      `ALTER TABLE public.curadoria_chamados ADD COLUMN IF NOT EXISTS modulo_x_rotina_verificado_em TEXT;`
    ).catch((err) => {
      moduloColumnReady = null;
      throw err;
    });
  }
  return moduloColumnReady;
}

// Busca os campos customizados (formato longo) de UM chamado na apidatalake.
async function fetchTicketCustomFields(ticketId) {
  return datalake.fetchTicketCamposDatalake(ticketId);
}

function extractModuloXRotina(campos, customFieldId = MODULO_CUSTOM_FIELD_ID) {
  const targetId = String(customFieldId);
  const campo = (campos || []).find(c => String(c.custom_field_id) === targetId);
  const valor = campo?.valor_texto;
  return valor ? String(valor).trim() : null;
}

let moduloProcessingState = {
  running: false, total: 0, processed: 0, updated: 0, skipped: 0, currentTicketId: null,
  startedAt: null, finishedAt: null, stopRequested: false, error: null
};
let activeModuloProcessing = null;

async function runModuloSyncLoop() {
  try {
    await ensureModuloVerificadoColumn();
    const movideskCfg = await getCuradoriaMovideskConfigPromise();

    const pending = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT ticket_id FROM public.curadoria_chamados WHERE modulo_x_rotina_verificado_em IS NULL ORDER BY ticket_id DESC`
    );
    moduloProcessingState.total = pending.rows.length;

    for (const row of pending.rows) {
      if (moduloProcessingState.stopRequested) break;
      moduloProcessingState.currentTicketId = row.ticket_id;

      try {
        const campos = await fetchTicketCustomFields(row.ticket_id);
        const modulo = extractModuloXRotina(campos, movideskCfg.moduloRotina?.customFieldId);
        const verificadoEm = new Date().toISOString();

        if (modulo) {
          await db.queryDatabase(
            'movidesk_curadoria',
            `UPDATE public.curadoria_chamados SET modulo_x_rotina = $1, modulo_x_rotina_verificado_em = $2 WHERE ticket_id = $3`,
            [modulo, verificadoEm, row.ticket_id]
          );
          moduloProcessingState.updated++;
        } else {
          // Verificado, mas o campo customizado veio vazio — marca como visto pra não
          // ficar tentando de novo a cada execução.
          await db.queryDatabase(
            'movidesk_curadoria',
            `UPDATE public.curadoria_chamados SET modulo_x_rotina_verificado_em = $1 WHERE ticket_id = $2`,
            [verificadoEm, row.ticket_id]
          );
          moduloProcessingState.skipped++;
        }
      } catch (err) {
        moduloProcessingState.skipped++;
        console.error(`Erro ao buscar módulo x rotina do chamado ${row.ticket_id}:`, err.message);
      }

      moduloProcessingState.processed++;
    }
  } catch (err) {
    moduloProcessingState.error = err.message;
    console.error('Erro na sincronização de módulo x rotina:', err.message);
  } finally {
    moduloProcessingState.running = false;
    moduloProcessingState.currentTicketId = null;
    moduloProcessingState.finishedAt = new Date().toISOString();
    activeModuloProcessing = null;
  }
}

function startModuloSyncJob() {
  if (activeModuloProcessing) return moduloProcessingState;
  moduloProcessingState = {
    running: true, total: 0, processed: 0, updated: 0, skipped: 0, currentTicketId: null,
    startedAt: new Date().toISOString(), finishedAt: null, stopRequested: false, error: null
  };
  activeModuloProcessing = runModuloSyncLoop();
  return moduloProcessingState;
}

// ===== GET /curadoria/modulo/pending-count =====
router.get('/modulo/pending-count', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    await ensureModuloVerificadoColumn();
    const result = await db.queryDatabase(
      'movidesk_curadoria',
      `SELECT COUNT(*) FROM public.curadoria_chamados WHERE modulo_x_rotina_verificado_em IS NULL`
    );
    res.json({ count: Number(result.rows[0].count) || 0 });
  } catch (error) {
    console.error('Erro ao contar pendentes de módulo x rotina:', error);
    res.status(500).json({ error: 'Erro ao contar pendentes de módulo x rotina' });
  }
});

// ===== POST /curadoria/modulo/sync =====
router.post('/modulo/sync', authMiddleware, requireRole('admin'), (req, res) => {
  const state = startModuloSyncJob();
  res.json(state);
});

// ===== GET /curadoria/modulo/sync/status =====
router.get('/modulo/sync/status', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(moduloProcessingState);
});

// ===== POST /curadoria/modulo/sync/stop =====
router.post('/modulo/sync/stop', authMiddleware, requireRole('admin'), (req, res) => {
  moduloProcessingState.stopRequested = true;
  res.json({ stopping: true });
});

// ===== Importação de chamados da API Movidesk → curadoria_chamados =====
// Busca chamados diretamente da API do Movidesk (com histórico completo de ações)
// e insere na tabela curadoria_chamados com processado=0, prontos para o pipeline
// de enriquecimento (IA, satisfação, módulo x rotina).
// Idempotente: usa INSERT ... ON CONFLICT DO NOTHING, portanto re-importar não
// duplica chamados. Só atualiza ações/status se o chamado já existia e processado=0.

const MOVIDESK_TICKETS_API = 'https://api.movidesk.com/public/v1/tickets';

let activeImportJob = null;
let importJobState = {
  running: false,
  status: 'idle',
  message: 'Aguardando importação',
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  totalFetched: 0,
  totalInserted: 0,
  totalSkipped: 0,
  lastError: null,
  params: null
};

function updateImportState(patch = {}) {
  importJobState = { ...importJobState, ...patch, updatedAt: new Date().toISOString() };
}

async function runMovideskImport({ token, dateFrom, dateTo, ownerTeam, ownerEmail, rateLimitMs = 3000 }) {
  const fetch = require('node-fetch');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  updateImportState({
    running: true, status: 'running', lastError: null,
    totalFetched: 0, totalInserted: 0, totalSkipped: 0,
    startedAt: new Date().toISOString(), completedAt: null,
    message: 'Conectando à API Movidesk...',
    params: { dateFrom, dateTo, ownerTeam, ownerEmail }
  });

  try {
    // Filtros OData
    const filterParts = [];
    if (dateFrom) filterParts.push(`createdDate ge ${dateFrom}T00:00:00Z`);
    if (dateTo)   filterParts.push(`createdDate le ${dateTo}T23:59:59Z`);
    if (ownerTeam)  filterParts.push(`ownerTeam eq '${ownerTeam.replace(/'/g, "''")}'`);
    if (ownerEmail) filterParts.push(`owner/email eq '${ownerEmail.replace(/'/g, "''")}'`);
    const odataFilter = filterParts.join(' and ');
    const filterExpr = odataFilter ? `&$filter=${encodeURIComponent(odataFilter)}` : '';

    const selectFields = 'id,subject,status,baseStatus,createdDate,resolvedIn,ownerTeam,urgency';
    const expandRelations = 'owner($select=businessName,email),actions($select=id,type,origin,status,createdDate,description;$expand=createdBy($select=businessName,email)),clients($select=businessName,email;$expand=organization($select=businessName))';

    const PAGE_SIZE = 100;
    let skip = 0;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore) {
      updateImportState({ message: `Buscando página (skip=${skip})…` });

      const url = `${MOVIDESK_TICKETS_API}?token=${encodeURIComponent(token)}&$select=${encodeURIComponent(selectFields)}${filterExpr}&$expand=${encodeURIComponent(expandRelations)}&$orderby=createdDate asc&$top=${PAGE_SIZE}&$skip=${skip}`;

      let tickets = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(url);
          if (resp.status === 429) {
            await sleep(rateLimitMs * 2);
            continue;
          }
          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Movidesk retornou ${resp.status}: ${body.slice(0, 200)}`);
          }
          const raw = await resp.json();
          tickets = Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          await sleep(2000 * (attempt + 1));
        }
      }

      if (!tickets.length) { hasMore = false; break; }

      totalFetched += tickets.length;
      updateImportState({ totalFetched, message: `Processando lote com ${tickets.length} chamado(s) (total: ${totalFetched})…` });

      // Insere cada chamado no banco
      for (const t of tickets) {
        const ownerName  = t.owner?.businessName || '';
        const ownerEmailVal = t.owner?.email || '';
        const actionsJson = JSON.stringify(t.actions || []);

        // Solicitante e organização
        const firstClient = Array.isArray(t.clients) ? t.clients[0] : null;
        const solicitante = firstClient?.businessName || '';
        const organizacao = firstClient?.organization?.businessName || '';

        // Contagens
        const actions = t.actions || [];
        const totalAcoes = actions.length;
        const totalCliente = actions.filter(a => (a.createdBy?.email || '') !== ownerEmailVal && a.type !== 1).length;
        const totalAgente  = actions.filter(a => a.type === 1 || (a.createdBy?.email || '') === ownerEmailVal).length;

        // Tempo de resolução em dias
        let tempoResolDias = null;
        if (t.createdDate && t.resolvedIn) {
          const ms = new Date(t.resolvedIn) - new Date(t.createdDate);
          if (ms > 0) tempoResolDias = Math.round(ms / 86400000 * 10) / 10;
        }

        try {
          const result = await db.queryDatabase(
            'movidesk_curadoria',
            `INSERT INTO public.curadoria_chamados
               (ticket_id, servico, owner, owner_team, status, urgencia,
                solicitante, organizacao, actions, total_acoes, total_cliente, total_agente,
                tempo_resol_dias, aberto_em, resolvido_em, processado)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,0)
             ON CONFLICT (ticket_id) DO UPDATE SET
               status        = EXCLUDED.status,
               actions       = EXCLUDED.actions,
               total_acoes   = EXCLUDED.total_acoes,
               aberto_em     = EXCLUDED.aberto_em,
               resolvido_em  = EXCLUDED.resolvido_em
             WHERE curadoria_chamados.processado = 0`,
            [
              t.id,
              t.subject || '',
              ownerName,
              t.ownerTeam || '',
              t.status || '',
              t.urgency || '',
              solicitante,
              organizacao,
              actionsJson,
              totalAcoes,
              totalCliente,
              totalAgente,
              tempoResolDias,
              t.createdDate || null,
              t.resolvedIn || null
            ]
          );
          // rowCount=1 → inseriu; rowCount=0 → conflito (já existia, pulou)
          if ((result.rowCount || 0) > 0) {
            importJobState.totalInserted++;
          } else {
            importJobState.totalSkipped++;
          }
        } catch (insertErr) {
          console.error(`[import-curadoria] Erro ao inserir ticket ${t.id}:`, insertErr.message);
          importJobState.totalSkipped++;
        }
      }

      // Próxima página ou encerramento
      if (tickets.length < PAGE_SIZE) { hasMore = false; }
      else { skip += PAGE_SIZE; await sleep(rateLimitMs); }
    }

    updateImportState({
      running: false, status: 'completed',
      message: `Concluído: ${importJobState.totalInserted} inserido(s), ${importJobState.totalSkipped} já existentes.`,
      completedAt: new Date().toISOString()
    });
    console.log(`✅ [import-curadoria] Finalizado: ${importJobState.totalInserted} inseridos, ${importJobState.totalSkipped} pulados`);
  } catch (err) {
    console.error('[import-curadoria] Falhou:', err.message || err);
    updateImportState({
      running: false, status: 'error',
      message: `Erro: ${err.message}`,
      lastError: err.message,
      completedAt: new Date().toISOString()
    });
  } finally {
    activeImportJob = null;
  }
}

// ===== POST /curadoria/import =====
// Inicia importação de chamados da API Movidesk para curadoria_chamados.
// Body: { dateFrom, dateTo, ownerTeam, ownerEmail }
// dateFrom/dateTo no formato YYYY-MM-DD (obrigatório pelo menos dateFrom).
router.post('/import', authMiddleware, requireRole('admin'), async (req, res) => {
  if (activeImportJob) {
    return res.json({ running: true, state: importJobState, message: 'Importação já em andamento.' });
  }

  const { dateFrom, dateTo, ownerTeam, ownerEmail } = req.body || {};
  if (!dateFrom) {
    return res.status(400).json({ error: 'dateFrom é obrigatório (formato YYYY-MM-DD).' });
  }

  // Valida formato de data
  const dateRx = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRx.test(dateFrom) || (dateTo && !dateRx.test(dateTo))) {
    return res.status(400).json({ error: 'Datas devem estar no formato YYYY-MM-DD.' });
  }

  // Obtém token Movidesk
  let token;
  try {
    token = await new Promise((resolve, reject) => {
      getToken((err, t) => err ? reject(err) : resolve(t));
    });
  } catch (err) {
    return res.status(503).json({ error: 'Token Movidesk não configurado ou inválido.' });
  }

  const movideskCfg = await new Promise(resolve => {
    getCuradoriaMovideskConfig((err, cfg) => resolve(cfg || {}));
  });
  const rateLimitMs = movideskCfg.rateLimitMs || 3000;

  activeImportJob = runMovideskImport({ token, dateFrom, dateTo, ownerTeam, ownerEmail, rateLimitMs });
  res.json({ started: true, state: importJobState });
});

// ===== GET /curadoria/import/status =====
router.get('/import/status', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(importJobState);
});

// ===== DELETE /curadoria/import/cancel =====
// Sinaliza cancelamento (o loop checa activeImportJob; quando zerado, para)
router.delete('/import/cancel', authMiddleware, requireRole('admin'), (req, res) => {
  if (!activeImportJob) return res.json({ cancelled: false, message: 'Nenhuma importação em andamento.' });
  activeImportJob = null; // o loop para naturalmente na próxima iteração
  updateImportState({ running: false, status: 'cancelled', message: 'Cancelado pelo usuário.', completedAt: new Date().toISOString() });
  res.json({ cancelled: true });
});

// ===== Carga bruta (dispara os 3 jobs de enriquecimento de uma vez) =====
// "Foco de Atendimento" e os KPIs da Visão Geral são sempre calculados ao vivo a
// partir do que já está em curadoria_chamados — não precisam de "carga" própria.
// O que os deixa desatualizados é o enriquecimento (análise de IA, satisfação real,
// módulo x rotina) ficar defasado. Esta carga bruta dispara os 3 jobs já existentes
// de uma vez (cada um já é resumível e idempotente — não reprocessa o que já está ok).
let fullLoadLastRun = { at: null, source: null };

function runFullLoad(source = 'manual') {
  fullLoadLastRun = { at: new Date().toISOString(), source };
  startCuradoriaProcessingJob();
  startSlaEstouroRecalcJob();
  startSurveySyncJob();
  startModuloSyncJob();
  return fullLoadLastRun;
}

// ===== POST /curadoria/full-load =====
router.post('/full-load', authMiddleware, requireRole('admin'), (req, res) => {
  const lastRun = runFullLoad('manual');
  res.json({
    lastRun,
    processamento: curadoriaProcessingState,
    slaEstouro:    slaEstouroRecalcState,
    survey:        surveyProcessingState,
    modulo:        moduloProcessingState
  });
});

// ===== GET /curadoria/full-load/status =====
router.get('/full-load/status', authMiddleware, requireRole('admin'), (req, res) => {
  res.json({
    lastRun:       fullLoadLastRun,
    processamento: curadoriaProcessingState,
    slaEstouro:    slaEstouroRecalcState,
    survey:        surveyProcessingState,
    modulo:        moduloProcessingState
  });
});

router.runFullLoad = runFullLoad;
module.exports = router;
