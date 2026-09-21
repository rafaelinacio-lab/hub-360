const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { encryptToken, decryptToken } = require('../utils/crypto');
const { authMiddleware, requireRole } = require('./auth');

function saveConfigValue(key, value, callback) {
  db.run(
    `INSERT INTO config (key, value)
     VALUES (?, ?)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
    (err) => {
      // Fallback defensivo para cenarios de corrida onde o banco retorna
      // violacao de unicidade mesmo com ON CONFLICT.
      if (err && err.code === '23505') {
        return db.run(
          `UPDATE config SET value = ?, encryptedAt = CURRENT_TIMESTAMP WHERE key = ?`,
          [value, key],
          callback
        );
      }
      callback(err);
    }
  );
}

function getConfigValue(key, callback) {
  db.get('SELECT value FROM config WHERE key = ?', [key], callback);
}

// GET - Obter status do token Movidesk (somente admin)
router.get('/token', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('movidesk_token', (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    }
    res.json({ tokenExists: !!row });
  });
});

// POST - Salvar token criptografado (somente admin)
router.post('/token', authMiddleware, requireRole('admin'), (req, res) => {
  const { token } = req.body;

  if (!token || token.trim() === '') {
    return res.status(400).json({ error: 'Token nao pode estar vazio' });
  }

  try {
    const encryptedToken = encryptToken(token);
    saveConfigValue('movidesk_token', encryptedToken, (err) => {
      if (err) {
        console.error('Erro ao salvar token:', err);
        return res.status(500).json({ error: 'Erro ao salvar token' });
      }
      res.json({ success: true, message: 'Token salvo com seguranca' });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Verificar se chave GPT esta configurada (somente admin)
router.get('/gpt-key', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('openai_api_key', (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    }
    res.json({ configured: !!row });
  });
});

// GET - Retorna chave GPT descriptografada para uso no frontend (qualquer usuário autenticado)
// A chave é usada para chamadas diretas à OpenAI a partir do browser
router.get('/gpt-key-for-client', authMiddleware, (req, res) => {
  getConfigValue('openai_api_key', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    if (!row) return res.json({ configured: false, apiKey: null });
    try {
      const apiKey = decryptToken(row.value);
      res.json({ configured: true, apiKey });
    } catch {
      res.json({ configured: false, apiKey: null });
    }
  });
});

// POST - Salvar chave GPT criptografada (somente admin)
router.post('/gpt-key', authMiddleware, requireRole('admin'), (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey || apiKey.trim() === '') {
    return res.status(400).json({ error: 'Chave da API GPT nao pode estar vazia' });
  }

  try {
    const encrypted = encryptToken(apiKey.trim());
    saveConfigValue('openai_api_key', encrypted, (err) => {
      if (err) {
        console.error('Erro ao salvar chave GPT:', err);
        return res.status(500).json({ error: 'Erro ao salvar chave GPT' });
      }
      res.json({ success: true, message: 'Chave GPT salva com sucesso' });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Verificar se o prompt da IA esta configurado (somente admin)
router.get('/gpt-prompt', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('openai_executive_prompt', (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    }
    res.json({
      configured: !!row,
      prompt: row?.value || ''
    });
  });
});

// POST - Salvar prompt da IA (somente admin)
router.post('/gpt-prompt', authMiddleware, requireRole('admin'), (req, res) => {
  const { prompt } = req.body;

  if (!prompt || prompt.trim() === '') {
    return res.status(400).json({ error: 'Prompt nao pode estar vazio' });
  }

  saveConfigValue('openai_executive_prompt', prompt.trim(), (err) => {
    if (err) {
      console.error('Erro ao salvar prompt GPT:', err);
      return res.status(500).json({ error: 'Erro ao salvar prompt GPT' });
    }
    res.json({ success: true, message: 'Prompt GPT salvo com sucesso' });
  });
});

// GET - Configurações do banco remoto (somente admin)
router.get('/database', authMiddleware, requireRole('admin'), (req, res) => {
  const keys = ['db_host', 'db_port', 'db_name', 'db_user', 'db_password', 'db_dialect'];
  const state = {};
  let remaining = keys.length;
  let finished = false;

  const finish = () => {
    if (finished) return;
    remaining -= 1;
    if (remaining === 0) {
      finished = true;
      res.json({
        configured: !!(state.db_host && state.db_name && state.db_user),
        host: state.db_host || '',
        port: state.db_port || '',
        name: state.db_name || '',
        user: state.db_user || '',
        password: state.db_password || '',
        dialect: state.db_dialect || 'postgres'
      });
    }
  };

  keys.forEach((key) => {
    getConfigValue(key, (err, row) => {
      if (finished) return;
      if (err) {
        finished = true;
        return res.status(500).json({ error: 'Erro ao consultar configuracoes do banco' });
      }
      state[key] = row?.value || '';
      finish();
    });
  });
});

// POST - Salvar configurações do banco remoto (somente admin)
router.post('/database', authMiddleware, requireRole('admin'), (req, res) => {
  const { host, port, name, user, password, dialect } = req.body;

  if (!host || !port || !name || !user || !password) {
    return res.status(400).json({ error: 'Host, porta, nome, usuário e senha são obrigatórios' });
  }

  const entries = [
    ['db_host', host.trim()],
    ['db_port', String(port).trim()],
    ['db_name', name.trim()],
    ['db_user', user.trim()],
    ['db_password', encryptToken(password)],
    ['db_dialect', (dialect || 'postgres').trim()]
  ];

  let remaining = entries.length;
  let failed = false;

  entries.forEach(([key, value]) => {
    saveConfigValue(key, value, (err) => {
      if (failed) return;
      if (err) {
        failed = true;
        return res.status(500).json({ error: 'Erro ao salvar configuracoes do banco' });
      }
      remaining -= 1;
      if (remaining === 0) {
        res.json({ success: true, message: 'Configuracoes do banco salvas com sucesso' });
      }
    });
  });
});

function getPrompt(callback) {
  getConfigValue('openai_executive_prompt', (err, row) => {
    if (err) {
      callback(err, null);
      return;
    }
    callback(null, row?.value || null);
  });
}

// GET - Recuperar token para uso (apenas internamente)
function getToken(callback) {
  getConfigValue('movidesk_token', (err, row) => {
    if (err) {
      callback(err, null);
      return;
    }
    if (!row) {
      callback(new Error('Token nao configurado'), null);
      return;
    }
    try {
      const decryptedToken = decryptToken(row.value);
      callback(null, decryptedToken);
    } catch (error) {
      callback(error, null);
    }
  });
}

function getDatabaseConfig(callback) {
  const keys = ['db_host', 'db_port', 'db_name', 'db_user', 'db_password', 'db_dialect'];
  const result = {};
  let remaining = keys.length;
  let failed = false;

  keys.forEach((key) => {
    getConfigValue(key, (err, row) => {
      if (failed) return;
      if (err) {
        failed = true;
        return callback(err, null);
      }
      result[key] = row?.value || '';
      remaining -= 1;
      if (remaining === 0) {
        callback(null, {
          host: result.db_host || '',
          port: result.db_port || '',
          name: result.db_name || '',
          user: result.db_user || '',
          password: result.db_password ? decryptToken(result.db_password) : '',
          dialect: result.db_dialect || 'postgres'
        });
      }
    });
  });
}

const DEFAULT_MOVIDESK_CONDITIONS = {
  statuses: ['New', 'InAttendance', 'Stopped'],
  serviceFirstLevel: '',
  customFieldId: '23946',
  customFieldValue: 'Suporte Técnico',
  syncLimit: 100,
  ownerTeam: 'VIASOFT - Sistemas Internos',
  teamConditions: [],
  excludedBaseStatuses: ['Resolved', 'Closed', 'Canceled'],
  selectFields: 'id,subject,status,baseStatus,createdDate,lastActionDate,lastUpdate,serviceFirstLevelId,serviceFirstLevel,serviceSecondLevel,slaAgreement,slaAgreementRule,slaSolutionTime,slaResponseTime,slaSolutionDate,slaSolutionDateIsPaused,slaResponseDate,slaRealResponseDate,justification,ownerTeam',
  expandRelations: 'owner,actions($select=id,type,origin,status,createdDate,description;$expand=createdBy),customFieldValues($expand=items),clients($expand=organization)'
};

function normalizeMovideskConditions(value) {
  const saved = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_MOVIDESK_CONDITIONS,
    ...saved,
    teamConditions: Array.isArray(saved.teamConditions) ? saved.teamConditions : []
  };
}

// Função para obter as condições da requisição Movidesk
function getMovideskConditions(callback) {
  getConfigValue('movidesk_conditions', (err, row) => {
    if (err) {
      return callback(err, null);
    }

    let conditions = { ...DEFAULT_MOVIDESK_CONDITIONS };

    if (row && row.value) {
      try {
        conditions = normalizeMovideskConditions(JSON.parse(row.value));
      } catch (e) {
        console.warn('Erro ao parsear condições Movidesk:', e);
      }
    }

    callback(null, conditions);
  });
}

// GET - Obter condições da requisição Movidesk (somente admin)
router.get('/movidesk-conditions', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('movidesk_conditions', (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    }
    
    let conditions = { ...DEFAULT_MOVIDESK_CONDITIONS };
    
    if (row && row.value) {
      try {
        conditions = normalizeMovideskConditions(JSON.parse(row.value));
      } catch (e) {
        console.warn('Erro ao parsear condições Movidesk:', e);
      }
    }
    
    res.json(conditions);
  });
});

// POST - Salvar condições da requisição Movidesk (somente admin)
router.post('/movidesk-conditions', authMiddleware, requireRole('admin'), (req, res) => {
  const { 
    statuses, 
    serviceFirstLevel, 
    customFieldId, 
    customFieldValue, 
    syncLimit,
    ownerTeam,
    teamConditions,
    excludedBaseStatuses,
    selectFields,
    expandRelations
  } = req.body;

  if (!statuses || !Array.isArray(statuses) || statuses.length === 0) {
    return res.status(400).json({ error: 'Statuses deve ser um array nao vazio' });
  }

  const limit = parseInt(syncLimit) || 100;
  if (limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'Limite deve estar entre 1 e 500' });
  }

  const extraConditions = Array.isArray(teamConditions) ? teamConditions : [];
  const invalidCondition = extraConditions.some((condition) => !String(condition?.ownerTeam || '').trim());
  if (invalidCondition) {
    return res.status(400).json({ error: 'Cada condição adicional precisa informar a equipe do owner' });
  }

  const conditions = {
    statuses,
    serviceFirstLevel: serviceFirstLevel || '',
    customFieldId: customFieldId || '23946',
    customFieldValue: customFieldValue || 'Suporte Técnico',
    syncLimit: limit,
    ownerTeam: ownerTeam || 'VIASOFT - Sistemas Internos',
    teamConditions: extraConditions.map((condition) => ({
      ownerTeam: String(condition.ownerTeam || '').trim(),
      serviceFirstLevel: String(condition.serviceFirstLevel || '').trim()
    })),
    excludedBaseStatuses: Array.isArray(excludedBaseStatuses) ? excludedBaseStatuses : ['Resolved', 'Closed', 'Canceled'],
    selectFields: selectFields || 'id,subject,status,baseStatus,createdDate,lastActionDate,lastUpdate,serviceFirstLevelId,serviceFirstLevel,serviceSecondLevel,slaAgreement,slaAgreementRule,slaSolutionTime,slaResponseTime,slaSolutionDate,slaSolutionDateIsPaused,slaResponseDate,slaRealResponseDate,justification,ownerTeam',
    expandRelations: expandRelations || 'owner,actions($select=id,type,origin,status,createdDate,description;$expand=createdBy),customFieldValues($expand=items),clients($expand=organization)'
  };

  try {
    const json = JSON.stringify(conditions);
    saveConfigValue('movidesk_conditions', json, (err) => {
      if (err) {
        console.error('Erro ao salvar condições Movidesk:', err);
        return res.status(500).json({ error: 'Erro ao salvar condições' });
      }
      res.json({ success: true, message: 'Condições salvas com sucesso' });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// A sincronização deixou de rodar dentro do servidor (era um setInterval
// chamando a API do Movidesk a cada minuto). Agora ela roda só via
// scripts/sync-movidesk.js, agendado fora deste processo — este endpoint
// só informa quando foi a última vez que esse script gravou algo no banco.
router.get('/autosync', authMiddleware, requireRole('admin'), (req, res) => {
  db.get('SELECT MAX(COALESCE(updatedat, syncedat)) AS lastTs FROM tickets', [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao consultar última sincronização' });
    }
    res.json({ lastSyncedAt: row?.lastTs ?? row?.lastts ?? null });
  });
});

// GET - competências de curadoria
router.get('/curadoria-categories', authMiddleware, (req, res) => {
  getConfigValue('curadoria_categories', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    if (!row) return res.json({ categories: null });
    try {
      res.json({ categories: JSON.parse(row.value) });
    } catch {
      res.json({ categories: null });
    }
  });
});

// POST - salvar competências de curadoria (somente admin)
router.post('/curadoria-categories', authMiddleware, requireRole('admin'), (req, res) => {
  const { categories } = req.body;
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: 'Lista de categorias inválida' });
  }
  for (const cat of categories) {
    if (!cat.key || !cat.label || !cat.prompt) {
      return res.status(400).json({ error: `Categoria inválida: campos obrigatórios são key, label e prompt` });
    }
    if (typeof cat.prompt !== 'string' || cat.prompt.trim().length < 10) {
      return res.status(400).json({ error: `Prompt muito curto em "${cat.label}": descreva melhor o critério de avaliação` });
    }
  }
  saveConfigValue('curadoria_categories', JSON.stringify(categories), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar categorias' });
    res.json({ success: true });
  });
});

// GET - pesos do score de performance da curadoria
router.get('/score-weights', authMiddleware, (req, res) => {
  getConfigValue('curadoria_score_weights', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    if (!row) return res.json({ weights: null });
    try {
      res.json({ weights: JSON.parse(row.value) });
    } catch {
      res.json({ weights: null });
    }
  });
});

// POST - salvar pesos do score de performance da curadoria (somente admin)
router.post('/score-weights', authMiddleware, requireRole('admin'), (req, res) => {
  const { weights } = req.body;
  const keys = ['satisfacao', 'eficiencia', 'pontos', 'competencias'];
  if (!weights || typeof weights !== 'object') {
    return res.status(400).json({ error: 'Pesos inválidos' });
  }
  for (const k of keys) {
    const v = Number(weights[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return res.status(400).json({ error: `Peso inválido para "${k}": deve ser um número entre 0 e 1` });
    }
  }
  const sum = keys.reduce((s, k) => s + Number(weights[k]), 0);
  if (Math.abs(sum - 1) > 0.01) {
    return res.status(400).json({ error: `A soma dos pesos deve ser 100% (atual: ${Math.round(sum * 100)}%)` });
  }
  const cleanWeights = {};
  keys.forEach(k => { cleanWeights[k] = Number(weights[k]); });
  saveConfigValue('curadoria_score_weights', JSON.stringify(cleanWeights), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar pesos do score' });
    res.json({ success: true, weights: cleanWeights });
  });
});

// ============================================================
// CURADORIA AVANÇADO — prompt de análise, prompts client-side,
// queries SQL e parâmetros das requisições Movidesk, tudo configurável
// pela aba "Curadoria Avançado" de Configurações, sem editar código.
// ============================================================

const DEFAULT_CURADORIA_PROMPT_ANALISE = {
  template: `Voce e um analista senior de suporte critico que analisa tickets de suporte em JSON.

REGRAS ABSOLUTAS:
- Ignore acoes com type = 1 (acoes internas de escalonamento/atribuicao)
- Ignore acoes onde createdBy.id = "007" (acoes de sistema)
- Suporte = createdBy com email contendo @viasoft.com.br OU createdBy.businessName === owner.businessName (quando businessName nao for vazio)
- Cliente = usuario solicitante do chamado {{solicitante}}
- Fato relatado = {{fato}}
- Causa identificada = {{causa}}
- Modulo X Rotina = {{moduloXRotina}}
- Owner do ticket = {{owner}}
- Aberto em = {{abertoEm}}
- Resolvido em = {{resolvidoEm}}
- Responda APENAS com um JSON valido, sem markdown, sem texto adicional, sem crases, sem \`\`\`json
- Preencha TODOS os campos com dados reais do JSON do ticket
- Nunca use dados ficticios
- Use SEMPRE os nomes e e-mails reais presentes no JSON fornecido

CAMPOS PRE-CALCULADOS:
  - aberto_em = {{abertoEm}}
  - sla_inicio_em = {{slaInicioEm}}
  - resolvido_em = {{resolvidoEm}}
  - tempo_resolucao_min_uteis = {{tempoResolucaoMinUteis}}
  - tempo_resolucao_horas_uteis = {{tempoResolucaoHorasUteis}}
  - tempo_resolucao_dias_uteis = {{tempoResolucaoDiasUteis}}
  - tempo_resolucao_legivel = {{tempoResolucaoLegivel}}
  - abertura_fora_expediente = {{aberturaForaExpediente}}`,
  model: 'gpt-4.1-mini',
  temperature: 0
};

const DEFAULT_CURADORIA_PROMPT_COMPETENCIAS = 'Avaliador de suporte. Para cada chamado listado, identifique quais das competências fornecidas realmente se manifestam no atendimento e atribua um percentual de 0 a 100 indicando a intensidade da evidência. Inclua no JSON apenas as competências que efetivamente se aplicam a cada chamado (omita as que não se aplicam ou têm percentual 0). Use EXATAMENTE as chaves fornecidas em COMPETÊNCIAS, sem alterar acentos ou maiúsculas. Retorne SOMENTE JSON: {"results":{"TICKET_ID":{"CHAVE":percentual}}}. Sem texto adicional.';

const DEFAULT_CURADORIA_PROMPT_NARRATIVA = {
  system: `Você é um analista de operações de suporte. Escreva uma análise curta e objetiva da equipe, em português, EXATAMENTE nesta estrutura (um parágrafo curto por tópico, sem markdown, sem listas, sem títulos extras):

Produtividade: (texto)
Eficiência: (texto)
Feedback: (texto)
Área de melhoria: (texto)

REGRAS:
- Use APENAS os números e nomes fornecidos pelo usuário. Não invente, não estime, não arredonde diferente do fornecido.
- Cite pessoas pelo primeiro nome.
- Seja direto, sem introduções ou conclusões genéricas.`,
  userTemplate: `DADOS DA EQUIPE:
- Total de atendentes: {{totalAtendentes}}
- Total de chamados no período: {{totalChamados}}
- % de chamados avaliados pelo cliente (feedback): {{feedbackRateEquipe}}%
- Cumprimento de SLA da equipe (SLA SUPORTE MOVIDESK.pdf): {{slaEquipe}}%

TOP EM VOLUME DE CHAMADOS: {{topProdutividade}}

TOP EM CUMPRIMENTO DE SLA: {{topSla}}

MENOR TAXA DE FEEDBACK: {{menosFeedback}}

MENOR SCORE (podem precisar de apoio): {{precisamApoio}}`
};

const DEFAULT_CURADORIA_QUERY_CONFIG = {
  listagem: {
    mode: 'guided',
    guided: { limit: 2000, orderDir: 'DESC', includeSatisfacaoSemProcessar: true },
    rawWhere: ''
  },
  pendentes: {
    mode: 'guided',
    guided: { processadoValue: 0, orderDir: 'ASC' },
    rawWhere: ''
  }
};

const DEFAULT_CURADORIA_MOVIDESK_CONFIG = {
  satisfacao: { selectFields: 'id,satisfactionSurveyResponses' },
  moduloRotina: { customFieldId: 59786, selectFields: 'id,customFieldValues' },
  rateLimitMs: 6500,
  fullLoadTimes: ['08:00', '12:00', '19:00'],
  // Carga agendada da pesquisa de satisfação escopada a um ano específico (ex: reprocessar
  // 2024 todo dia às 03:00) — independente da carga bruta (fullLoadTimes), que roda os 3
  // jobs de enriquecimento sem filtro de ano.
  surveySyncSchedule: { enabled: false, year: null, times: [] }
};

// Sanitiza a condição WHERE avançada opcional: aceita só um FRAGMENTO booleano
// (nunca uma query completa), bloqueando ; comentários e palavras-chave de DDL/DML.
const RAW_WHERE_FORBIDDEN = /(;|--|\/\*|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|exec|execute|copy|merge|call)\b)/i;
function sanitizeRawWhere(fragment) {
  const trimmed = String(fragment || '').trim();
  if (!trimmed) throw new Error('Condição SQL avançada não pode estar vazia');
  if (RAW_WHERE_FORBIDDEN.test(trimmed)) {
    throw new Error('Condição SQL avançada contém termos não permitidos (apenas uma condição WHERE simples, sem ; -- /* ou comandos DDL/DML)');
  }
  return trimmed;
}

// GET/POST - prompt principal de análise comportamental por IA (backend, chamado por chamado)
router.get('/curadoria-prompt-analise', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('curadoria_prompt_analise', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    let config = DEFAULT_CURADORIA_PROMPT_ANALISE;
    if (row && row.value) {
      try { config = { ...DEFAULT_CURADORIA_PROMPT_ANALISE, ...JSON.parse(row.value) }; } catch (e) { console.warn('Erro ao parsear curadoria_prompt_analise:', e); }
    }
    res.json(config);
  });
});

router.post('/curadoria-prompt-analise', authMiddleware, requireRole('admin'), (req, res) => {
  const { template, model, temperature } = req.body;
  if (!template || typeof template !== 'string' || !template.trim()) {
    return res.status(400).json({ error: 'Template do prompt não pode estar vazio' });
  }
  const temp = temperature === undefined || temperature === null || temperature === '' ? 0 : Number(temperature);
  if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
    return res.status(400).json({ error: 'Temperatura deve ser um número entre 0 e 2' });
  }
  const config = { template: template.trim(), model: (model || DEFAULT_CURADORIA_PROMPT_ANALISE.model).trim(), temperature: temp };
  saveConfigValue('curadoria_prompt_analise', JSON.stringify(config), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar prompt de análise' });
    res.json({ success: true, ...config });
  });
});

// GET/POST - prompt de classificação de competências (usado no browser, qualquer usuário autenticado pode ler)
router.get('/curadoria-prompt-competencias', authMiddleware, (req, res) => {
  getConfigValue('curadoria_prompt_competencias', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    res.json({ prompt: (row && row.value) || DEFAULT_CURADORIA_PROMPT_COMPETENCIAS });
  });
});

router.post('/curadoria-prompt-competencias', authMiddleware, requireRole('admin'), (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
    return res.status(400).json({ error: 'Prompt muito curto: descreva melhor o critério de classificação' });
  }
  saveConfigValue('curadoria_prompt_competencias', prompt.trim(), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar prompt de competências' });
    res.json({ success: true, prompt: prompt.trim() });
  });
});

// GET/POST - prompt da narrativa da equipe (usado no browser, qualquer usuário autenticado pode ler)
router.get('/curadoria-prompt-narrativa', authMiddleware, (req, res) => {
  getConfigValue('curadoria_prompt_narrativa', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    let config = DEFAULT_CURADORIA_PROMPT_NARRATIVA;
    if (row && row.value) {
      try { config = { ...DEFAULT_CURADORIA_PROMPT_NARRATIVA, ...JSON.parse(row.value) }; } catch (e) { console.warn('Erro ao parsear curadoria_prompt_narrativa:', e); }
    }
    res.json(config);
  });
});

router.post('/curadoria-prompt-narrativa', authMiddleware, requireRole('admin'), (req, res) => {
  const { system, userTemplate } = req.body;
  if (!system || typeof system !== 'string' || !system.trim()) {
    return res.status(400).json({ error: 'Prompt system não pode estar vazio' });
  }
  if (!userTemplate || typeof userTemplate !== 'string' || !userTemplate.trim()) {
    return res.status(400).json({ error: 'Template do prompt de usuário não pode estar vazio' });
  }
  const config = { system: system.trim(), userTemplate: userTemplate.trim() };
  saveConfigValue('curadoria_prompt_narrativa', JSON.stringify(config), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar prompt de narrativa' });
    res.json({ success: true, ...config });
  });
});

// GET/POST - configuração das queries SQL de curadoria (listagem e fila de pendentes)
router.get('/curadoria-query-config', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('curadoria_query_config', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    let config = DEFAULT_CURADORIA_QUERY_CONFIG;
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        config = {
          listagem: { ...DEFAULT_CURADORIA_QUERY_CONFIG.listagem, ...parsed.listagem, guided: { ...DEFAULT_CURADORIA_QUERY_CONFIG.listagem.guided, ...parsed.listagem?.guided } },
          pendentes: { ...DEFAULT_CURADORIA_QUERY_CONFIG.pendentes, ...parsed.pendentes, guided: { ...DEFAULT_CURADORIA_QUERY_CONFIG.pendentes.guided, ...parsed.pendentes?.guided } }
        };
      } catch (e) { console.warn('Erro ao parsear curadoria_query_config:', e); }
    }
    res.json(config);
  });
});

router.post('/curadoria-query-config', authMiddleware, requireRole('admin'), (req, res) => {
  const { listagem, pendentes } = req.body;
  const orderDirs = ['ASC', 'DESC'];

  try {
    if (!listagem || !pendentes) throw new Error('listagem e pendentes são obrigatórios');

    const listagemMode = listagem.mode === 'raw' ? 'raw' : 'guided';
    const listagemLimit = parseInt(listagem.guided?.limit, 10) || DEFAULT_CURADORIA_QUERY_CONFIG.listagem.guided.limit;
    if (listagemLimit < 1 || listagemLimit > 20000) throw new Error('Limite da listagem deve estar entre 1 e 20000');
    const listagemOrderDir = orderDirs.includes(listagem.guided?.orderDir) ? listagem.guided.orderDir : 'DESC';
    let listagemRawWhere = '';
    if (listagemMode === 'raw') listagemRawWhere = sanitizeRawWhere(listagem.rawWhere);

    const pendentesMode = pendentes.mode === 'raw' ? 'raw' : 'guided';
    const pendentesProcessadoValue = Number.isFinite(Number(pendentes.guided?.processadoValue)) ? Number(pendentes.guided.processadoValue) : 0;
    const pendentesOrderDir = orderDirs.includes(pendentes.guided?.orderDir) ? pendentes.guided.orderDir : 'ASC';
    let pendentesRawWhere = '';
    if (pendentesMode === 'raw') pendentesRawWhere = sanitizeRawWhere(pendentes.rawWhere);

    const config = {
      listagem: {
        mode: listagemMode,
        guided: { limit: listagemLimit, orderDir: listagemOrderDir, includeSatisfacaoSemProcessar: !!listagem.guided?.includeSatisfacaoSemProcessar },
        rawWhere: listagemRawWhere
      },
      pendentes: {
        mode: pendentesMode,
        guided: { processadoValue: pendentesProcessadoValue, orderDir: pendentesOrderDir },
        rawWhere: pendentesRawWhere
      }
    };

    saveConfigValue('curadoria_query_config', JSON.stringify(config), (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao salvar configuração de queries' });
      res.json({ success: true, ...config });
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET/POST - parâmetros das requisições Movidesk específicas da curadoria (satisfação, módulo x rotina, carga agendada)
router.get('/curadoria-movidesk-config', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('curadoria_movidesk_config', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    let config = DEFAULT_CURADORIA_MOVIDESK_CONFIG;
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        config = {
          satisfacao: { ...DEFAULT_CURADORIA_MOVIDESK_CONFIG.satisfacao, ...parsed.satisfacao },
          moduloRotina: { ...DEFAULT_CURADORIA_MOVIDESK_CONFIG.moduloRotina, ...parsed.moduloRotina },
          rateLimitMs: parsed.rateLimitMs || DEFAULT_CURADORIA_MOVIDESK_CONFIG.rateLimitMs,
          fullLoadTimes: Array.isArray(parsed.fullLoadTimes) && parsed.fullLoadTimes.length ? parsed.fullLoadTimes : DEFAULT_CURADORIA_MOVIDESK_CONFIG.fullLoadTimes,
          surveySyncSchedule: {
            enabled: !!parsed.surveySyncSchedule?.enabled,
            year: Number.isFinite(parsed.surveySyncSchedule?.year) ? parsed.surveySyncSchedule.year : null,
            times: Array.isArray(parsed.surveySyncSchedule?.times) ? parsed.surveySyncSchedule.times : []
          }
        };
      } catch (e) { console.warn('Erro ao parsear curadoria_movidesk_config:', e); }
    }
    res.json(config);
  });
});

router.post('/curadoria-movidesk-config', authMiddleware, requireRole('admin'), (req, res) => {
  const { satisfacao, moduloRotina, rateLimitMs, fullLoadTimes, surveySyncSchedule } = req.body;

  const rate = parseInt(rateLimitMs, 10) || DEFAULT_CURADORIA_MOVIDESK_CONFIG.rateLimitMs;
  if (rate < 1000 || rate > 60000) {
    return res.status(400).json({ error: 'Intervalo de rate-limit deve estar entre 1000 e 60000 ms' });
  }

  const customFieldId = parseInt(moduloRotina?.customFieldId, 10);
  if (!Number.isFinite(customFieldId)) {
    return res.status(400).json({ error: 'ID do campo customizado (Módulo x Rotina) inválido' });
  }

  const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const times = Array.isArray(fullLoadTimes) ? fullLoadTimes.filter(t => timePattern.test(String(t).trim())) : [];
  if (!times.length) {
    return res.status(400).json({ error: 'Informe ao menos um horário válido (HH:MM) para a carga agendada' });
  }

  const surveyScheduleEnabled = !!surveySyncSchedule?.enabled;
  const surveyScheduleTimes = Array.isArray(surveySyncSchedule?.times)
    ? surveySyncSchedule.times.filter(t => timePattern.test(String(t).trim()))
    : [];
  if (surveyScheduleEnabled && !surveyScheduleTimes.length) {
    return res.status(400).json({ error: 'Informe ao menos um horário válido (HH:MM) para a carga agendada de satisfação por ano' });
  }
  const surveyScheduleYear = parseInt(surveySyncSchedule?.year, 10);

  const config = {
    satisfacao: { selectFields: (satisfacao?.selectFields || DEFAULT_CURADORIA_MOVIDESK_CONFIG.satisfacao.selectFields).trim() },
    moduloRotina: { customFieldId, selectFields: (moduloRotina?.selectFields || DEFAULT_CURADORIA_MOVIDESK_CONFIG.moduloRotina.selectFields).trim() },
    rateLimitMs: rate,
    fullLoadTimes: times,
    surveySyncSchedule: {
      enabled: surveyScheduleEnabled,
      year: Number.isFinite(surveyScheduleYear) ? surveyScheduleYear : null,
      times: surveyScheduleTimes
    }
  };

  saveConfigValue('curadoria_movidesk_config', JSON.stringify(config), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar configuração Movidesk da curadoria' });
    res.json({ success: true, ...config });
  });
});

// GET/POST - prazos de SLA de resolução (em horas úteis) por urgência, usados na análise de
// "Cumprimento de SLA" da tela de Curadoria (KPI da equipe, comparativo, e o detalhe por
// atendente) — hoje "SLA SUPORTE MOVIDESK.pdf" v2.0: crítica 4h, alta 8h, média 16h, baixa 24h.
const DEFAULT_CURADORIA_SLA_THRESHOLDS = { critica: 4, alta: 8, media: 16, baixa: 24 };

router.get('/curadoria-sla-thresholds', authMiddleware, (req, res) => {
  getConfigValue('curadoria_sla_thresholds', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    let config = DEFAULT_CURADORIA_SLA_THRESHOLDS;
    if (row && row.value) {
      try { config = { ...DEFAULT_CURADORIA_SLA_THRESHOLDS, ...JSON.parse(row.value) }; } catch (e) { console.warn('Erro ao parsear curadoria_sla_thresholds:', e); }
    }
    res.json(config);
  });
});

router.post('/curadoria-sla-thresholds', authMiddleware, requireRole('admin'), (req, res) => {
  const { critica, alta, media, baixa } = req.body;
  const keys = { critica, alta, media, baixa };
  const config = {};
  for (const [key, value] of Object.entries(keys)) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 1000) {
      return res.status(400).json({ error: `Prazo de SLA inválido para "${key}": informe um número de horas maior que 0` });
    }
    config[key] = hours;
  }

  saveConfigValue('curadoria_sla_thresholds', JSON.stringify(config), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar prazos de SLA' });
    res.json({ success: true, ...config });
  });
});

function getCuradoriaSlaThresholds(callback) {
  getConfigValue('curadoria_sla_thresholds', (err, row) => {
    if (err) return callback(err, null);
    let config = DEFAULT_CURADORIA_SLA_THRESHOLDS;
    if (row && row.value) {
      try { config = { ...DEFAULT_CURADORIA_SLA_THRESHOLDS, ...JSON.parse(row.value) }; } catch (_) {}
    }
    callback(null, config);
  });
}

// Critério (editável) usado pela IA para decidir, quando um chamado estoura o SLA de
// resolução, se o atraso foi causado pelo cliente (demorou a responder/confirmar algo que
// dependia dele) ou pelo próprio suporte. Esse texto é concatenado ao prompt principal de
// análise (curadoria_prompt_analise) — não dispara uma chamada de IA extra.
const DEFAULT_CURADORIA_PROMPT_SLA_ESTOURO = `CRITERIO DE ATRIBUICAO DE ESTOURO DE SLA:
- Prazo de resolucao esperado para a urgencia deste chamado = {{slaResolucaoHoras}} horas uteis
- Tempo real de resolucao (ja calculado) = {{tempoResolucaoHorasUteis}} horas uteis
- Se o tempo real for menor ou igual ao prazo esperado, responsavel = "nao_estourou"
- Se o tempo real for maior que o prazo esperado, analise a tabela de acoes em ordem cronologica (autor, tipo e data) para decidir quem causou o atraso:
  - "cliente": o suporte respondeu, sinalizou solucao ou pediu uma confirmacao/informacao, e o cliente demorou a responder ou confirmar, sendo essa demora do cliente o principal motivo do estouro
  - "suporte": o atraso decorreu de demora do proprio suporte em responder, investigar, agir ou dar sequencia
  - "indisponivel": nao ha acoes ou dados suficientes para decidir com confianca
- Preencha justificativa em ate 2 frases e liste de 1 a 3 evidencias reais (id da acao, autor e data) que sustentam a decisao`;

router.get('/curadoria-prompt-sla-estouro', authMiddleware, requireRole('admin'), (req, res) => {
  getConfigValue('curadoria_prompt_sla_estouro', (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    res.json({ prompt: row?.value || DEFAULT_CURADORIA_PROMPT_SLA_ESTOURO });
  });
});

router.post('/curadoria-prompt-sla-estouro', authMiddleware, requireRole('admin'), (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
    return res.status(400).json({ error: 'Prompt muito curto: descreva melhor o critério de atribuição' });
  }
  saveConfigValue('curadoria_prompt_sla_estouro', prompt.trim(), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar prompt de estouro de SLA' });
    res.json({ success: true, prompt: prompt.trim() });
  });
});

function getCuradoriaPromptSlaEstouro(callback) {
  getConfigValue('curadoria_prompt_sla_estouro', (err, row) => {
    if (err) return callback(err, null);
    callback(null, (row && row.value) || DEFAULT_CURADORIA_PROMPT_SLA_ESTOURO);
  });
}

function getCuradoriaPromptAnalise(callback) {
  getConfigValue('curadoria_prompt_analise', (err, row) => {
    if (err) return callback(err, null);
    let config = DEFAULT_CURADORIA_PROMPT_ANALISE;
    if (row && row.value) {
      try { config = { ...DEFAULT_CURADORIA_PROMPT_ANALISE, ...JSON.parse(row.value) }; } catch (_) {}
    }
    callback(null, config);
  });
}

function getCuradoriaPromptCompetencias(callback) {
  getConfigValue('curadoria_prompt_competencias', (err, row) => {
    if (err) return callback(err, null);
    callback(null, (row && row.value) || DEFAULT_CURADORIA_PROMPT_COMPETENCIAS);
  });
}

function getCuradoriaPromptNarrativa(callback) {
  getConfigValue('curadoria_prompt_narrativa', (err, row) => {
    if (err) return callback(err, null);
    let config = DEFAULT_CURADORIA_PROMPT_NARRATIVA;
    if (row && row.value) {
      try { config = { ...DEFAULT_CURADORIA_PROMPT_NARRATIVA, ...JSON.parse(row.value) }; } catch (_) {}
    }
    callback(null, config);
  });
}

function getCuradoriaQueryConfig(callback) {
  getConfigValue('curadoria_query_config', (err, row) => {
    if (err) return callback(err, null);
    let config = DEFAULT_CURADORIA_QUERY_CONFIG;
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        config = {
          listagem: { ...DEFAULT_CURADORIA_QUERY_CONFIG.listagem, ...parsed.listagem, guided: { ...DEFAULT_CURADORIA_QUERY_CONFIG.listagem.guided, ...parsed.listagem?.guided } },
          pendentes: { ...DEFAULT_CURADORIA_QUERY_CONFIG.pendentes, ...parsed.pendentes, guided: { ...DEFAULT_CURADORIA_QUERY_CONFIG.pendentes.guided, ...parsed.pendentes?.guided } }
        };
      } catch (_) {}
    }
    callback(null, config);
  });
}

function getCuradoriaMovideskConfig(callback) {
  getConfigValue('curadoria_movidesk_config', (err, row) => {
    if (err) return callback(err, null);
    let config = DEFAULT_CURADORIA_MOVIDESK_CONFIG;
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        config = {
          satisfacao: { ...DEFAULT_CURADORIA_MOVIDESK_CONFIG.satisfacao, ...parsed.satisfacao },
          moduloRotina: { ...DEFAULT_CURADORIA_MOVIDESK_CONFIG.moduloRotina, ...parsed.moduloRotina },
          rateLimitMs: parsed.rateLimitMs || DEFAULT_CURADORIA_MOVIDESK_CONFIG.rateLimitMs,
          fullLoadTimes: Array.isArray(parsed.fullLoadTimes) && parsed.fullLoadTimes.length ? parsed.fullLoadTimes : DEFAULT_CURADORIA_MOVIDESK_CONFIG.fullLoadTimes,
          surveySyncSchedule: {
            enabled: !!parsed.surveySyncSchedule?.enabled,
            year: Number.isFinite(parsed.surveySyncSchedule?.year) ? parsed.surveySyncSchedule.year : null,
            times: Array.isArray(parsed.surveySyncSchedule?.times) ? parsed.surveySyncSchedule.times : []
          }
        };
      } catch (_) {}
    }
    callback(null, config);
  });
}

// ============================================================
// AI USAGE LOG
// ============================================================

// Preços por 1M tokens (gpt-4o-mini e gpt-4.1-mini — mesmos preços)
const AI_PRICES = {
  'gpt-4o-mini':  { input: 0.15, output: 0.60 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4o':       { input: 5.00, output: 15.00 },
  'gpt-4.1':      { input: 2.00, output:  8.00 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const price = AI_PRICES[model] || AI_PRICES['gpt-4o-mini'];
  return ((inputTokens * price.input) + (outputTokens * price.output)) / 1_000_000;
}

// POST - registrar uso de IA (chamado pelo frontend e pelo backend)
router.post('/ai-usage', authMiddleware, (req, res) => {
  const { source, model, input_tokens, output_tokens, meta } = req.body;
  if (!source || input_tokens == null || output_tokens == null) {
    return res.status(400).json({ error: 'Campos obrigatórios: source, input_tokens, output_tokens' });
  }
  const totalTokens = (input_tokens || 0) + (output_tokens || 0);
  const cost = estimateCost(model || 'gpt-4o-mini', input_tokens || 0, output_tokens || 0);
  const userEmail = req.user?.email || null;

  db.run(
    `INSERT INTO ai_usage_log (source, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd, user_email, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [source, model || 'gpt-4o-mini', input_tokens || 0, output_tokens || 0, totalTokens, cost, userEmail, meta ? JSON.stringify(meta) : null],
    (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao salvar usage' });
      res.json({ success: true, cost });
    }
  );
});

// GET - consultar usage agregado (somente admin)
router.get('/ai-usage', authMiddleware, requireRole('admin'), (req, res) => {
  const days = parseInt(req.query.days || '30', 10);

  db.get(
    `SELECT
       COUNT(*)                                    AS total_calls,
       COALESCE(SUM(input_tokens),  0)             AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0)             AS total_output_tokens,
       COALESCE(SUM(total_tokens),  0)             AS total_tokens,
       COALESCE(SUM(estimated_cost_usd), 0)        AS total_cost_usd
     FROM ai_usage_log
     WHERE created_at >= NOW() - INTERVAL '${days} days'`,
    [],
    (err, summary) => {
      if (err) return res.status(500).json({ error: 'Erro ao consultar usage' });

      db.all(
        `SELECT
           source,
           model,
           COUNT(*)                             AS calls,
           COALESCE(SUM(total_tokens),  0)      AS tokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd
         FROM ai_usage_log
         WHERE created_at >= NOW() - INTERVAL '${days} days'
         GROUP BY source, model
         ORDER BY cost_usd DESC`,
        [],
        (err2, bySource) => {
          if (err2) return res.status(500).json({ error: 'Erro ao consultar breakdown' });

          db.all(
            `SELECT
               DATE(created_at) AS day,
               COALESCE(SUM(total_tokens),  0)      AS tokens,
               COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd
             FROM ai_usage_log
             WHERE created_at >= NOW() - INTERVAL '${days} days'
             GROUP BY DATE(created_at)
             ORDER BY day ASC`,
            [],
            (err3, daily) => {
              if (err3) return res.status(500).json({ error: 'Erro ao consultar histórico diário' });
              res.json({ summary, bySource: bySource || [], daily: daily || [], days });
            }
          );
        }
      );
    }
  );
});

// ============================================================
// PERFORMANCE SCORE HISTORY — snapshots do score 0-1000
// ============================================================

// POST - salvar snapshot do score de um colaborador
router.post('/performance-snapshot', authMiddleware, (req, res) => {
  const {
    owner_name, score, seniority_label, seniority_reason,
    total_tickets, avg_satisfaction, first_contact_rate,
    open_tickets_count, avg_open_tickets_ref,
    sat_score, vol_score, pos_score, comp_score,
    gaps_count, breakdown, period_start, period_end
  } = req.body;

  if (!owner_name || score == null) {
    return res.status(400).json({ error: 'Campos obrigatórios: owner_name, score' });
  }

  const userEmail = req.user?.email || null;

  db.run(
    `INSERT INTO performance_score_history
       (owner_name, score, seniority_label, seniority_reason, total_tickets,
        avg_satisfaction, first_contact_rate, open_tickets_count, avg_open_tickets_ref,
        sat_score, vol_score, pos_score, comp_score, gaps_count, breakdown,
        period_start, period_end, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      owner_name, score, seniority_label || null, seniority_reason || null, total_tickets || 0,
      avg_satisfaction || null, first_contact_rate || null, open_tickets_count || 0, avg_open_tickets_ref || null,
      sat_score || null, vol_score || null, pos_score || null, comp_score || null,
      gaps_count || 0, breakdown ? JSON.stringify(breakdown) : null,
      period_start || null, period_end || null, userEmail
    ],
    (err) => {
      if (err) { console.error('Erro ao salvar performance-snapshot:', err.message); return res.status(500).json({ error: 'Erro ao salvar snapshot' }); }
      res.json({ success: true });
    }
  );
});

// GET - histórico de scores de um colaborador
router.get('/performance-history', authMiddleware, (req, res) => {
  const owner = req.query.owner;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  if (!owner) return res.status(400).json({ error: 'Parâmetro owner é obrigatório' });

  db.all(
    `SELECT * FROM performance_score_history
     WHERE owner_name = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [owner, limit],
    (err, rows) => {
      if (err) { console.error('Erro ao consultar performance-history:', err.message); return res.status(500).json({ error: 'Erro ao consultar histórico' }); }
      res.json({ owner, history: rows || [] });
    }
  );
});

// GET - último snapshot de todos os colaboradores (para listagens/ranking)
router.get('/performance-history-latest', authMiddleware, (req, res) => {
  db.all(
    `SELECT DISTINCT ON (owner_name) *
     FROM performance_score_history
     ORDER BY owner_name, created_at DESC`,
    [],
    (err, rows) => {
      if (err) { console.error('Erro ao consultar performance-history-latest:', err.message); return res.status(500).json({ error: 'Erro ao consultar histórico' }); }
      res.json({ latest: rows || [] });
    }
  );
});

// ══════════════════════════════════════════════════════════════════
// Acesso por perfil — quais abas cada perfil vê no menu (Configurações →
// Acesso). "admin" nunca aparece aqui: tem acesso a tudo sempre, sem
// depender desta configuração (evita alguém se trancar fora por engano).
// "Pessoas" e "Configurações" também ficam de fora — continuam restritas
// a admin por uma checagem própria (isCurrentUserAdmin), não por aqui.
// ══════════════════════════════════════════════════════════════════
const TAB_PERMISSION_TABS = ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk'];
const DEFAULT_TAB_PERMISSIONS = {
  supervisor: ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk'],
  atendente: ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk'],
  guest: ['dashboard'],
};

function getTabPermissions(callback) {
  db.query(`SELECT name FROM roles WHERE name <> 'admin' ORDER BY name`).then((rolesResult) => {
    getConfigValue('role_tab_permissions', (err, row) => {
      if (err) return callback(err);
      let saved = {};
      if (row) { try { saved = JSON.parse(row.value) || {}; } catch { saved = {}; } }
      const merged = {};
      rolesResult.rows.forEach(({ name: role }) => {
        const list = Array.isArray(saved[role]) ? saved[role] : (DEFAULT_TAB_PERMISSIONS[role] || []);
        merged[role] = list.filter((t) => TAB_PERMISSION_TABS.includes(t));
      });
      callback(null, merged);
    });
  }).catch(callback);
}

// Middleware — bloqueia quem não tem a aba `tabKey` liberada pro perfil dele.
// admin passa direto; os demais dependem do que está salvo em Configurações → Acesso.
function requireTabAccess(tabKey) {
  return async (req, res, next) => {
    try {
      const roleResult = await db.query(
        `SELECT r.name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`,
        [req.user.id]
      );
      const roleName = roleResult.rows[0]?.name;
      if (!roleName) return res.status(403).json({ error: 'Acesso negado.' });
      if (roleName === 'admin') return next();

      getTabPermissions((err, perms) => {
        if (err) {
          console.error('requireTabAccess erro ao ler permissões:', err.message);
          return res.status(500).json({ error: 'Erro ao verificar permissão' });
        }
        const allowed = perms[roleName] || [];
        if (!allowed.includes(tabKey)) {
          return res.status(403).json({ error: 'Seu perfil não tem acesso a esta área.' });
        }
        next();
      });
    } catch (err) {
      console.error('requireTabAccess error:', err.message);
      return res.status(500).json({ error: 'Erro ao verificar permissão' });
    }
  };
}

// GET - qualquer usuário logado precisa disso pra saber o que mostrar no menu
router.get('/tab-permissions', authMiddleware, (req, res) => {
  getTabPermissions((err, perms) => {
    if (err) return res.status(500).json({ error: 'Erro ao consultar banco de dados' });
    res.json({ permissions: perms, tabs: TAB_PERMISSION_TABS });
  });
});

// POST - somente admin edita
router.post('/tab-permissions', authMiddleware, requireRole('admin'), async (req, res) => {
  const { permissions } = req.body || {};
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return res.status(400).json({ error: 'Formato inválido' });
  }
  const cleaned = {};
  const rolesResult = await db.query(`SELECT name FROM roles WHERE name <> 'admin'`);
  for (const { name: role } of rolesResult.rows) {
    const list = permissions[role];
    if (list !== undefined && !Array.isArray(list)) {
      return res.status(400).json({ error: `Lista de abas inválida para o perfil "${role}"` });
    }
    cleaned[role] = Array.isArray(list) ? list.filter((t) => TAB_PERMISSION_TABS.includes(t)) : [];
  }
  saveConfigValue('role_tab_permissions', JSON.stringify(cleaned), (err) => {
    if (err) return res.status(500).json({ error: 'Erro ao salvar permissões' });
    res.json({ success: true, permissions: cleaned });
  });
});

module.exports = {
  router, getToken, getPrompt, getDatabaseConfig, getMovideskConditions,
  getCuradoriaPromptAnalise, getCuradoriaPromptCompetencias, getCuradoriaPromptNarrativa,
  getCuradoriaQueryConfig, getCuradoriaMovideskConfig, sanitizeRawWhere,
  getCuradoriaSlaThresholds, getCuradoriaPromptSlaEstouro,
  requireTabAccess, getTabPermissions
};
