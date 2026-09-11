const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const db = require('../db/remote');
const { getToken, getPrompt } = require('./config');
const { decryptToken } = require('../utils/crypto');
const { authMiddleware, requireRole } = require('./auth');
const datalake = require('../utils/datalakeClient');

const MOVIDESK_API = 'https://apimovidesk.viasoftcloud.com.br/tickets';

// Sentinela pro filtro de status da aba Movidesk representar chamados com
// baseStatus NULL/vazio no banco (linhas "stub" — só id, sem os outros dados
// do chamado). Precisa ser idêntico à constante MOVIDESK_STATUS_NONE em
// js/dashboard.js.
const MOVIDESK_STATUS_NONE = '__sem_status__';

// A aba Movidesk é renderizada dentro de um iframe. Ao trocar de aba esse
// iframe pode ser recriado e, sem este cache, as mesmas consultas grandes
// voltam ao Postgres imediatamente. O cache fica no servidor (e não em
// cookie/localStorage) para não expor nem replicar milhares de chamados no
// navegador. A chave inclui o escopo do usuário para preservar a restrição
// de supervisores por vertical.
const TICKETS_CACHE_TTL_MS = Number(process.env.TICKETS_CACHE_TTL_MS) || 60 * 1000;
const ticketsResponseCache = new Map();

function getViewerCacheKey(viewer, resource) {
  return `${resource}:${viewer.role || 'unknown'}:${viewer.vertical || ''}`;
}

function getCachedResponse(key) {
  const entry = ticketsResponseCache.get(key);
  if (!entry || Date.now() - entry.createdAt >= TICKETS_CACHE_TTL_MS) {
    ticketsResponseCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheResponse(key, value) {
  ticketsResponseCache.set(key, { createdAt: Date.now(), value });
  return value;
}

let activeSyncPromise = null;
let activeSyncState = {
  syncId: null,
  running: false,
  status: 'idle',
  phase: 'idle',
  message: 'Aguardando sincronizacao',
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  totalFetched: 0,
  totalSaved: 0,
  processedBatches: 0,
  lastBatchSize: 0,
  lastError: null,
};

function updateSyncState(patch = {}) {
  activeSyncState = {
    ...activeSyncState,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function getSyncState() {
  return { ...activeSyncState };
}

function normalizeTicketRow(row = {}) {
  return {
    id: row.id ?? row.ticket_id,
    subject: row.subject || '',
    status: row.status || '',
    baseStatus: row.baseStatus ?? row.basestatus ?? '',
    createdDate: row.createdDate ?? row.createddate ?? null,
    lastActionDate: row.lastActionDate ?? row.lastactiondate ?? null,
    lastUpdate: row.lastUpdate ?? row.lastupdate ?? null,
    serviceFirstLevelId: row.serviceFirstLevelId ?? row.servicefirstlevelid ?? null,
    serviceFirstLevel: row.serviceFirstLevel ?? row.servicefirstlevel ?? '',
    serviceSecondLevel: row.serviceSecondLevel ?? row.servicesecondlevel ?? '',
    slaAgreement: row.slaAgreement ?? row.slaagreement ?? '',
    slaAgreementRule: row.slaAgreementRule ?? row.slaagreementrule ?? '',
    slaSolutionTime: row.slaSolutionTime ?? row.slasolutiontime ?? null,
    slaResponseTime: row.slaResponseTime ?? row.slaresponsetime ?? null,
    slaSolutionDate: row.slaSolutionDate ?? row.slasolutiondate ?? null,
    slaSolutionDateIsPaused: row.slaSolutionDateIsPaused ?? row.slasolutiondateispaused ?? false,
    slaResponseDate: row.slaResponseDate ?? row.slaresponsedate ?? null,
    slaRealResponseDate: row.slaRealResponseDate ?? row.slarealresponsedate ?? null,
    ownerEmail: row.ownerEmail ?? row.owneremail ?? '',
    ownerName: row.ownerName ?? row.ownername ?? '',
    ownerTeam: row.ownerTeam ?? row.ownerteam ?? row.owner_team ?? '',
    clientName: row.clientName ?? row.clientname ?? '',
    clientEmail: row.clientEmail ?? row.clientemail ?? '',
    clientOrganization: row.clientOrganization ?? row.clientorganization ?? '',
    justification: row.justification ?? '',
    customFields: row.customFields ?? row.customfields ?? null,
    actionsCount: row.actionsCount ?? row.actionscount ?? 0,
    syncedAt: row.syncedAt ?? row.syncedat ?? null,
    updatedAt: row.updatedAt ?? row.updatedat ?? null,
    lastActionCreatedByBusinessName: row.lastActionCreatedByBusinessName ?? row.lastactioncreatedbybusinessname ?? '',
    lastActionOrigin: row.lastActionOrigin ?? row.lastactionorigin ?? '',
    cf_classificacao_de_ticket: row.cf_classificacao_de_ticket ?? '',
    urgencia: row.urgencia ?? '',
    actionsJson: row.actionsJson ?? row.actionsjson ?? null,
    clientsJson: row.clientsJson ?? row.clientsjson ?? null,
    statusHistoriesJson: row.statusHistoriesJson ?? row.statushistoriesjson ?? null
  };
}

// ── Adaptadores apidatalake (/tickets/:id nativo) → shape usado no resto do arquivo ──
//
// GET /tickets/:id (silver.ticket + gold.mv_ticket_campos_principais) já
// devolve os campos "base" do ticket com nomes minúsculos (basestatus,
// servicefirstlevel, owner_team, ...) que normalizeTicketRow() já sabe ler
// via fallback `row.baseStatus ?? row.basestatus`. O que falta mapear é só
// os sub-recursos (acoes/clientes/status-historico, buscados à parte por
// fetchNativeTicketDetail em datalakeClient.js) pros nomes que
// calcularSLAPrimeiroContato() e inferTicketContext() esperam
// (type/origin/createdDate/...).
//
// Ao contrário do antigo caminho via /legacy/tickets/:id (que exigia o
// escopo legacy:read, não concedido ao perfil painel-sla, e cujo
// tipo/origem de ação vinham como texto e precisavam de heurística pra virar
// os códigos numéricos do Movidesk), GET /tickets/:id/acoes já devolve
// `tipo`/`origem` como os códigos numéricos REAIS (confirmado contra payload
// real: tipo 2 = "ação pública", origem 0=Abertura/1=Cliente/2=Suporte/
// 9=Sistema) — não tem heurística nenhuma aqui.

function adaptNativeActionsToMovideskShape(acoes) {
  if (!Array.isArray(acoes)) return [];
  return acoes.map((a) => ({
    id: a.acao_id ?? null,
    type: a.tipo,
    origin: a.origem,
    status: a.status ?? '',
    description: a.descricao ?? '',
    createdDate: a.criado_em ?? null,
    isDeleted: false,
    createdBy: {
      id: a.criado_por_id ?? null,
      businessName: a.criado_por_nome ?? '',
      profileType: null
    }
  }));
}

function adaptNativeStatusHistoricoToMovideskShape(statusHistorico) {
  if (!Array.isArray(statusHistorico)) return [];
  return statusHistorico.map((s) => ({
    status: s.status ?? '',
    changedDate: s.alterado_em ?? null,
    justification: s.justificativa ?? ''
  }));
}

function adaptNativeClientsToMovideskShape(clientes) {
  if (!Array.isArray(clientes)) return [];
  return clientes.map((c) => ({
    id: c.cliente_id ?? null,
    businessName: c.nome ?? '',
    email: c.email ?? '',
    organization: {
      id: c.organizacao_id ?? null,
      businessName: c.organizacao_nome ?? ''
    }
  }));
}

// Junta o que fetchNativeTicketDetail() (datalakeClient.js) devolve num
// objeto que serve tanto pra normalizeTicketRow() (campos base, já
// compatíveis) quanto pro que precisa dos sub-recursos adaptados (SLA,
// resumo executivo).
function nativeRowToTicketShape(row) {
  if (!row) return null;
  return {
    ...row,
    // silver.ticket usa `ticket_id`, não `id` — calcularSLAPrimeiroContato()
    // (ticketId: ticket.id) e outros pontos do arquivo esperam `id`. Sem
    // isso, GET /:id/sla devolvia ticketId undefined (removido do JSON).
    id: row.id ?? row.ticket_id,
    actions: adaptNativeActionsToMovideskShape(row.acoes),
    clients: adaptNativeClientsToMovideskShape(row.clientes),
    statusHistories: adaptNativeStatusHistoricoToMovideskShape(row.statusHistorico),
  };
}

// Custom fields "principais" no /tickets/:id nativo vêm pivotados sem
// prefixo (causa, fato, agro_modulo_x_rotina, classificacao_de_ticket, ...),
// vindos de gold.mv_ticket_campos_principais — diferente do shape local
// (customFieldValues em blob JSON) e do antigo /legacy (colunas cf_*). Pra
// achar "o campo que fala de causa/fato/módulo x rotina/solicitante" sem
// saber o nome exato de antemão, escaneia as chaves do ticket pelo nome
// (mesma lógica de pickFromCustomField, só que sobre chaves em vez de blob
// JSON) — tolerando tanto colunas cf_*-prefixadas (shape local) quanto sem
// prefixo (shape nativo apidatalake).
function pickFromPivotedColumns(row, terms) {
  const keys = Object.keys(row || {});
  const match = keys.find((k) => {
    const name = (k.startsWith('cf_') ? k.slice(3) : k).replace(/_/g, '').toLowerCase();
    return terms.some((t) => name.includes(t.replace(/\s+/g, '')));
  });
  if (!match) return '';
  const value = row[match];
  return typeof value === 'string' ? value.trim() : (value ?? '');
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  if (value === '[object Object]') return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function inferTicketContext(ticket) {
  // Duas origens possíveis pro mesmo `ticket`: tabela local (customFields/
  // actionsJson/clientsJson/statusHistoriesJson como strings JSON, shape
  // original do Movidesk) ou apidatalake via nativeRowToTicketShape()
  // (actions/clients/statusHistories já como array adaptado, sem `customFields`
  // — só colunas pivotadas soltas no próprio objeto, ver pickFromPivotedColumns).
  // Aceita as duas.
  const customFields = safeJsonParse(ticket.customFields, []);
  const actions = Array.isArray(ticket.actions) ? ticket.actions : safeJsonParse(ticket.actionsJson, []);
  const clients = Array.isArray(ticket.clients) ? ticket.clients : safeJsonParse(ticket.clientsJson, []);
  const statusHistories = Array.isArray(ticket.statusHistories)
    ? ticket.statusHistories
    : safeJsonParse(ticket.statusHistoriesJson, []);
  const isInternalSystems = (ticket.serviceFirstLevel || ticket.servicefirstlevel || '').trim().toLowerCase() === 'sistemas internos';

  // Heuristica: tenta capturar valor por nome/chave, com fallback seguro.
  // Se não achar no blob customFields (shape local), tenta nas colunas
  // pivotadas soltas no ticket (shape apidatalake — ver pickFromPivotedColumns).
  function pickFromCustomField(terms) {
    const list = Array.isArray(customFields) ? customFields : [];
    const found = list.find((item) => {
      const blob = JSON.stringify(item || {}).toLowerCase();
      return terms.some((t) => blob.includes(t));
    });
    if (found) {
      if (typeof found.value === 'string' && found.value.trim()) return found.value.trim();
      if (Array.isArray(found.items) && found.items.length) {
        return found.items
          .map((i) => i.businessName || i.value || i.label || '')
          .filter(Boolean)
          .join(', ');
      }
    }
    return pickFromPivotedColumns(ticket, terms);
  }

  return {
    isInternalSystems,
    ticketJson: {
      ...ticket,
      customFields,
      actions,
      clients,
      statusHistories
    },
    actions,
    solicitante: pickFromCustomField(['solicitante']) || ticket.clientName || ticket.clientname || '',
    fato: pickFromCustomField(['fato']) || ticket.subject || '',
    causa: pickFromCustomField(['causa']) || '',
    ModuloXRotina: pickFromCustomField(['moduloxrotina', 'modulo x rotina', 'modulo'])
      || ticket.serviceSecondLevel || ticket.servicesecondlevel
      || ticket.serviceFirstLevel || ticket.servicefirstlevel || '',
    subject: ticket.subject || '',
    owner: {
      businessName: ticket.ownerName || ticket.ownername || '',
      email: ticket.ownerEmail || ticket.owneremail || ''
    }
  };
}

function buildExecutivePrompt(context) {
  const actionsJson = JSON.stringify(context.actions || [], null, 2);
  const ticketJson = JSON.stringify(context.ticketJson || {}, null, 2);
  return `Analise o ticket JSON abaixo e retorne APENAS um objeto JSON valido com todos os campos preenchidos com dados reais do ticket.

JSON DO TICKET:
${ticketJson}

Voce e um analista senior de suporte critico que analisa tickets de suporte em JSON.

REGRAS ABSOLUTAS:
- Analise TODO o JSON do ticket fornecido, incluindo campos principais, customFields, actions, clients e statusHistories
- Se serviceFirstLevel for exatamente "Sistemas Internos", nao use causa, fato nem ModuloXRotina como base da analise, porque esses campos podem nao existir ou nao ser aplicaveis
- Em tickets de Sistemas Internos, baseie diagnostico, urgencia e impacto principalmente em subject, description, justification, actions, clients, statusHistories e demais campos reais do ticket
- Nao limite a analise apenas ao subject, causa, fato ou actions; use o objeto completo como fonte primária
- Ignore acoes com type = 1 (acoes internas de escalonamento/atribuicao)
- Ignore acoes onde createdBy.id = "007" (acoes de sistema)
- Suporte = createdBy com email contendo @viasoft.com.br OU createdBy.businessName === owner.businessName (quando businessName nao for vazio)
- Cliente = usuario solicitante do chamado ${context.solicitante || ''}
- Fato relatado = ${context.fato || ''}
- Causa identificada = ${context.causa || ''}
- Modulo X Rotina = ${context.ModuloXRotina || ''}
- Responda APENAS com um JSON valido, sem markdown, sem texto adicional, sem crases, sem blocos de codigo
- Preencha TODOS os campos com dados reais do JSON do ticket
- Nunca use dados ficticios como user123 ou owner@example.com
- Use SEMPRE os nomes e e-mails reais presentes no JSON fornecido

REGRAS PRIORITARIAS DE URGENCIA:
- Se subject ou description tiver: falha catastrófica/falha catastrofica/indisponível/indisponivel/fora do ar/sistema parado/nao abre/nao funciona em funcao essencial => urgencia critica
- Se houver tag urgencia_suporte => urgencia minima alta
- Se bloquear totalmente pedido venda/compra, emissao fiscal, pagamento/recebimento, fechamento caixa, login => urgencia critica
- Considere fato, causa e ModuloXRotina para reforcar ou elevar urgencia

VALORES VALIDOS DE URGENCIA:
- critica, alta, media, baixa

CLASSIFICACAO DE PERFIL DO CLIENTE:
- Escolha exatamente um entre: neutro, moderado, ansioso, agressivo, detalhista, leigo
- perfil_cliente_descricao deve explicar o principal sinal observado

ANALISE ENCADEADA:
- Diagnostico deve seguir: causa -> modulo/rotina -> fato
- modulo_rotina deve manter o valor EXATO de ModuloXRotina
- modulo_rotina_normalizado apenas para par_agrupamento
- fato_palavras_chave: 2 a 5 termos normalizados
- compilado_causa_modulo_fato em texto natural sem underscores
- Excecao: se o ticket for de Sistemas Internos, o diagnostico nao deve depender de causa, fato ou ModuloXRotina; nesses casos, preencha esses campos apenas com "Nao se aplica a Sistemas Internos" quando nao houver valor real no JSON

CLASSIFICACAO DE SATISFACAO DO CLIENTE (campo satisfacao):
- Avalie a satisfacao real do CLIENTE com o atendimento prestado, numa escala de 1 a 10
- NUNCA retorne um valor fixo ou padrao; calcule com base em sinais concretos do ticket:
  * Cliente elogiou o atendimento, agradeceu, resolveu rapido, sem reclamacoes => 8 a 10
  * Atendimento neutro, sem elogios nem reclamacoes, resolucao dentro do esperado => 5 a 7
  * Cliente demonstrou frustracao, repetiu o pedido, reclamou de demora, mas problema foi resolvido => 3 a 4
  * Cliente reclamou explicitamente, ticket reaberto, problema nao resolvido, tom agressivo/irritado => 1 a 2
- Use o campo sentimento (positivo|neutro|negativo) e o padrao_emocional do cliente como base, mas a nota deve refletir a INTENSIDADE do sentimento, nao apenas a categoria
- Tickets sem nenhuma interacao do cliente apos a resolucao (sem como medir satisfacao) devem usar 6 como neutro-padrao, mas isso deve ser RARO — priorize sempre analisar o tom das mensagens do cliente

RESPONDA EXATAMENTE no formato JSON abaixo, preenchendo todos os campos:
{
  "tabela_acoes": [
    { "id": 1, "origem": "Abertura|Cliente|Suporte|Sistema", "criado_por": "Nome Real da Pessoa", "ator": "Cliente|Suporte" }
  ],
  "total_acoes": 0,
  "total_cliente": 0,
  "total_agente": 0,
  "comportamento_cliente": {
    "nome": "Nome do Cliente",
    "perfil": "descricao do perfil comportamental",
    "pontos": [
      "Proatividade inicial (ID X): descricao do comportamento",
      "Humildade para perguntar (ID Y): descricao",
      "Seguimento de instrucoes (ID Z): descricao",
      "Busca por clareza (ID W): descricao",
      "Agilidade na resposta (ID V): descricao"
    ],
    "padrao_emocional": "descricao do tom, presenca de frustracao, etc."
  },
  "perfil_cliente": "neutro|moderado|ansioso|agressivo|detalhista|leigo",
  "perfil_cliente_descricao": "Frase explicando o sinal principal que levou a essa classificacao",
  "comportamento_suporte": [
    {
      "nome": "Nome do Analista",
      "ids": [1, 2],
      "pontos": ["ponto de analise 1", "ponto de analise 2"]
    }
  ],
  "padrao_suporte": "descricao geral do padrao de atendimento",
  "dinamica_conversa": {
    "cliente_para_suporte": "resumo de como o cliente se comunicou",
    "suporte_para_cliente": "evolucao do atendimento",
    "tempo_resposta": "exemplos de intervalos entre respostas"
  },
  "pontos_criticos": {
    "acertos": ["acerto 1", "acerto 2"],
    "melhorias": ["melhoria 1", "melhoria 2"]
  },
  "conclusao": "Resumo final da analise comportamental em 2-3 frases",
  "urgencia": "critica",
  "evidencias_urgencia": [
    { "comportamento": "descricao do comportamento observado", "indicacao": "o que indica sobre urgencia" }
  ],
  "cliente_nao_fez": ["item relevante para urgencia 1", "item 2"],
  "impacto_real": "descricao do impacto operacional inferido do problema",
  "diagnostico": {
    "causa": "Reproducao fiel do campo causa do ticket",
    "causa_normalizada": "versao normalizada da causa",
    "modulo_rotina": "Valor EXATO e ORIGINAL do campo ModuloXRotina",
    "modulo_rotina_normalizado": "versao tecnica para par_agrupamento",
    "fato": "Reproducao fiel do campo fato do ticket",
    "fato_palavras_chave": ["palavra_chave_1", "palavra_chave_2"],
    "fato_categoria_principal": "uma palavra chave principal",
    "compilado_causa_modulo_fato": "Frase em portugues corrido SEM underscores",
    "relacao_fato_causa": "Analise de como o fato explica a causa no modulo",
    "impacto_inferido": "Implicacao operacional",
    "par_agrupamento": "causa_normalizada::modulo_rotina_normalizado::fato_categoria_principal"
  },
  "nota_urgencia": 4,
  "nota_urgencia_descricao": "Critica",
  "justificativa_urgencia": "Justificativa em no maximo 3 frases",
  "recomendacao_atendente": "Orientacao pratica para o atendente",
  "sentimento": "positivo|neutro|negativo (escolha o real)",
  "satisfacao": "numero de 1 a 10 calculado conforme as regras de CLASSIFICACAO DE SATISFACAO acima — NAO copie este texto, calcule o valor real",
  "alertas": ["alerta identificado 1"]
}

const DEFAULT_EXECUTIVE_PROMPT = buildExecutivePrompt({
  actions: [],
  isInternalSystems: false,
  solicitante: '',
  fato: '',
  causa: '',
  ModuloXRotina: '',
  subject: '',
  owner: { businessName: '', email: '' }
});

VALORES VALIDOS:
- urgencia: critica|alta|media|baixa
- sentimento: positivo|neutro|negativo
- perfil_cliente: neutro|moderado|ansioso|agressivo|detalhista|leigo
- satisfacao: inteiro 1..10 calculado por sinais reais do ticket (ver regras de CLASSIFICACAO DE SATISFACAO acima). Varie o valor conforme o caso real — nao use sempre o mesmo numero
- nota_urgencia: 1..4
- origem em tabela_acoes: origin 0=Abertura, 1=Cliente, 2=Suporte, 9=Sistema

Ticket de Sistemas Internos:
${context.isInternalSystems ? 'sim' : 'nao'}

Actions do ticket (JSON):
${actionsJson}`;
}

async function generateExecutiveSummaryFromLLM(context) {
  const apiKey = await new Promise((resolve) => {
    db.get('SELECT value FROM config WHERE key = ?', ['openai_api_key'], (err, row) => {
      if (err || !row || !row.value) return resolve(process.env.OPENAI_API_KEY || null);
      try {
        resolve(decryptToken(row.value));
      } catch (e) {
        resolve(process.env.OPENAI_API_KEY || null);
      }
    });
  });
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY nao configurada no servidor');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const prompt = await new Promise((resolve) => {
    getPrompt((err, storedPrompt) => {
      if (err || !storedPrompt) {
        return resolve(buildExecutivePrompt(context));
      }
      resolve(renderConfiguredPrompt(storedPrompt, context));
    });
  });
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      input: [
        {
          role: 'system',
          content: [{
            type: 'input_text',
            text: 'Use o prompt do usuario como instrucao principal. Use o JSON completo do ticket fornecido nesta conversa como fonte obrigatoria dos dados. Responda apenas com JSON valido.'
          }]
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            {
              type: 'input_text',
              text: `CONTEXTO ADICIONAL DO TICKET (sempre use estes dados reais, mesmo se o prompt nao tiver placeholders corretos):\n\nTicket completo:\n${JSON.stringify(context.ticketJson || {}, null, 2)}\n\nActions:\n${JSON.stringify(context.actions || [], null, 2)}\n\nSolicitante: ${context.solicitante || ''}\nFato: ${context.fato || ''}\nCausa: ${context.causa || ''}\nModuloXRotina: ${context.ModuloXRotina || ''}\nSubject: ${context.subject || ''}\nOwner businessName: ${context.owner?.businessName || ''}\nOwner email: ${context.owner?.email || ''}\nSistemas Internos: ${context.isInternalSystems ? 'sim' : 'nao'}`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Falha ao gerar resumo executivo: ${response.status} ${errText}`);
  }

  const payload = await response.json();
  const text = extractTextFromResponsesPayload(payload);

  // Capturar usage de tokens para o log
  try {
    const usage = payload?.usage || {};
    const inputTok  = usage.input_tokens  || usage.prompt_tokens     || 0;
    const outputTok = usage.output_tokens || usage.completion_tokens  || 0;
    if (inputTok > 0 || outputTok > 0) {
      db.run(
        `INSERT INTO ai_usage_log (source, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd, user_email)
         VALUES (?, ?, ?, ?, ?, ?,  ?)`,
        [
          'executive_summary',
          model,
          inputTok,
          outputTok,
          inputTok + outputTok,
          (() => {
            const prices = { 'gpt-4o-mini': [0.15, 0.60], 'gpt-4.1-mini': [0.40, 1.60], 'gpt-4o': [5.00, 15.00], 'gpt-4.1': [2.00, 8.00] };
            const [pi, po] = prices[model] || prices['gpt-4o-mini'];
            return ((inputTok * pi) + (outputTok * po)) / 1_000_000;
          })(),
          null
        ],
        () => {}
      );
    }
  } catch (_) {}

  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(text));
  } catch (e) {
    parsed = JSON.parse(extractFirstJsonObject(text));
  }

  return parsed;
}

function renderConfiguredPrompt(storedPrompt, context) {
  const replacements = [
    [/\{\{\s*ticketJson\s*\}\}/g, JSON.stringify(context.ticketJson || {}, null, 2)],
    [/\{\{\s*ticketjson\s*\}\}/g, JSON.stringify(context.ticketJson || {}, null, 2)],
    [/\{\{\s*actionsJson\s*\}\}/g, JSON.stringify(context.actions || [], null, 2)],
    [/\{\{\s*actionsjson\s*\}\}/g, JSON.stringify(context.actions || [], null, 2)],
    [/\{\{\s*solicitante\s*\}\}/g, context.solicitante || ''],
    [/\{\{\s*fato\s*\}\}/g, context.fato || ''],
    [/\{\{\s*causa\s*\}\}/g, context.causa || ''],
    [/\{\{\s*ModuloXRotina\s*\}\}/g, context.ModuloXRotina || ''],
    [/\{\{\s*subject\s*\}\}/g, context.subject || ''],
    [/\{\{\s*ownerBusinessName\s*\}\}/g, context.owner?.businessName || ''],
    [/\{\{\s*ownerEmail\s*\}\}/g, context.owner?.email || ''],
    [/\{\{\s*\$json\.solicitante\s*\}\}/g, context.solicitante || ''],
    [/\{\{\s*\$json\.fato\s*\}\}/g, context.fato || ''],
    [/\{\{\s*\$json\.causa\s*\}\}/g, context.causa || ''],
    [/\{\{\s*\$json\.ModuloXRotina\s*\}\}/g, context.ModuloXRotina || ''],
    [/\{\{\s*\$json\.subject\s*\}\}/g, context.subject || ''],
    [/\{\{\s*\$json\.ownerBusinessName\s*\}\}/g, context.owner?.businessName || ''],
    [/\{\{\s*\$json\.ownerEmail\s*\}\}/g, context.owner?.email || ''],
    [/\=\{\{\s*\$json\.actions\s*\}\}/g, JSON.stringify(context.actions || [], null, 2)],
    [/\{\{\s*\$json\.actions\s*\}\}/g, JSON.stringify(context.actions || [], null, 2)]
  ];

  let rendered = storedPrompt;
  for (const [pattern, value] of replacements) {
    rendered = rendered.replace(pattern, value);
  }
  return rendered;
}

function extractTextFromResponsesPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }

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

function cleanJsonText(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function extractFirstJsonObject(text) {
  const cleaned = cleanJsonText(text);
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('Modelo nao retornou JSON valido');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  throw new Error('Modelo nao retornou JSON valido');
}

function resolveViewerContext(req) {
  return new Promise((resolve) => {
    const token = req.headers.authorization?.replace('Bearer ', '').trim();
    if (!token) {
      return resolve({
        role: req.query.viewerRole || null,
        vertical: req.query.viewerVertical || null,
      });
    }

    db.get(
      `SELECT r.name as role, u.vertical
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE s.token = ? AND s.expires_at > NOW()`,
      [token],
      (err, row) => {
        if (err || !row) {
          return resolve({
            role: req.query.viewerRole || null,
            vertical: req.query.viewerVertical || null,
          });
        }
        resolve({ role: row.role, vertical: row.vertical || null });
      }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDbUnavailableError(error) {
  const code = error?.code || '';
  return [
    'ENETUNREACH',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND'
  ].includes(code);
}

function isMovideskDnsError(error) {
  const code = error?.code || '';
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

async function ensureDbAvailable() {
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 AS ok', [], (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

// Validar se um ticket passa pelos filtros de customField (fallback para API)
function ticketMatchesCustomFieldFilter(ticket, customFieldId, customFieldValue) {
  if (!customFieldId || !customFieldValue) return true;
  
  const customFieldValues = ticket.customFieldValues || [];
  const cfvArray = Array.isArray(customFieldValues) ? customFieldValues : [];
  
  // Procurar pelo campo customizado
  const field = cfvArray.find(cfv => {
    const cfId = cfv.customFieldId || cfv.customfieldid;
    return cfId && String(cfId) === String(customFieldId);
  });
  
  if (!field) return false;
  
  // Verificar se algum item do campo corresponde ao valor
  const items = field.items || [];
  const itemsArray = Array.isArray(items) ? items : [];
  
  return itemsArray.some(item => {
    const itemValue = item.customFieldItem || item.customfielditem || '';
    return String(itemValue).trim() === String(customFieldValue).trim();
  });
}

function getTicketConditions(conditions = {}) {
  const primary = {
    ownerTeam: conditions.ownerTeam || '',
    serviceFirstLevel: conditions.serviceFirstLevel || ''
  };
  const extra = Array.isArray(conditions.teamConditions) ? conditions.teamConditions : [];
  return [primary, ...extra].map((condition) => ({
    ownerTeam: String(condition?.ownerTeam || '').trim(),
    serviceFirstLevel: String(condition?.serviceFirstLevel || '').trim()
  }));
}

function buildTicketConditionsFilter(conditions) {
  const teams = getTicketConditions(conditions).map((condition) => {
    const group = [];
    if (condition.ownerTeam) group.push(`ownerTeam eq '${condition.ownerTeam.replace(/'/g, "''")}'`);
    if (condition.serviceFirstLevel) group.push(`serviceFirstLevel eq '${condition.serviceFirstLevel.replace(/'/g, "''")}'`);
    return group.length ? `(${group.join(' and ')})` : '';
  }).filter(Boolean);
  const parts = [];
  if (teams.length) parts.push(`(${teams.join(' or ')})`);
  if (conditions.customFieldId && conditions.customFieldValue) {
    parts.push(`customFieldValues/any(cfv: cfv/customFieldId eq ${conditions.customFieldId} and cfv/items/any(i: i/customFieldItem eq '${String(conditions.customFieldValue).replace(/'/g, "''")}'))`);
  }
  return parts.join(' and ');
}

function ticketMatchesAnyConfiguredCondition(ticket, conditions) {
  const configuredConditions = getTicketConditions(conditions);
  const ticketTeam = String(ticket.ownerTeam || ticket.ownerteam || ticket.owner?.team || '').trim();
  const matchesTeamCondition = configuredConditions.some((condition) => {
    if (condition.ownerTeam && ticketTeam !== condition.ownerTeam) return false;
    return !condition.serviceFirstLevel || String(ticket.serviceFirstLevel || '').trim() === condition.serviceFirstLevel;
  });
  if (!matchesTeamCondition) return false;
  return ticketMatchesCustomFieldFilter(ticket, conditions.customFieldId, conditions.customFieldValue);
}

async function fetchTicketsFromApi(token, skip = 0, attempt = 0, conditions = null, options = {}) {
  const endpointPath = options.endpointPath || '';
  const applyStatusFilter = options.applyStatusFilter !== false;
  const customFilter = typeof options.customFilter === 'string' ? options.customFilter.trim() : '';

  // Se conditions não foi passado, usar padrões
  if (!conditions) {
    conditions = {
      statuses: ['New', 'InAttendance', 'Stopped'],
      serviceFirstLevel: '',
      customFieldId: '23946',
      customFieldValue: 'Suporte Técnico',
      syncLimit: 100,
      ownerTeam: 'VIASOFT - Sistemas Internos',
      excludedBaseStatuses: ['Resolved', 'Closed', 'Canceled'],
      selectFields: 'id,subject,status,baseStatus,createdDate,lastActionDate,lastUpdate,serviceFirstLevelId,serviceFirstLevel,serviceSecondLevel,slaAgreement,slaAgreementRule,slaSolutionTime,slaResponseTime,slaSolutionDate,slaSolutionDateIsPaused,slaResponseDate,slaRealResponseDate,justification,ownerTeam',
      expandRelations: 'owner,actions($select=id,type,origin,status,createdDate,description;$expand=createdBy),customFieldValues($expand=items),clients($expand=organization)'
    };
  }

  const top = conditions.syncLimit || 100;

  // Montar filtro OData com push/join para evitar 'and' duplicado
  const filterParts = [];

  // 1. Filtro customizado externo (ex: excludedBaseStatuses já montados pelo chamador)
  if (customFilter) {
    filterParts.push(customFilter);
  }

  // 2. Filtro de status positivos (baseStatus eq '...')
  if (applyStatusFilter && Array.isArray(conditions.statuses) && conditions.statuses.length > 0) {
    const statusParts = conditions.statuses.map(s => `baseStatus eq '${s}'`);
    filterParts.push(`(${statusParts.join(' or ')})`);
  }

  // 3. Filtro de serviceFirstLevel
  if (!options.skipConfiguredFilters && conditions.serviceFirstLevel && conditions.serviceFirstLevel.trim()) {
    filterParts.push(`serviceFirstLevel eq '${conditions.serviceFirstLevel.trim()}'`);
  }

  // 4. Filtro de customField
  if (!options.skipConfiguredFilters && conditions.customFieldId && conditions.customFieldValue) {
    filterParts.push(`customFieldValues/any(cfv: cfv/customFieldId eq ${conditions.customFieldId} and cfv/items/any(i: i/customFieldItem eq '${conditions.customFieldValue}'))`);
  }

  const odataFilter = filterParts.filter(Boolean).join(' and ');
  console.log('Filtro Movidesk:', odataFilter);

  const filterExpr = odataFilter ? `&$filter=${odataFilter}` : '';

  // Usar campos e expand dinâmicos das configurações
  const selectFields = conditions.selectFields || 'id,subject,status,baseStatus,createdDate,lastActionDate,lastUpdate,serviceFirstLevelId,serviceFirstLevel,serviceSecondLevel,slaAgreement,slaAgreementRule,slaSolutionTime,slaResponseTime,slaSolutionDate,slaSolutionDateIsPaused,slaResponseDate,slaRealResponseDate,justification,ownerTeam';
  const expandRelations = conditions.expandRelations || 'owner,actions($select=id,type,origin,status,createdDate,description;$expand=createdBy),customFieldValues($expand=items),clients($expand=organization)';

  const query = `?token=${encodeURIComponent(token)}&$select=${encodeURIComponent(selectFields)}${filterExpr}&$expand=${encodeURIComponent(expandRelations)}&$orderby=createdDate asc&$top=${top}&$skip=${skip}`;

  try {
    const requestUrl = `${MOVIDESK_API}${endpointPath}${query}`;
    console.log(`Movidesk URL [${endpointPath || '/'} | skip=${skip}]: ${requestUrl}`);
    const response = await fetch(requestUrl);
    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      const errDetail = typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(parsed || {}).slice(0, 500);
      const msg = `API Movidesk retornou: ${response.status}${errDetail ? ` - ${errDetail}` : ''}`;

      if (response.status === 429 && attempt < 3) {
        const waitMs = 1500 * (attempt + 1);
        console.warn(`Movidesk rate limit (429). Tentando novamente em ${waitMs}ms...`);
        await sleep(waitMs);
        return fetchTicketsFromApi(token, skip, attempt + 1, conditions, options);
      }

      throw new Error(msg);
    }

    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.value)) return parsed.value;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [];
  } catch (error) {
    // ECONNRESET / ETIMEDOUT geralmente indica fim de dados ou limite da API
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      if (attempt < 2) {
        const waitMs = 2000 * (attempt + 1);
        console.warn(`Movidesk ECONNRESET no skip=${skip}. Tentando novamente em ${waitMs}ms...`);
        await sleep(waitMs);
        return fetchTicketsFromApi(token, skip, attempt + 1, conditions, options);
      }
      console.warn(`Movidesk encerrou conexão no skip=${skip}. Tratando como fim de dados.`);
      return null; // sinaliza fim de paginação
    }

    // DNS instável da API Movidesk
    if (isMovideskDnsError(error) && attempt < 3) {
      const waitMs = 1500 * (attempt + 1);
      console.warn(`DNS da Movidesk falhou no skip=${skip}. Tentando novamente em ${waitMs}ms...`);
      await sleep(waitMs);
      return fetchTicketsFromApi(token, skip, attempt + 1, conditions, options);
    }

    console.error('Erro ao buscar tickets:', error);
    throw error;
  }
}

function saveTicketToDb(ticket) {
  return new Promise((resolve, reject) => {
    const customFields = JSON.stringify(ticket.customFieldValues || []);
    const actionsJson = JSON.stringify(ticket.actions || []);
    const clientsJson = JSON.stringify(ticket.clients || []);
    const statusHistoriesJson = JSON.stringify(ticket.statusHistories || []);
    const client = ticket.clients?.[0];
    const owner = ticket.owner;
    const ownerTeam = ticket.ownerTeam || ticket.ownerteam || owner?.team || null;
    const justification = ticket.justification ?? ticket.description ?? null;

    // Última ação: maior id, ignorando ações sem createdBy
    const actions = ticket.actions || [];
    const actionsWithAuthor = actions.filter(a => a.createdBy != null);
    actionsWithAuthor.sort((a, b) => b.id - a.id);
    const lastAction = actionsWithAuthor[0];
    const lastActionCreatedByBusinessName = lastAction?.createdBy?.businessName || null;
    
    // Determinar origin: "Customer" ou "Attendant"
    let lastActionOrigin = 'Attendant'; // padrão
    
    if (lastAction && lastAction.createdBy) {
      if (lastAction.createdBy.profileType === 3) {
        // É um agente/support
        if (lastAction.createdBy.id && owner && lastAction.createdBy.id !== owner.id) {
          lastActionOrigin = 'Customer'; // outro agente = cliente
        } else {
          lastActionOrigin = 'Attendant'; // é o owner ou sem comparação possível
        }
      } else if (lastAction.origin === 1 || lastAction.origin === 8) {
        // origin 1 e 8 = cliente
        lastActionOrigin = 'Customer';
      }
    }

    db.run(
      `INSERT INTO tickets (
        id, subject, status, baseStatus, createdDate, lastActionDate, lastUpdate,
        serviceFirstLevelId, serviceFirstLevel, serviceSecondLevel, slaAgreement,
        slaAgreementRule, slaSolutionTime, slaResponseTime, slaSolutionDate,
        slaSolutionDateIsPaused, slaResponseDate, slaRealResponseDate,
        ownerEmail, ownerName, owner_team, clientName, clientEmail, clientOrganization,
        justification,
        customFields, actionsJson, clientsJson, statusHistoriesJson,
        actionsCount, lastActionCreatedByBusinessName, lastActionOrigin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        subject = EXCLUDED.subject,
        status = EXCLUDED.status,
        baseStatus = EXCLUDED.baseStatus,
        createdDate = EXCLUDED.createdDate,
        lastActionDate = EXCLUDED.lastActionDate,
        lastUpdate = EXCLUDED.lastUpdate,
        serviceFirstLevelId = EXCLUDED.serviceFirstLevelId,
        serviceFirstLevel = EXCLUDED.serviceFirstLevel,
        serviceSecondLevel = EXCLUDED.serviceSecondLevel,
        slaAgreement = EXCLUDED.slaAgreement,
        slaAgreementRule = EXCLUDED.slaAgreementRule,
        slaSolutionTime = EXCLUDED.slaSolutionTime,
        slaResponseTime = EXCLUDED.slaResponseTime,
        slaSolutionDate = EXCLUDED.slaSolutionDate,
        slaSolutionDateIsPaused = EXCLUDED.slaSolutionDateIsPaused,
        slaResponseDate = EXCLUDED.slaResponseDate,
        slaRealResponseDate = EXCLUDED.slaRealResponseDate,
        ownerEmail = EXCLUDED.ownerEmail,
        ownerName = EXCLUDED.ownerName,
        owner_team = EXCLUDED.owner_team,
        clientName = EXCLUDED.clientName,
        clientEmail = EXCLUDED.clientEmail,
        clientOrganization = EXCLUDED.clientOrganization,
        justification = EXCLUDED.justification,
        customFields = EXCLUDED.customFields,
        actionsJson = EXCLUDED.actionsJson,
        clientsJson = EXCLUDED.clientsJson,
        statusHistoriesJson = EXCLUDED.statusHistoriesJson,
        actionsCount = EXCLUDED.actionsCount,
        lastActionCreatedByBusinessName = EXCLUDED.lastActionCreatedByBusinessName,
        lastActionOrigin = EXCLUDED.lastActionOrigin,
        syncedAt = NOW(),
        updatedAt = NOW()`,
      [
        ticket.id,
        ticket.subject,
        ticket.status,
        ticket.baseStatus,
        ticket.createdDate,
        ticket.lastActionDate,
        ticket.lastUpdate,
        ticket.serviceFirstLevelId,
        ticket.serviceFirstLevel,
        ticket.serviceSecondLevel,
        ticket.slaAgreement,
        ticket.slaAgreementRule,
        ticket.slaSolutionTime,
        ticket.slaResponseTime,
        ticket.slaSolutionDate,
        ticket.slaSolutionDateIsPaused ? 1 : 0,
        ticket.slaResponseDate,
        ticket.slaRealResponseDate,
        owner?.email || null,
        owner?.businessName || null,
        ownerTeam,
        client?.businessName || null,
        client?.email || null,
        client?.organization?.businessName || null,
        justification,
        customFields,
        actionsJson,
        clientsJson,
        statusHistoriesJson,
        actions.length,
        lastActionCreatedByBusinessName,
        lastActionOrigin
      ],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function markMissingTicketsAsClosed(collectedIds) {
  return new Promise((resolve, reject) => {
    const openStatuses = ['New', 'InAttendance', 'Stopped', 'InProgress'];
    const openPlaceholders = openStatuses.map(() => '?').join(',');
    const params = [...openStatuses];

    let sql = `
      UPDATE tickets
      SET
        baseStatus = 'Closed',
        status = CASE
          WHEN status IS NULL OR status = '' OR baseStatus IN (${openPlaceholders}) THEN 'Fechado'
          ELSE status
        END,
        updatedAt = NOW(),
        syncedAt = NOW()
      WHERE baseStatus IN (${openPlaceholders})
    `;

    params.push(...openStatuses);

    if (Array.isArray(collectedIds) && collectedIds.length > 0) {
      const idPlaceholders = collectedIds.map(() => '?').join(',');
      sql += ` AND id NOT IN (${idPlaceholders})`;
      params.push(...collectedIds);
    }

    db.run(sql, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function collectCurrentOpenTicketIds(token, conditions) {
  const excludedStatusParts = (conditions.excludedBaseStatuses || ['Resolved', 'Closed', 'Canceled'])
    .map((status) => `baseStatus ne '${status}'`);
  const baseFilter = [
    excludedStatusParts.join(' and '),
    buildTicketConditionsFilter(conditions)
  ].filter(Boolean).join(' and ');
  const pageSize = Number(conditions.syncLimit) || 100;

  let skip = 0;
  const ids = new Set();

  while (true) {
    const tickets = await fetchTicketsFromApi(token, skip, 0, conditions, {
      endpointPath: '',
      applyStatusFilter: true,
      customFilter: baseFilter,
      skipConfiguredFilters: true,
    });

    if (!Array.isArray(tickets) || tickets.length === 0) {
      break;
    }

    for (const ticket of tickets) {
      if (!ticket?.id) continue;
      if (!ticketMatchesAnyConfiguredCondition(ticket, conditions)) continue;
      ids.add(ticket.id);
    }

    if (tickets.length < pageSize) {
      break;
    }

    skip += pageSize;
  }

  return Array.from(ids);
}

// ── Leitura exclusiva da apidatalake, com fallback só por indisponibilidade ──
//
// O painel lê os chamados exclusivamente da apidatalake. O Postgres local
// (tabela `tickets`, ainda alimentada em paralelo por scripts/sync-movidesk.js
// via Task Scheduler) só entra em jogo quando a apidatalake está genuinamente
// fora do ar — nunca por preferência. Ver shouldFallbackToLocalDb() logo
// abaixo: só cai no banco local em DatalakeUnavailableError (rede/5xx) ou,
// nas rotas de detalhe de um ticket específico, em 404 (o pipeline silver
// tem 10-60min de atraso — um ticket recém-criado pode ainda não estar lá
// enquanto o sync local já tem cópia mais recente). Qualquer outro erro
// (config ausente, token/escopo inválido, erro inesperado) propaga como
// erro HTTP real em vez de mascarar silenciosamente com dado desatualizado.
//
// A apidatalake não tem um endpoint equivalente ao filtro OData de
// equipe+customField que hoje restringe o universo de tickets sincronizados
// (a tabela local `tickets` já nasce pré-filtrada por isso). Sem esse filtro,
// listar teria que escanear todo `silver.ticket` — que inclui o backlog
// histórico de ~600 mil chamados que o pipeline n8n ainda está processando
// (ver documentação da apidatalake). Por isso:
//
// - Buscamos por `/tickets?owner_team=<equipe configurada>` (schema novo, que
//   filtra owner_team no servidor — /legacy/tickets não tem esse filtro).
//   Isso já reduz o universo pro que interessa, sem escanear o backlog inteiro.
// - A condição de customField (ex: "Suporte Técnico") é conferida em JS via
//   /tickets/:id/campos, mas SÓ pra lista de ativos (conjunto pequeno,
//   tickets abertos de 1 equipe não crescem com o backlog histórico) — pra
//   /past e /filters isso é pulado por custo (ver funções abaixo), então
//   essas duas podem incluir um universo um pouco mais amplo que "só Suporte
//   Técnico" da equipe configurada. GET / (a rota que o Dashboard usa de
//   fato) continua exata.

const ACTIVE_BASE_STATUSES = ['New', 'InAttendance', 'Stopped', 'InProgress'];

// Decide se um erro vindo da apidatalake justifica cair no Postgres local ou
// se deve propagar como erro pra quem chamou a rota. `allow404` habilita a
// exceção documentada acima (atraso do pipeline silver) pras rotas de
// detalhe de um ticket específico.
function shouldFallbackToLocalDb(error, { allow404 = false } = {}) {
  if (error instanceof datalake.DatalakeUnavailableError) return true;
  if (allow404 && error instanceof datalake.DatalakeApiError && error.status === 404) return true;
  return false;
}

function getConditionsPromise() {
  return new Promise((resolve) => {
    require('./config').getMovideskConditions((err, cond) => {
      if (err || !cond) {
        resolve({
          statuses: ['New', 'InAttendance', 'Stopped'],
          serviceFirstLevel: '',
          customFieldId: '23946',
          customFieldValue: 'Suporte Técnico',
          syncLimit: 100,
          ownerTeam: 'VIASOFT - Sistemas Internos',
        });
      } else {
        resolve(cond);
      }
    });
  });
}

// Candidatos crus (colunas minúsculas de silver.ticket, via /tickets) pra
// todas as equipes configuradas.
//
// Sem `basestatuses`, varre TODO o histórico da equipe (sem filtro de
// status) — usado por /past e /filters, que precisam do universo completo.
// GET /tickets é ordenado por ticket_id ASCENDENTE: numa equipe com muito
// backlog fechado (dezenas de milhares de chamados), os tickets ATIVOS (os
// de ticket_id mais alto, criados por último) nunca seriam alcançados antes
// do teto de paginação de segurança se a varredura sempre começasse do
// ticket_id mais antigo. Por isso GET / (fora do modo `scope=all`) e
// GET /stats/overview passam `basestatuses: ACTIVE_BASE_STATUSES`: isso usa
// o filtro `?basestatus=` que a apidatalake já aplica no servidor, buscando
// cada status ativo separadamente — como o conjunto de tickets ativos é
// pequeno (não cresce com o backlog histórico), fica bem dentro do teto de
// paginação mesmo em equipes grandes.
async function fetchCandidateTicketsFromDatalake(conditions, { basestatuses } = {}) {
  const teamConditions = getTicketConditions(conditions).filter((c) => c.ownerTeam);
  if (!teamConditions.length) {
    throw new datalake.DatalakeApiError(
      'Nenhuma equipe configurada em movidesk-conditions — sem isso não é seguro filtrar via apidatalake (escanearia todo o backlog histórico).',
      400,
      null
    );
  }

  const teams = Array.from(new Set(teamConditions.map((c) => c.ownerTeam)));
  const statusFilters = Array.isArray(basestatuses) && basestatuses.length ? basestatuses : [undefined];
  const byId = new Map();

  for (const team of teams) {
    for (const basestatus of statusFilters) {
      let cursor;
      let page = 0;
      // Teto de segurança: 10k linhas por combinação equipe+status — se
      // passar, loga um aviso em vez de silenciar.
      while (page < 20) {
        const result = await datalake.datalakeGet('/tickets', {
          query: { owner_team: team, basestatus, limit: 500, cursor },
        });
        const rows = Array.isArray(result?.data) ? result.data : [];
        for (const row of rows) {
          if (row?.ticket_id != null) {
            byId.set(row.ticket_id, row);
          } else {
            // Guarda barata: se a apidatalake voltar a servir linhas sem
            // campos (aconteceu por um bug de schema de resposta do Fastify,
            // já corrigido no servidor), é melhor avisar alto no log do que
            // silenciosamente montar uma lista de candidatos vazia.
            console.warn('[tickets] apidatalake devolveu uma linha de /tickets sem ticket_id — verificar o schema de resposta do servidor.');
          }
        }
        page += 1;
        if (!result?.pageInfo?.hasMore || !result?.pageInfo?.nextCursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      if (page >= 20) {
        console.warn(`[tickets] Equipe "${team}"${basestatus ? ` (status ${basestatus})` : ''} atingiu o teto de paginação da apidatalake — lista pode estar incompleta.`);
      }
    }
  }

  return Array.from(byId.values());
}

// N+1 deliberado: só é chamado sobre conjuntos já pequenos (ativos de 1-2
// equipes), nunca sobre o histórico completo. Confere customFieldId/valor via
// /tickets/:id/campos, já que /tickets não devolve custom fields na listagem.
async function filterByCustomFieldCondition(rows, conditions) {
  if (!conditions.customFieldId || !conditions.customFieldValue) return rows;
  const targetId = String(conditions.customFieldId);
  const targetValue = String(conditions.customFieldValue).trim().toLowerCase();

  const kept = [];
  for (const row of rows) {
    try {
      const campos = await datalake.fetchTicketCamposDatalake(row.ticket_id);
      const match = campos.some((c) => String(c.custom_field_id) === targetId
        && String(c.valor_texto || '').trim().toLowerCase() === targetValue);
      if (match) kept.push(row);
    } catch (err) {
      console.warn(`[tickets] Falha ao checar customField do ticket ${row.ticket_id} na apidatalake, ignorando na lista:`, err.message);
    }
  }
  return kept;
}

function datalakeRowToTicketShape(row) {
  return { ...row, id: row.id ?? row.ticket_id };
}

// Fallback: exatamente a query que a rota usava antes desta fase.
function fetchActiveTicketsFromLocalDb(viewer, includeAll) {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT
        id, subject, status, baseStatus, createdDate, lastActionDate, lastUpdate,
        serviceFirstLevelId, serviceFirstLevel, serviceSecondLevel, slaAgreement,
        slaAgreementRule, slaSolutionTime, slaResponseTime, slaSolutionDate,
        slaSolutionDateIsPaused, slaResponseDate, slaRealResponseDate,
        ownerEmail, ownerName, owner_team, clientName, clientEmail, clientOrganization,
        justification, customFields, actionsCount, syncedAt, updatedAt, lastActionCreatedByBusinessName, lastActionOrigin,
        cf_classificacao_de_ticket, urgencia, actionsJson
      FROM tickets
    `;
    const params = [];
    const whereClauses = [];

    if (!includeAll) {
      whereClauses.push(`baseStatus IN ('New', 'InAttendance', 'Stopped', 'InProgress')`);
    }
    if (viewer.role === 'supervisor') {
      whereClauses.push(`serviceFirstLevel = ?`);
      params.push(viewer.vertical);
    }
    if (whereClauses.length) {
      query += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    query += ` ORDER BY createdDate DESC NULLS LAST`;
    query += includeAll ? ` LIMIT 10000` : ` LIMIT 100`;

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// GET - Buscar tickets do banco para dashboard (ativos + rota past)
// ?scope=all — usado pela aba Movidesk, que agora tem filtro de status e
// precisa ver também os chamados já fechados/resolvidos/cancelados (não só
// os ativos que alimentam o Dashboard).
router.get('/', async (req, res) => {
  const viewer = await resolveViewerContext(req);
  const includeAll = req.query.scope === 'all';
  const cacheKey = getViewerCacheKey(viewer, includeAll ? 'tickets:all' : 'tickets:active');
  const cachedTickets = getCachedResponse(cacheKey);
  if (cachedTickets) return res.json(cachedTickets);

  // Regra solicitada: supervisor visualiza apenas os chamados da vertical dele.
  if (viewer.role === 'supervisor' && !viewer.vertical) {
    return res.json([]);
  }

  let rows;
  try {
    const conditions = await getConditionsPromise();
    // includeAll (aba Movidesk, ?scope=all) precisa do universo completo
    // (inclusive fechados) — só o Dashboard (ativos) filtra por basestatus
    // já na apidatalake, ver comentário de fetchCandidateTicketsFromDatalake.
    let candidates = await fetchCandidateTicketsFromDatalake(
      conditions,
      includeAll ? {} : { basestatuses: ACTIVE_BASE_STATUSES }
    );
    if (!includeAll) {
      candidates = candidates.filter((r) => ACTIVE_BASE_STATUSES.includes(r.basestatus));
    }
    if (viewer.role === 'supervisor') {
      candidates = candidates.filter((r) => (r.servicefirstlevel || '') === viewer.vertical);
    }
    candidates = await filterByCustomFieldCondition(candidates, conditions);
    candidates.sort((a, b) => new Date(b.createddate || 0) - new Date(a.createddate || 0));
    rows = candidates.slice(0, includeAll ? 10000 : 100).map(datalakeRowToTicketShape);
    console.log(`[tickets] GET / servido pela apidatalake (${rows.length} chamados).`);
  } catch (error) {
    if (!shouldFallbackToLocalDb(error)) {
      console.error('[tickets] Erro na apidatalake em GET / (não é indisponibilidade — não cai no banco local):', error);
      return res.status(502).json({ error: 'apidatalake indisponível ou retornou erro', detail: error.message });
    }
    console.warn('[tickets] apidatalake indisponível em GET /, usando fallback do banco local:', error.message);
    try {
      rows = await fetchActiveTicketsFromLocalDb(viewer, includeAll);
    } catch (dbErr) {
      return res.status(500).json({ error: 'Erro ao buscar tickets' });
    }
  }

  res.json(cacheResponse(cacheKey, rows.map(normalizeTicketRow)));
});

function distinctNonEmpty(values) {
  return Array.from(new Set((values || []).map((v) => (v == null ? '' : String(v).trim())).filter(Boolean))).sort();
}

async function fetchFiltersFromLocalDb(viewer) {
  let where = '';
  const params = [];
  if (viewer.role === 'supervisor') {
    where = `WHERE serviceFirstLevel = ?`;
    params.push(viewer.vertical);
  }

  const distinctValues = async (column) => {
    const extra = `${column} IS NOT NULL AND TRIM(${column}) <> ''`;
    const clause = where ? `${where} AND ${extra}` : `WHERE ${extra}`;
    const sql = `SELECT DISTINCT ${column} AS value FROM tickets ${clause} ORDER BY value`;
    const result = await db.query(sql, params);
    return (result.rows || []).map((r) => r.value);
  };

  // Chamados "stub" (sync antiga incompleta) ficam com baseStatus NULL/vazio
  // — representados no filtro pela sentinela MOVIDESK_STATUS_NONE em vez de
  // simplesmente somem da lista de status.
  const hasBlankStatus = async () => {
    const extra = `(baseStatus IS NULL OR TRIM(baseStatus) = '')`;
    const clause = where ? `${where} AND ${extra}` : `WHERE ${extra}`;
    const sql = `SELECT EXISTS (SELECT 1 FROM tickets ${clause}) AS blank`;
    const result = await db.query(sql, params);
    return !!(result.rows?.[0]?.blank);
  };

  const [equipes, responsaveis, servicos, clientes, classificacoes, statusValues, blankStatus] = await Promise.all([
    distinctValues('owner_team'),
    distinctValues('ownerName'),
    distinctValues('serviceFirstLevel'),
    distinctValues('clientOrganization'),
    distinctValues('cf_classificacao_de_ticket'),
    distinctValues('baseStatus'),
    hasBlankStatus(),
  ]);
  const statuses = blankStatus ? [...statusValues, MOVIDESK_STATUS_NONE] : statusValues;
  return { equipes, responsaveis, servicos, clientes, classificacoes, statuses };
}

// GET - Valores distintos para os selects de filtro da aba Movidesk
// (status/equipe/responsável/serviço/cliente/classificação).
//
// Via apidatalake, calculado sobre o mesmo universo de fetchCandidateTicketsFromDatalake
// (tickets — abertos e fechados — das equipes configuradas), sem o filtro de
// customField (custo de N+1 não vale a pena só pra popular um dropdown) e
// sem "classificacoes" (cf_classificacao_de_ticket não tem equivalente
// conhecido na apidatalake ainda — ver plano de migração, seção de custom
// fields). Isso é uma aproximação deliberada: pode incluir mais valores do
// que a rota `GET /` de fato mostra depois de aplicar o filtro de customField.
router.get('/filters', async (req, res) => {
  const viewer = await resolveViewerContext(req);
  const cacheKey = getViewerCacheKey(viewer, 'tickets:filters');
  const cachedFilters = getCachedResponse(cacheKey);
  if (cachedFilters) return res.json(cachedFilters);

  if (viewer.role === 'supervisor' && !viewer.vertical) {
    return res.json(cacheResponse(cacheKey, { equipes: [], responsaveis: [], servicos: [], clientes: [], classificacoes: [], statuses: [] }));
  }

  let payload;
  try {
    const conditions = await getConditionsPromise();
    let candidates = await fetchCandidateTicketsFromDatalake(conditions);
    if (viewer.role === 'supervisor') {
      candidates = candidates.filter((r) => (r.servicefirstlevel || '') === viewer.vertical);
    }
    const blankStatus = candidates.some((r) => !r.basestatus || !String(r.basestatus).trim());
    const statusValues = distinctNonEmpty(candidates.map((r) => r.basestatus));
    payload = {
      equipes: distinctNonEmpty(candidates.map((r) => r.owner_team)),
      responsaveis: distinctNonEmpty(candidates.map((r) => r.ownername)),
      servicos: distinctNonEmpty(candidates.map((r) => r.servicefirstlevel)),
      clientes: distinctNonEmpty(candidates.map((r) => r.clientorganization)),
      classificacoes: [], // sem equivalente confirmado na apidatalake ainda — ver plano de migração
      statuses: blankStatus ? [...statusValues, MOVIDESK_STATUS_NONE] : statusValues,
    };
    console.log('[tickets] GET /filters servido pela apidatalake.');
  } catch (error) {
    if (!shouldFallbackToLocalDb(error)) {
      console.error('[tickets] Erro na apidatalake em GET /filters (não é indisponibilidade — não cai no banco local):', error);
      return res.status(502).json({ error: 'apidatalake indisponível ou retornou erro', detail: error.message });
    }
    console.warn('[tickets] apidatalake indisponível em GET /filters, usando fallback do banco local:', error.message);
    try {
      payload = await fetchFiltersFromLocalDb(viewer);
    } catch (err) {
      console.error('Erro ao buscar filtros da aba Movidesk:', err);
      return res.status(500).json({ error: 'Erro ao buscar filtros da aba Movidesk', detail: err.message });
    }
  }

  res.json(cacheResponse(cacheKey, payload));
});

function fetchPastTicketsFromLocalDb(viewer) {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT
        id, subject, status, baseStatus, createdDate, lastActionDate, lastUpdate,
        serviceFirstLevelId, serviceFirstLevel, serviceSecondLevel, slaAgreement,
        slaAgreementRule, slaSolutionTime, slaResponseTime, slaSolutionDate,
        slaSolutionDateIsPaused, slaResponseDate, slaRealResponseDate,
        ownerEmail, ownerName, owner_team, clientName, clientEmail, clientOrganization,
        justification, customFields, actionsCount, syncedAt, updatedAt, lastActionCreatedByBusinessName, lastActionOrigin,
        cf_classificacao_de_ticket, urgencia
      FROM tickets
      WHERE baseStatus NOT IN ('New', 'InAttendance', 'Stopped', 'InProgress')
    `;
    const params = [];
    if (viewer.role === 'supervisor') {
      query += ` AND serviceFirstLevel = ?`;
      params.push(viewer.vertical);
    }
    query += ` ORDER BY createdDate DESC LIMIT 100`;

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// GET - Buscar tickets históricos (past) - resolvidos, encerrados, etc.
// Nota: hoje não é chamada por nenhuma tela do painel (js/, admin/) — migrada
// por consistência com o resto do arquivo, mas não é prioridade de teste.
router.get('/past', async (req, res) => {
  const viewer = await resolveViewerContext(req);
  if (viewer.role === 'supervisor' && !viewer.vertical) {
    return res.json([]);
  }

  let rows;
  try {
    const conditions = await getConditionsPromise();
    let candidates = await fetchCandidateTicketsFromDatalake(conditions);
    candidates = candidates.filter((r) => !ACTIVE_BASE_STATUSES.includes(r.basestatus));
    if (viewer.role === 'supervisor') {
      candidates = candidates.filter((r) => (r.servicefirstlevel || '') === viewer.vertical);
    }
    candidates.sort((a, b) => new Date(b.createddate || 0) - new Date(a.createddate || 0));
    rows = candidates.slice(0, 100).map(datalakeRowToTicketShape);
  } catch (error) {
    if (!shouldFallbackToLocalDb(error)) {
      console.error('[tickets] Erro na apidatalake em GET /past (não é indisponibilidade — não cai no banco local):', error);
      return res.status(502).json({ error: 'apidatalake indisponível ou retornou erro', detail: error.message });
    }
    console.warn('[tickets] apidatalake indisponível em GET /past, usando fallback do banco local:', error.message);
    try {
      rows = await fetchPastTicketsFromLocalDb(viewer);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao buscar tickets históricos' });
    }
  }

  res.json(rows.map(normalizeTicketRow));
});

function fetchTicketByIdFromLocalDb(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM tickets WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

// GET - Buscar ticket por ID
//
// GET /tickets/:id (nativo) + /acoes + /clientes + /status-historico via
// fetchNativeTicketDetail (datalakeClient.js) — uma chamada composta que
// devolve tudo que essa rota precisa. 404 da apidatalake também cai no
// fallback local (não só indisponibilidade) — durante a transição um ticket
// recém-criado pode ainda não ter chegado no silver.ticket (pipeline roda a
// cada 10-60min), enquanto o banco local pode já ter uma cópia mais recente
// via scripts/sync-movidesk.js. Qualquer outro erro (config ausente,
// token/escopo inválido) propaga como 502 em vez de cair no banco local.
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const detail = await datalake.fetchNativeTicketDetail(id);
    if (!detail) {
      throw new datalake.DatalakeApiError('Ticket não encontrado na apidatalake', 404, null);
    }
    const shaped = nativeRowToTicketShape(detail);
    return res.json(normalizeTicketRow(datalakeRowToTicketShape(shaped)));
  } catch (error) {
    if (!shouldFallbackToLocalDb(error, { allow404: true })) {
      console.error(`[tickets] Erro na apidatalake em GET /:id (${id}) (não é indisponibilidade nem 404 — não cai no banco local):`, error);
      return res.status(502).json({ error: 'apidatalake indisponível ou retornou erro', detail: error.message });
    }
    const isNotFound = error instanceof datalake.DatalakeApiError && error.status === 404;
    if (!isNotFound) {
      console.warn(`[tickets] apidatalake indisponível em GET /:id (${id}), usando fallback do banco local:`, error.message);
    }
    try {
      const row = await fetchTicketByIdFromLocalDb(id);
      if (!row) {
        return res.status(404).json({ error: 'Ticket não encontrado' });
      }
      if (row.customFields) {
        row.customFields = safeJsonParse(row.customFields, []);
      }
      return res.json(normalizeTicketRow(row));
    } catch (dbErr) {
      return res.status(500).json({ error: 'Erro ao buscar ticket' });
    }
  }
});

function fetchTicketForExecutiveSummaryFromLocalDb(id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, subject, status, baseStatus, createdDate, lastActionDate, lastUpdate,
              serviceFirstLevelId, serviceFirstLevel, serviceSecondLevel,
              slaAgreement, slaAgreementRule, slaSolutionTime, slaResponseTime,
              slaSolutionDate, slaSolutionDateIsPaused, slaResponseDate, slaRealResponseDate,
        ownerName, ownerEmail, owner_team, clientName, clientEmail, clientOrganization,
              justification, customFields, actionsCount, syncedAt, updatedAt,
              lastActionCreatedByBusinessName, lastActionOrigin,
              actionsJson, clientsJson, statusHistoriesJson
       FROM tickets WHERE id = ?`,
      [id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

// POST - Gerar resumo executivo com base nas actions do ticket
//
// Usa fetchNativeTicketDetail (GET /tickets/:id nativo + sub-recursos) —
// actions/clients/statusHistories adaptados via nativeRowToTicketShape (ver
// comentário acima de inferTicketContext), sem heurística: tipo/origem da
// ação já vêm como os códigos numéricos reais do Movidesk.
router.post('/:id/executive-summary', async (req, res) => {
  const { id } = req.params;
  try {
    let ticket;
    try {
      const detail = await datalake.fetchNativeTicketDetail(id);
      if (!detail) throw new datalake.DatalakeApiError('Ticket não encontrado na apidatalake', 404, null);
      ticket = nativeRowToTicketShape(detail);
    } catch (error) {
      if (!shouldFallbackToLocalDb(error, { allow404: true })) {
        console.error(`[tickets] Erro na apidatalake em POST /:id/executive-summary (${id}) (não é indisponibilidade nem 404 — não cai no banco local):`, error);
        return res.status(502).json({ error: 'apidatalake indisponível ou retornou erro', detail: error.message });
      }
      const isNotFound = error instanceof datalake.DatalakeApiError && error.status === 404;
      if (!isNotFound) {
        console.warn(`[tickets] apidatalake indisponível em POST /:id/executive-summary (${id}), usando fallback do banco local:`, error.message);
      }
      ticket = await fetchTicketForExecutiveSummaryFromLocalDb(id);
    }

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket nao encontrado' });
    }

    const context = inferTicketContext(ticket);
    const summary = await generateExecutiveSummaryFromLLM(context);

    res.json({
      ticketId: Number(id),
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      summary
    });
  } catch (error) {
    console.error('Erro ao gerar resumo executivo:', error);
    res.status(500).json({ error: error.message || 'Erro ao gerar resumo executivo' });
  }
});

// Lógica de sincronização (reutilizável internamente e via rota)
async function runSync() {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  const syncId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  updateSyncState({
    syncId,
    running: true,
    status: 'running',
    phase: 'starting',
    message: 'Iniciando sincronizacao',
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalFetched: 0,
    totalSaved: 0,
    processedBatches: 0,
    lastBatchSize: 0,
    lastError: null,
  });

  activeSyncPromise = (async () => {
  const token = await new Promise((resolve, reject) => {
    require('./config').getToken((err, t) => {
      if (err) reject(err);
      else resolve(t);
    });
  });

  if (!token) throw new Error('Token não configurado');

  // Carregar condições da requisição Movidesk
  const conditions = await new Promise((resolve, reject) => {
    require('./config').getMovideskConditions((err, cond) => {
      if (err) {
        console.warn('Erro ao carregar condições, usando padrões:', err);
        resolve({
          statuses: ['New', 'InAttendance', 'Stopped'],
          serviceFirstLevel: '',
          customFieldId: '23946',
          customFieldValue: 'Suporte Técnico',
          syncLimit: 100
        });
      } else {
        resolve(cond);
      }
    });
  });

  console.log('Sincronizando com condições:', JSON.stringify(conditions));

  try {
    await ensureDbAvailable();
  } catch (error) {
    throw new Error('Banco indisponível no momento. Verifique conectividade com PostgreSQL e tente novamente.');
  }

  let collectedIds = [];
  const seenTicketIds = new Set();
  let fetchError = null;
  let totalFetched = 0;
  let totalSaved = 0;
  let processedBatches = 0;

  // Construir filtro dinamicamente a partir das configurações
  const excludedStatusParts = (conditions.excludedBaseStatuses || ['Resolved', 'Closed', 'Canceled'])
    .map(status => `baseStatus ne '${status}'`);
  
  let filterParts = [...excludedStatusParts];
  
  // Cada condição de equipe é uma alternativa (OU).
  const ticketConditionsFilter = buildTicketConditionsFilter(conditions);
  if (ticketConditionsFilter) filterParts.push(ticketConditionsFilter);
  
  const OPEN_AND_PAST_FILTER = filterParts.join(' and ');

  const pageSize = Number(conditions.syncLimit) || 100;

  const syncEndpoint = async (label, endpointPath, applyStatusFilter, customFilter = '') => {
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
      updateSyncState({
        phase: 'fetching',
        message: `Buscando ${label} lote ${processedBatches + 1} (skip=${skip})`,
        totalFetched,
        totalSaved,
        processedBatches,
      });

      const tickets = await fetchTicketsFromApi(token, skip, 0, conditions, {
        endpointPath,
        applyStatusFilter,
        customFilter,
        skipConfiguredFilters: true,
      });

      // null = ECONNRESET tratado como fim de paginação
      if (tickets === null) {
        hasMore = false;
        break;
      }
      if (!Array.isArray(tickets) || tickets.length === 0) {
        hasMore = false;
        break;
      }

      processedBatches += 1;
      totalFetched += tickets.length;

      updateSyncState({
        phase: 'processing',
        message: `Processando ${label} lote ${processedBatches} com ${tickets.length} chamados`,
        totalFetched,
        totalSaved,
        processedBatches,
        lastBatchSize: tickets.length,
      });

      for (const ticket of tickets) {
        const ticketId = ticket && ticket.id;
        if (!ticketId || seenTicketIds.has(ticketId)) {
          continue;
        }

        // Validação de fallback: se o customField foi configurado, verificar se o ticket o possui
        // (caso o filtro da API não tenha funcionado corretamente)
        if (!ticketMatchesAnyConfiguredCondition(ticket, conditions)) {
          continue;
        }
        if (false && conditions.customFieldId && conditions.customFieldValue) {
          if (!ticketMatchesCustomFieldFilter(ticket, conditions.customFieldId, conditions.customFieldValue)) {
            console.log(`Ticket ${ticketId} não passa no filtro de customField ${conditions.customFieldId}=${conditions.customFieldValue}. Ignorando.`);
            continue;
          }
        }

        seenTicketIds.add(ticketId);
        collectedIds.push(ticketId);

        try {
          await saveTicketToDb(ticket);
          totalSaved += 1;
        } catch (error) {
          if (isDbUnavailableError(error)) {
            console.error('Banco indisponivel durante persistencia de tickets. Interrompendo sync.', error);
            throw new Error('Sincronizacao interrompida: conexao com banco indisponivel. Dados parciais ja foram salvos.');
          }
          console.error(`Erro ao salvar ticket ${ticket.id}:`, error);
        }
      }

      updateSyncState({
        phase: 'analyzing',
        message: `${label} lote ${processedBatches} salvo e analisado`,
        totalFetched,
        totalSaved,
        processedBatches,
        lastBatchSize: tickets.length,
      });

      if (tickets.length < pageSize) {
        hasMore = false;
      } else {
        skip += pageSize;
      }
    }
  };

  try {
    await syncEndpoint('abertos', '', false, OPEN_AND_PAST_FILTER);
    await syncEndpoint('past', '/past', false, OPEN_AND_PAST_FILTER);
  } catch (error) {
    console.error('Erro durante sincronizacao de lotes:', error);
    fetchError = error;
  }

  if (fetchError && totalFetched === 0) {
    throw new Error('Falha ao sincronizar com Movidesk (API indisponivel/limitada). Dados locais preservados.');
  }

  if (fetchError) {
    throw new Error(`Sincronizacao parcial: ${totalSaved} chamados salvos antes de falha na API Movidesk.`);
  }

  // Marca como fechados no banco os tickets abertos que nao apareceram na coleta completa.
  updateSyncState({
    phase: 'finalizing',
    message: 'Finalizando sincronizacao e fechando chamados ausentes na API',
    totalFetched,
    totalSaved,
    processedBatches,
  });

  if (!fetchError) {
    const uniqueIds = Array.from(new Set(collectedIds));
    await markMissingTicketsAsClosed(uniqueIds);
  }

  updateSyncState({
    running: false,
    status: 'completed',
    phase: 'completed',
    message: `Sincronizacao concluida: ${totalSaved} chamados salvos`,
    completedAt: new Date().toISOString(),
    totalFetched,
    totalSaved,
    processedBatches,
    lastError: null,
  });

  return totalSaved;
  })();

  try {
    return await activeSyncPromise;
  } catch (error) {
    updateSyncState({
      running: false,
      status: 'failed',
      phase: 'failed',
      message: error.message || 'Falha na sincronizacao',
      completedAt: new Date().toISOString(),
      lastError: error.message || 'Falha na sincronizacao',
    });
    throw error;
  } finally {
    activeSyncPromise = null;
  }
}

// A sincronização com a API do Movidesk (POST /sync, GET /sync/status) foi
// removida do servidor web — agora só o script scripts/sync-movidesk.js fala
// com a API do Movidesk (rodando fora deste processo, via agendador),
// alimentando a tabela local `tickets` que existe hoje só como fallback de
// indisponibilidade da apidatalake (ver shouldFallbackToLocalDb acima). As
// rotas HTTP deste arquivo leem a apidatalake primeiro.

function fetchStatsOverviewFromLocalDb() {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT
        COUNT(*) FILTER (WHERE baseStatus IN ('New', 'InAttendance', 'Stopped', 'InProgress')) as total,
        SUM(CASE WHEN baseStatus = 'New' THEN 1 ELSE 0 END) as novo,
        SUM(CASE WHEN baseStatus = 'InAttendance' THEN 1 ELSE 0 END) as emAtendimento,
        SUM(CASE WHEN baseStatus = 'Stopped' THEN 1 ELSE 0 END) as parado
      FROM tickets
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row || { total: 0, novo: 0, emAtendimento: 0, parado: 0 });
    });
  });
}

// GET - Estatísticas
//
// Calculado em JS sobre o mesmo conjunto de candidatos de GET / (equipes
// configuradas, apenas ativos) — deliberadamente NÃO usa gold.mart_sla_por_time
// da apidatalake, porque esse mart agrega todo mundo por owner_team sem
// aplicar o filtro de customField ("Suporte Técnico") que os KPIs de hoje
// consideram; usaria um universo diferente do que a rota mostra.
router.get('/stats/overview', async (req, res) => {
  try {
    const conditions = await getConditionsPromise();
    let candidates = await fetchCandidateTicketsFromDatalake(conditions, { basestatuses: ACTIVE_BASE_STATUSES });
    candidates = candidates.filter((r) => ACTIVE_BASE_STATUSES.includes(r.basestatus));
    candidates = await filterByCustomFieldCondition(candidates, conditions);

    const stats = { total: candidates.length, novo: 0, emAtendimento: 0, parado: 0 };
    for (const r of candidates) {
      if (r.basestatus === 'New') stats.novo += 1;
      else if (r.basestatus === 'InAttendance') stats.emAtendimento += 1;
      else if (r.basestatus === 'Stopped') stats.parado += 1;
    }
    return res.json(stats);
  } catch (error) {
    if (!shouldFallbackToLocalDb(error)) {
      console.error('[tickets] Erro na apidatalake em GET /stats/overview (não é indisponibilidade — não cai no banco local):', error);
      return res.status(502).json({ error: 'apidatalake indisponível ou retornou erro', detail: error.message });
    }
    console.warn('[tickets] apidatalake indisponível em GET /stats/overview, usando fallback do banco local:', error.message);
    try {
      const row = await fetchStatsOverviewFromLocalDb();
      return res.json(row);
    } catch (dbErr) {
      return res.status(500).json({ error: 'Erro ao obter estatísticas' });
    }
  }
});

// SLA - Rotas de cálculo de SLA de primeiro contato
const { calcularSLAPrimeiroContato } = require('../utils/sla');

function fetchTicketForSlaFromLocalDb(id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT
         id,
         slaagreementrule AS "slaAgreementRule",
         createddate AS "createdDate",
         actionsjson AS "actionsJson",
         clientsjson AS "clientsJson",
         statushistoriesjson AS "statusHistoriesJson"
       FROM tickets WHERE id = ?`,
      [id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

function emptySlaResult(id, abertura, motivo) {
  return {
    ticketId: Number(id),
    slaPrevistoMinutos: null,
    abertura,
    primeiroContatoEncontrado: false,
    primeiroContato: null,
    minutosUteisConsumidos: null,
    dentroDoSLA: null,
    minutosEstouro: null,
    erro: true,
    ...(motivo ? { motivo } : {})
  };
}

// GET - Calcular SLA para um ticket específico
//
// Busca o detalhe via fetchNativeTicketDetail (mesma chamada composta usada
// em GET /:id e no resumo executivo) e adapta pro shape que
// calcularSLAPrimeiroContato() espera (ver nativeRowToTicketShape) — sem
// heurística, tipo/origem da ação já vêm como os códigos numéricos reais.
router.get('/:id/sla', async (req, res) => {
  const { id } = req.params;

  try {
    let ticket = null;
    try {
      const detail = await datalake.fetchNativeTicketDetail(id);
      if (detail) ticket = nativeRowToTicketShape(detail);
    } catch (error) {
      if (!shouldFallbackToLocalDb(error, { allow404: true })) {
        console.error(`[tickets] Erro na apidatalake em GET /:id/sla (${id}) (não é indisponibilidade nem 404 — não cai no banco local):`, error);
        return res.status(502).json({ error: 'apidatalake indisponível ou retornou erro', detail: error.message });
      }
      const isNotFound = error instanceof datalake.DatalakeApiError && error.status === 404;
      if (!isNotFound) {
        console.warn(`[tickets] apidatalake indisponível em GET /:id/sla (${id}), usando fallback do banco local:`, error.message);
      }
    }

    if (!ticket) {
      const ticketLocal = await fetchTicketForSlaFromLocalDb(id);
      if (ticketLocal && ticketLocal.createdDate) {
        ticket = {
          id: ticketLocal.id,
          slaAgreementRule: ticketLocal.slaAgreementRule,
          createdDate: ticketLocal.createdDate,
          actions: safeJsonParse(ticketLocal.actionsJson, []),
          clients: safeJsonParse(ticketLocal.clientsJson, []),
          statusHistories: safeJsonParse(ticketLocal.statusHistoriesJson, [])
        };
      }
    }

    const createdDate = ticket?.createdDate ?? ticket?.createddate ?? null;
    if (!ticket || !createdDate) {
      return res.json(emptySlaResult(id, null, ticket ? undefined : 'Ticket não encontrado na apidatalake nem no banco local.'));
    }

    try {
      const slaResult = calcularSLAPrimeiroContato({
        ...ticket,
        createdDate,
        slaAgreementRule: ticket.slaAgreementRule ?? ticket.slaagreementrule ?? null,
      });
      return res.json(slaResult);
    } catch (calcError) {
      console.error('Cálculo de SLA falhou:', calcError);
      return res.json(emptySlaResult(id, new Date(createdDate).toISOString?.() || null));
    }
  } catch (error) {
    console.error('Erro ao calcular SLA:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST - Calcular SLA para um ticket enviado no corpo
router.post('/sla', (req, res) => {
  try {
    const ticket = req.body;
    
    if (!ticket || !ticket.id) {
      return res.status(400).json({ error: 'Ticket inválido' });
    }

    const slaResult = calcularSLAPrimeiroContato(ticket);
    res.json(slaResult);
  } catch (error) {
    console.error('Erro ao calcular SLA:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Sync Incremental ─────────────────────────────────────────────────────────
// Busca na API Movidesk apenas tickets cujo lastUpdate é maior que o maior
// updatedAt registrado no banco. Não remove tickets — só insere/atualiza.
async function runIncrementalSync() {
  // Evita sobreposição com sync completo em andamento
  if (activeSyncPromise) {
    console.log('⏭️  Incremental sync ignorado: sync completo em andamento');
    return 0;
  }

  const token = await new Promise((resolve, reject) => {
    require('./config').getToken((err, t) => {
      if (err) reject(err); else resolve(t);
    });
  });
  if (!token) throw new Error('Token não configurado');

  const conditions = await new Promise((resolve, reject) => {
    require('./config').getMovideskConditions((err, cond) => {
      if (err) resolve({
        statuses: ['New', 'InAttendance', 'Stopped'],
        serviceFirstLevel: '',
        customFieldId: '23946',
        customFieldValue: 'Suporte Técnico',
        syncLimit: 100,
      });
      else resolve(cond);
    });
  });

  try { await ensureDbAvailable(); } catch (e) {
    throw new Error('Banco indisponível para sync incremental.');
  }

  // Pegar o timestamp mais recente do banco
  const lastRow = await new Promise((resolve, reject) => {
    db.get(
      `SELECT MAX(COALESCE(updatedat, syncedat)) AS lastTs FROM tickets`,
      [],
      (err, row) => { if (err) reject(err); else resolve(row); }
    );
  });

  // Subtrai 30s para cobrir edge cases de clock skew
  const lastTsRaw = lastRow?.lastTs ?? lastRow?.lastts ?? null;
  const lastTs = lastTsRaw ? new Date(new Date(lastTsRaw).getTime() - 30000) : new Date(0);
  const lastTsIso = lastTs.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Filtro OData: lastUpdate maior que o timestamp do banco
  const lastUpdateFilter = `lastUpdate gt ${lastTsIso}`;

  // Combina com os outros filtros existentes
  const excludedStatusParts = (conditions.excludedBaseStatuses || ['Resolved', 'Closed', 'Canceled'])
    .map(s => `baseStatus ne '${s}'`);
  const baseFilter = [...excludedStatusParts].join(' and ');
  const incrementalFilter = [baseFilter, buildTicketConditionsFilter(conditions), lastUpdateFilter]
    .filter(Boolean)
    .join(' and ');

  let skip = 0;
  let totalUpdated = 0;
  const pageSize = Number(conditions.syncLimit) || 100;

  console.log(`🔍 Incremental sync desde: ${lastTsIso}`);

  while (true) {
    const tickets = await fetchTicketsFromApi(token, skip, 0, conditions, {
      endpointPath: '',
      applyStatusFilter: false,
      customFilter: incrementalFilter,
      skipConfiguredFilters: true,
    });

    if (!Array.isArray(tickets) || tickets.length === 0) break;

    for (const ticket of tickets) {
      if (!ticket?.id) continue;
      if (!ticketMatchesAnyConfiguredCondition(ticket, conditions)) continue;
      try {
        await saveTicketToDb(ticket);
        totalUpdated++;
      } catch (err) {
        if (isDbUnavailableError(err)) throw err;
        console.error(`[incremental] Erro ao salvar ticket ${ticket.id}:`, err.message);
      }
    }

    if (tickets.length < pageSize) break;
    skip += pageSize;
  }

  // Reconciliacao: apos atualizar os tickets alterados, varre os IDs abertos atuais
  // para fechar no banco os chamados que nao aparecem mais na consulta da Movidesk.
  try {
    const currentOpenIds = await collectCurrentOpenTicketIds(token, conditions);
    await markMissingTicketsAsClosed(currentOpenIds);
  } catch (err) {
    console.error('⚠️  Incremental sync: falha ao reconciliar chamados ausentes:', err.message || err);
  }

  if (totalUpdated > 0) {
    console.log(`✅ Incremental sync: ${totalUpdated} ticket(s) atualizados`);
  }
  return totalUpdated;
}

module.exports = router;
module.exports.runSync = runSync;
module.exports.runIncrementalSync = runIncrementalSync;
