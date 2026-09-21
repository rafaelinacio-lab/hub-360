'use strict';
/**
 * movidesk-loader.js
 *
 * Sistema de carga do datalake Movidesk → silver.*
 *
 * MODOS:
 *   full        — todos os tickets de todos os tempos (semanal, domingos 02h)
 *   incremental — tickets em aberto + atualizados nas últimas 24h (diário, 05h)
 *
 * TABELAS GRAVADAS:
 *   silver.ticket                   — dados principais do ticket
 *   silver.ticket_acao              — todas as ações do chamado
 *   silver.ticket_campo_customizado — campos customizados (un-pivot)
 *   silver.ticket_cliente           — clientes/organizações do chamado
 *   silver.carga_log                — histórico de execuções
 */

const fetch   = require('node-fetch');
const db      = require('../db/remote');
const { getToken } = require('../routes/config');

// ── Constantes ────────────────────────────────────────────────────────────────
const MOVI_BASE   = 'https://apimovidesk.viasoftcloud.com.br/public/v1';
const PAGE_SIZE   = 100;  // 500 com expand completo causa timeout no Movidesk
const MAX_RETRIES = 5;

// baseStatus que indicam chamado FECHADO (incremental não precisa incluir)
const CLOSED_STATUSES = [
  'Resolved', 'Closed', 'Canceled',
  'Resolvido', 'Fechado', 'Cancelado',
];

// Campo personalizado "Classificação de Ticket" — usado pela carga Ouvidoria.
// customFieldId=23946 é o id "canônico" que usamos pra GRAVAR (é o que as
// rotas ouvidoria.js/gcc.js filtram em silver.ticket_campo_customizado), mas
// pra CONFERIR se um ticket é da classificação certa usamos customFieldRuleId
// (ver RULE_ID_CLASSIFICACAO) — o Movidesk usa customFieldId diferentes por
// formulário/equipe pra essa mesma pergunta ("Classificação de Ticket"), mas
// o customFieldRuleId é estável entre eles. Confirmado: pro formulário da
// equipe Ouvidoria, a classificação vem sob outro customFieldId — checar só
// por 23946 nunca achava o campo certo e descartava todos os tickets.
const CF_CLASSIFICACAO = 23946;
const RULE_ID_CLASSIFICACAO = 11397;

// Acha a entrada de customFieldValues que representa "Classificação de
// Ticket", primeiro por customFieldRuleId (estável entre formulários),
// com fallback pro customFieldId canônico caso o ruleId não venha na resposta.
function acharCampoClassificacao(customFieldValues) {
  if (!Array.isArray(customFieldValues)) return null;
  return customFieldValues.find(c => Number(c.customFieldRuleId) === RULE_ID_CLASSIFICACAO)
      || customFieldValues.find(c => Number(c.customFieldId) === CF_CLASSIFICACAO)
      || null;
}

// Pra classificações com uma equipe (ownerTeam) dedicada no Movidesk, filtrar
// por ownerTeam é MUITO mais barato pra API do que o filtro aninhado
// customFieldValues/any(...): é um campo plano, sem lambda "any" pra avaliar
// por ticket. Confirmado pelo fluxo n8n que a equipe já usa pra conferência
// manual de contagem (ownerTeam eq 'Ouvidoria', $top=1000, sem timeout).
// Classificações sem entrada aqui caem no filtro aninhado como fallback.
const CLASS_TO_OWNER_TEAM = {
  'Ouvidoria': 'Ouvidoria',
  'Gestão de Combate ao Churn': 'GCC - Gestão de Combate ao Churn',
};

// Mapeamento inverso — usado quando o usuário escolhe só a Equipe (sem
// preencher Classificação de Ticket) na Carga Full: se a equipe escolhida
// corresponde a uma classificação conhecida, ainda queremos rodar o patch de
// canonicalização (ver makeSaveComClassificacao) com esse valor, senão os
// tickets ficam salvos em silver.ticket mas invisíveis nas telas de
// Ouvidoria/GCC (que filtram pela classificação, não pela equipe).
const OWNER_TEAM_TO_CLASS = Object.fromEntries(
  Object.entries(CLASS_TO_OWNER_TEAM).map(([classe, equipe]) => [equipe, classe])
);

function normalizar(v) {
  // Remove marcas diacríticas (acentos) após normalize('NFD') separá-las da
  // letra base — sem regex de unicode escape pra evitar mojibake de encoding.
  let semAcento = '';
  for (const ch of String(v || '').normalize('NFD')) {
    const code = ch.codePointAt(0);
    if (code >= 0x0300 && code <= 0x036f) continue;
    semAcento += ch;
  }
  return semAcento.replace(/\s+/g, ' ').trim().toUpperCase();
}

// Confere se o ticket já tem a classificação esperada, usando os dados que a
// própria API devolveu (items, com fallback pra value). Retorna true/false
// quando dá pra confirmar, ou null quando a API não devolveu nada usável
// (bug de serialização confirmado: customFieldValues[].items ausente pra
// alguns tickets abertos via formulário/automação — nesses casos o chamador
// decide o que fazer, normalmente confiando no filtro que já trouxe o ticket).
function checaClassificacao(customFieldValues, valorEsperado) {
  const cf = acharCampoClassificacao(customFieldValues);
  if (!cf) return null;
  const items = Array.isArray(cf.items)
    ? cf.items.map(it => it.customFieldItem || it.value || it.text || '').filter(Boolean)
    : [];
  if (items.length) return items.some(v => normalizar(v).includes(normalizar(valorEsperado)));
  if (cf.value !== null && cf.value !== undefined && cf.value !== '') {
    return normalizar(String(cf.value)).includes(normalizar(valorEsperado));
  }
  return null;
}

// Monta o callback de save que confirma a classificação (aplica o patch de
// classificação canônica só nos que confirmam) e aplica o patch pro bug de
// items ausente (ver checaClassificacao acima) nos que ficam.
//
// BUG CORRIGIDO: antes, um ticket que veio pelo filtro de ownerTeam mas cuja
// classificação real mudou pra outra coisa (ex: reclassificado de
// "Ouvidoria" pra "Visitas a Clientes" depois de já ter sido carregado uma
// vez) era simplesmente DESCARTADO (continue) — nunca chegava a ser salvo de
// novo. Isso deixava a linha antiga em silver.ticket/ticket_campo_customizado
// congelada pra sempre com o status/classificação de quando foi carregado a
// última vez, e nenhuma carga full/sincronização subsequente corrigia,
// porque o próprio filtro de classificação (customFieldValues/any(...))
// também exclui esse ticket da busca. Ticket #874687 é um caso real: virou
// "Cancelado" no Movidesk, mas continuava aparecendo como "Resolvido" na
// Ouvidoria porque a classificação dele tinha mudado pra "Visitas a
// Clientes" nesse meio tempo. Agora, em vez de descartar, salvamos o ticket
// como ele realmente está (sem forçar a classificação) — assim o dado fica
// correto e, como a classificação real não é mais "Ouvidoria"/"GCC", ele
// some sozinho do painel errado na consulta (que filtra por classificação).
function makeSaveComClassificacao(classValue) {
  return async (batch) => {
    const confirmados = [];
    const outros = [];
    for (const t of batch) {
      const confirmado = checaClassificacao(t.customFieldValues, classValue);
      if (confirmado === false) { outros.push(t); continue; } // classificação explicitamente diferente agora — salva como está, sem forçar
      if (!Array.isArray(t.customFieldValues)) t.customFieldValues = [];
      // Garante uma entrada CANÔNICA sob CF_CLASSIFICACAO (23946) — é o id que
      // silver.ticket_campo_customizado usa nas consultas de ouvidoria.js/gcc.js.
      // O campo real da classificação pode vir sob outro customFieldId (form
      // diferente por equipe — ver acharCampoClassificacao), caso em que o que
      // porventura já exista sob 23946 é uma pergunta não relacionada desse
      // form e precisa ser SOBRESCRITO (não só preenchido quando ausente),
      // senão a Ouvidoria/GCC nunca encontra o ticket na consulta.
      let cfCanonico = t.customFieldValues.find(c => Number(c.customFieldId) === CF_CLASSIFICACAO);
      if (!cfCanonico) {
        cfCanonico = { customFieldId: CF_CLASSIFICACAO };
        t.customFieldValues.push(cfCanonico);
      }
      cfCanonico.items = [{ customFieldItem: classValue }];
      confirmados.push(t);
    }
    if (outros.length) await saveBatch(outros);
    return saveBatch(confirmados);
  };
}

// ── Estado em memória (acessado pela rota de status) ─────────────────────────
const state = {
  running:    false,
  mode:       null,       // 'full' | 'full-anos' | 'incremental'
  startedAt:  null,
  phase:      'idle',     // 'fetching' | 'saving' | 'cancelling' | 'idle'
  endpoint:   null,       // '/tickets' | '/tickets/past'
  pagesDone:  0,
  ticketsDone: 0,
  savedIds:   new Set(), // ids únicos salvos nesta carga (evita contar 2x um ticket que veio de /tickets e /tickets/past)
  errors:     [],
  lastFinish: null,
  lastResult: null,
  cancelRequested: false,
  // carga por anos
  years:       [],        // anos selecionados ([] = todos)
  currentYear: null,      // ano sendo processado agora
  yearsTotal:  0,
  yearsDone:   0,
};
module.exports.state = state;

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Roda uma escrita com lock_timeout curto, repetindo com backoff se cair em
// lock (55P03) — evita ficar preso indefinidamente quando a procedure externa
// silver.atualizar_silver_gold() segura locks nas mesmas tabelas por dezenas
// de minutos (visto repetidas vezes em produção). Depois de esgotar as
// tentativas, deixa o erro subir: a carga fica com status 'error' e uma
// mensagem clara no histórico, em vez de "running" pra sempre esperando
// alguém notar e matar a sessão travada manualmente via pg_terminate_backend.
async function comLockRetry(fn, { tentativas = 6, lockTimeoutMs = 8000 } = {}) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await db.withClient(async (client) => {
        await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
        try {
          return await fn(client);
        } finally {
          // mesmo motivo do RESET em ensureTables — não deixar o pool herdar
          // esse lock_timeout em queries futuras não relacionadas.
          await client.query('RESET lock_timeout').catch(() => {});
        }
      });
    } catch (e) {
      const eraLockTimeout = e.code === '55P03';
      if (!eraLockTimeout || i === tentativas - 1) throw e;
      const espera = 2000 * Math.pow(2, i) + Math.floor(Math.random() * 500);
      console.warn(`[loader] lock ocupado (tentativa ${i + 1}/${tentativas}) — retry em ${espera}ms`);
      await sleep(espera);
    }
  }
}

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function getMovideskToken() {
  return new Promise((resolve, reject) =>
    getToken((err, tok) => err ? reject(err) : resolve(tok))
  );
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const resp = await fetch(url, { timeout: 30000 });
      if (resp.ok) return resp;
      const body = await resp.text().catch(() => '');
      lastErr = new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      const retryable = resp.status === 429 || resp.status === 408 || resp.status >= 500;
      if (!retryable || i === MAX_RETRIES) throw lastErr;
      const ms = 1000 * Math.pow(2, i) + Math.floor(Math.random() * 400);
      console.warn(`[loader] retry ${i + 1}/${MAX_RETRIES} in ${ms}ms — ${lastErr.message}`);
      await sleep(ms);
    } catch (e) {
      if (i === MAX_RETRIES) throw e;
      lastErr = e;
      await sleep(1000 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ── Query params da API ───────────────────────────────────────────────────────
const SELECT_FIELDS = [
  'id', 'subject', 'category', 'urgency', 'status', 'baseStatus',
  'ownerTeam', 'serviceFull', 'createdDate', 'resolvedIn', 'closedIn',
  'lastUpdate', 'stoppedTime', 'stoppedTimeWorkingTime', 'slaRealResponseDate',
  'slaSolutionDate', // prazo (deadline) de solução do SLA — usado pro card "Tickets vencidos"
  'reopenedIn', // usado pro card "Taxa de reabertura" do Painel Geral
].join(',');

// Movidesk OData não suporta sintaxe aninhada v4 (semicolons, $select dentro de $expand).
// Expande apenas os nomes das entidades — o servidor retorna todos os campos delas.
const EXPAND_FIELDS = 'owner,clients,customFieldValues,actions';

// Bug confirmado na API do Movidesk: QUALQUER $filter (mesmo o mais simples,
// tipo "ownerTeam eq 'Ouvidoria'") combinado com $expand=customFieldValues faz
// os campos customizados virem com value:null e SEM a chave "items" — pra
// TODOS os campos do ticket, não só a classificação. Confirmado via curl
// comparando a mesma busca com e sem $filter (sem filtro, usando só
// "id=<id>", os campos vêm certos). $select=customFieldValues sem $expand
// também não funciona (a API ignora o campo). O único jeito confiável de
// pegar os campos customizados certos é buscar o ticket individualmente por
// "id=" — sem $filter algum. Isso custa 1 requisição extra por ticket, então
// só aplicamos na carga leve (Ouvidoria/GCC em aberto — poucos tickets), não
// no backfill completo (milhares de tickets históricos, ficaria lento demais).
//
// O mesmo bug corrompe QUALQUER campo expandido, não só customFieldValues —
// "clients" (de onde vem a organização) e "actions[].createdBy" (de onde vem
// o autor de cada ação) também vinham vazios/errados em cargas com $filter,
// fazendo a organização sumir e o histórico de ações aparecer todo como
// "Sistema" mesmo com o campo certo do Movidesk. Por isso corrigimos
// clients, owner e actions junto.
async function corrigirCustomFieldValues(token, tickets) {
  for (const t of tickets) {
    if (state.cancelRequested) {
      throw Object.assign(new Error('Carga cancelada pelo usuário'), { cancelled: true });
    }
    try {
      const url = `${MOVI_BASE}/tickets?${qs({ token, id: t.id, '$select': 'id', '$expand': EXPAND_FIELDS })}`;
      const resp = await fetchWithRetry(url);
      const data = await resp.json();
      const full = Array.isArray(data) ? data[0] : data;
      if (full && Array.isArray(full.customFieldValues)) {
        t.customFieldValues = full.customFieldValues;
      }
      if (full && Array.isArray(full.clients)) {
        t.clients = full.clients;
      }
      if (full && full.owner) {
        t.owner = full.owner;
      }
      if (full && Array.isArray(full.actions)) {
        t.actions = full.actions;
      }
    } catch (e) {
      console.warn(`[loader] correção de campos do ticket ${t.id} falhou: ${e.message}`);
    }
    await sleep(120);
  }
}

// ── Busca uma página da API ───────────────────────────────────────────────────
async function fetchPage(token, endpoint, filter, skip, pageSize = PAGE_SIZE) {
  const params = {
    token,
    '$select':  SELECT_FIELDS,
    '$expand':  EXPAND_FIELDS,
    '$top':     pageSize,
    '$skip':    skip,
    // Sem ordenação explícita, $skip pode repetir/pular linhas entre
    // requisições se a ordem "natural" da API não for estável — mesma
    // prática do fluxo n8n da equipe.
    '$orderby': 'id asc',
  };
  if (filter) params['$filter'] = filter;

  const url = `${MOVI_BASE}${endpoint}?${qs(params)}`;
  const resp = await fetchWithRetry(url);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// Páginas menores pro filtro aninhado customFieldValues/any(...) (usado pela
// carga por classificação): a montagem de "id eq X or ..." em lotes esbarrava
// no limite de 100 "nodes" do $filter da API (HTTP 400) sempre que o filtro
// combinado tinha muitos IDs. Paginar direto com o filtro original de
// classificação (via $skip, como fetchEndpoint já faz) resolve isso de vez —
// o filtro tem um número fixo de nodes, não cresce com a quantidade de
// tickets. Um $top menor aqui é só cautela: $expand completo + esse filtro
// aninhado já deu timeout/429 quando testado com $top=1000.
const CLASS_FILTER_PAGE_SIZE = 50;

// ── Itera todas as páginas de um endpoint, chamando onBatch a cada página ────
async function fetchEndpoint(token, endpoint, filter, onBatch, pageSize = PAGE_SIZE) {
  let skip = 0;
  let total = 0;

  state.endpoint = endpoint;

  while (true) {
    if (state.cancelRequested) {
      console.log('[loader] cancelamento solicitado — interrompendo fetchEndpoint');
      throw Object.assign(new Error('Carga cancelada pelo usuário'), { cancelled: true });
    }

    state.phase = 'fetching';
    const batch = await fetchPage(token, endpoint, filter, skip, pageSize);
    if (!batch.length) break;

    state.phase = 'saving';
    // onBatch retorna os tickets que de fato foram salvos (pode ser um
    // subconjunto do lote buscado, quando a classificação descarta alguns —
    // ver makeSaveComClassificacao). Usamos um Set de ids pro contador
    // refletir tickets ÚNICOS salvos, não o bruto buscado — o mesmo ticket
    // pode aparecer em /tickets E /tickets/past pro mesmo período.
    const salvos = (await onBatch(batch)) || batch;
    for (const t of salvos) state.savedIds.add(String(t.id));

    state.pagesDone++;
    state.ticketsDone = state.savedIds.size;
    total += batch.length;

    if (batch.length < pageSize) break;
    skip += pageSize;
    await sleep(150); // cortesia de rate-limit
  }
  return total;
}

// ── Garantir tabelas / colunas ────────────────────────────────────────────────
// Roda tudo numa ÚNICA conexão dedicada com lock_timeout curto: DDL (CREATE/ALTER
// TABLE) exige lock ACCESS EXCLUSIVE, que briga com autovacuum (SHARE UPDATE
// EXCLUSIVE) rodando nas mesmas tabelas. Cada statement roda isolado — se um não
// conseguir o lock a tempo, pulamos e seguimos (a tabela/coluna já deve existir
// na maioria dos casos).
//
// Só roda de fato na PRIMEIRA chamada do processo — ALTER TABLE ADD COLUMN IF
// NOT EXISTS é idempotente, então repetir a cada carga (a cada 2h) só gera
// disputa de lock com autovacuum sem necessidade nenhuma depois que as colunas
// já existem.
let _tablesEnsured = false;
async function ensureTables() {
  if (_tablesEnsured) return;
  const statements = [
    ['schema silver', 'CREATE SCHEMA IF NOT EXISTS silver'],
    ['silver.ticket (create)', `
      CREATE TABLE IF NOT EXISTS silver.ticket (
        ticket_id          varchar(20) PRIMARY KEY,
        subject            text,
        status             text,
        basestatus         text,
        createddate        timestamptz,
        ownerteam          text,
        clientorganization text
      )
    `],
    ...[
      'ownerteam text', 'last_update timestamptz', 'owner_id varchar(50)',
      'owner_name text', 'urgency text', 'category text', 'service_full text',
      'resolved_in timestamptz', 'closed_in timestamptz', 'stopped_time float',
      'stopped_time_wt float', 'sla_response_date timestamptz', 'extracted_at timestamptz',
      'sla_solution_date timestamptz',
      'reopened_in timestamptz',
    ].map(col => {
      const [name] = col.split(' ');
      return [`silver.ticket.${name}`, `ALTER TABLE silver.ticket ADD COLUMN IF NOT EXISTS ${name} ${col.slice(name.length + 1)}`];
    }),
    ['silver.ticket._bronze_extracted_at default', `ALTER TABLE silver.ticket ALTER COLUMN _bronze_extracted_at SET DEFAULT NOW()`],
    // Confirmado: silver.ticket já tem PRIMARY KEY (ticket_id) — não precisa adicionar.
    ['silver.ticket_acao (create)', `
      CREATE TABLE IF NOT EXISTS silver.ticket_acao (
        acao_id         bigint PRIMARY KEY,
        ticket_id       bigint NOT NULL,
        tipo            int,
        descricao       text,
        is_public       boolean,
        status          text,
        criado_em       timestamptz,
        criado_por_id   text,
        criado_por_nome text,
        extracted_at    timestamptz DEFAULT NOW()
      )
    `],
    ['silver.ticket_acao.criado_por_id', `ALTER TABLE silver.ticket_acao ADD COLUMN IF NOT EXISTS criado_por_id text`],
    ['silver.ticket_acao.criado_por_nome', `ALTER TABLE silver.ticket_acao ADD COLUMN IF NOT EXISTS criado_por_nome text`],
    ['silver.ticket_acao.is_public', `ALTER TABLE silver.ticket_acao ADD COLUMN IF NOT EXISTS is_public boolean`],
    ['silver.ticket_acao.extracted_at', `ALTER TABLE silver.ticket_acao ADD COLUMN IF NOT EXISTS extracted_at timestamptz DEFAULT NOW()`],
    // Confirmado: PK de silver.ticket_acao é composta — PRIMARY KEY (ticket_id, acao_id) —
    // não só acao_id. O INSERT usa ON CONFLICT (ticket_id, acao_id) abaixo por causa disso.
    ['silver.ticket_campo_customizado (create)', `
      CREATE TABLE IF NOT EXISTS silver.ticket_campo_customizado (
        ticket_id        bigint NOT NULL,
        custom_field_id  bigint NOT NULL,
        valor_texto      text,
        items_json       text,
        extracted_at     timestamptz DEFAULT NOW()
      )
    `],
    ['silver.ticket_campo_customizado.items_json', `ALTER TABLE silver.ticket_campo_customizado ADD COLUMN IF NOT EXISTS items_json text`],
    ['silver.ticket_campo_customizado.extracted_at', `ALTER TABLE silver.ticket_campo_customizado ADD COLUMN IF NOT EXISTS extracted_at timestamptz DEFAULT NOW()`],
    ['silver.ticket_campo_customizado idx', `CREATE INDEX IF NOT EXISTS idx_ticket_cf_ticket_id ON silver.ticket_campo_customizado(ticket_id)`],
    ['silver.ticket_cliente (create)', `
      CREATE TABLE IF NOT EXISTS silver.ticket_cliente (
        ticket_id        bigint NOT NULL,
        cliente_id       text,
        nome             text,
        email            text,
        organizacao_id   text,
        organizacao_nome text,
        extracted_at     timestamptz DEFAULT NOW()
      )
    `],
    ['silver.ticket_cliente.extracted_at', `ALTER TABLE silver.ticket_cliente ADD COLUMN IF NOT EXISTS extracted_at timestamptz DEFAULT NOW()`],
    ['silver.ticket_cliente.profile_type', `ALTER TABLE silver.ticket_cliente ADD COLUMN IF NOT EXISTS profile_type text`],
    ['silver.carga_log (create)', `
      CREATE TABLE IF NOT EXISTS silver.carga_log (
        id           serial PRIMARY KEY,
        mode         varchar(20) NOT NULL,
        started_at   timestamptz NOT NULL,
        finished_at  timestamptz,
        tickets_loaded int DEFAULT 0,
        status       varchar(20) DEFAULT 'running',
        error_msg    text
      )
    `],
    ['silver.carga_log.years', `ALTER TABLE silver.carga_log ADD COLUMN IF NOT EXISTS years int[]`],
    ['silver.carga_log.classification', `ALTER TABLE silver.carga_log ADD COLUMN IF NOT EXISTS classification text`],
    ['silver.carga_log.owner_team', `ALTER TABLE silver.carga_log ADD COLUMN IF NOT EXISTS owner_team text`],
    // Pesquisa de satisfação (satisfactionSurveyResponses, modelo "smiley
    // faces" 1-5) — antes vivia só num banco à parte (movidesk_curadoria),
    // buscada ticket a ticket direto na API. Migrado pro datalake pra cobrir
    // TODOS os tickets da empresa, não só o escopo da Curadoria — ver
    // runSatisfacaoSync().
    ['silver.ticket_satisfacao (create)', `
      CREATE TABLE IF NOT EXISTS silver.ticket_satisfacao (
        ticket_id     bigint PRIMARY KEY,
        nota          smallint,
        comentario    text,
        respondido_em timestamptz,
        verificado_em timestamptz NOT NULL DEFAULT NOW()
      )
    `],
    // silver.ticket.ticket_id é bigint na base real (o CREATE TABLE IF NOT
    // EXISTS de silver.ticket acima nunca roda de fato — a tabela já existe
    // de antes com esse tipo). A criação de silver.ticket_satisfacao logo
    // acima já nasce como bigint agora, mas essa ALTER corrige quem já
    // rodou uma vez com o tipo errado (varchar) antes desse ajuste — sem
    // ela, o JOIN entre as duas tabelas quebra com "operator does not
    // exist: character varying = bigint".
    ['silver.ticket_satisfacao.ticket_id type fix', `ALTER TABLE silver.ticket_satisfacao ALTER COLUMN ticket_id TYPE bigint USING ticket_id::bigint`],
  ];

  await db.withClient(async (client) => {
    await client.query(`SET lock_timeout = '5s'`).catch(() => {});
    try {
      for (const [label, sql] of statements) {
        try {
          await client.query(sql);
        } catch (e) {
          console.warn(`[loader] ensureTables — pulando "${label}" (${e.code || ''}): ${e.message}`);
        }
      }
    } finally {
      // Essencial: sem isso, o pool reaproveita esta conexão em queries futuras
      // completamente diferentes, que herdariam esse lock_timeout de 5s e
      // falhariam por timeout mesmo sem disputa real de lock.
      await client.query(`RESET lock_timeout`).catch(() => {});
    }
  });
  _tablesEnsured = true;
}

// ── Persistir um lote de tickets ──────────────────────────────────────────────
async function saveBatch(tickets) {
  if (!tickets.length) return [];

  // Dedup por ticket_id: se o mesmo ticket vier duplicado na mesma página
  // (paginação da API sem $orderby explícito pode repetir/pular linhas),
  // o INSERT com ON CONFLICT (ticket_id) DO UPDATE quebra com "command
  // cannot affect row a second time" ao tentar resolver o conflito duas
  // vezes na mesma instrução. Mantemos a última ocorrência de cada id.
  const porId = new Map();
  for (const t of tickets) porId.set(String(t.id), t);
  tickets = [...porId.values()];

  // ── 1. silver.ticket (upsert) ──
  const ids         = tickets.map(t => String(t.id));
  const subjects    = tickets.map(t => t.subject    || null);
  const statuses    = tickets.map(t => t.status     || null);
  const baseStats   = tickets.map(t => t.baseStatus || null);
  const createdDts  = tickets.map(t => t.createdDate || null);
  const lastUpdates = tickets.map(t => t.lastUpdate || null);
  const ownerTeams  = tickets.map(t => t.ownerTeam  || null);
  const ownerIds    = tickets.map(t => t.owner?.id ? String(t.owner.id) : null);
  const ownerNames  = tickets.map(t => t.owner?.businessName || null);
  const urgencies   = tickets.map(t => t.urgency    || null);
  const categories  = tickets.map(t => t.category   || null);
  const services    = tickets.map(t => Array.isArray(t.serviceFull) ? t.serviceFull.join(' > ') : (t.serviceFull || null));
  const resolvedIns = tickets.map(t => t.resolvedIn || null);
  const closedIns   = tickets.map(t => t.closedIn   || null);
  const stoppedTs   = tickets.map(t => t.stoppedTimeWorkingTime != null ? String(t.stoppedTimeWorkingTime) : null);
  const stoppedCs   = tickets.map(t => t.stoppedTime != null ? String(t.stoppedTime) : null);
  const slaRespDs   = tickets.map(t => t.slaRealResponseDate || null);
  const slaSolDs    = tickets.map(t => t.slaSolutionDate     || null);
  const reopenedIns = tickets.map(t => t.reopenedIn || null);
  // clientorganization — pega a organização da primeira org dos clients.
  // Não cai pro nome do contato (c.businessName) quando não há organização:
  // isso fazia o "Top clientes" mostrar nome de pessoa em vez de empresa.
  const clientOrgs  = tickets.map(t => {
    const c = Array.isArray(t.clients) ? t.clients[0] : null;
    return c?.organization?.businessName || null;
  });

  await comLockRetry(client => client.query(`
    INSERT INTO silver.ticket
      (ticket_id, subject, status, basestatus, createddate,
       last_update, ownerteam, owner_id, owner_name,
       urgency, category, service_full,
       resolved_in, closed_in, stopped_time_wt, stopped_time,
       sla_response_date, clientorganization, sla_solution_date, reopened_in, extracted_at)
    SELECT
      u.ticket_id::bigint, u.subject, u.status, u.basestatus, u.createddate::timestamptz,
      u.last_update::timestamptz, u.ownerteam, u.owner_id, u.owner_name,
      u.urgency, u.category, u.service_full,
      u.resolved_in::timestamptz, u.closed_in::timestamptz,
      u.stopped_time_wt::float, u.stopped_time::float,
      u.sla_response_date::timestamptz, u.clientorganization, u.sla_solution_date::timestamptz,
      u.reopened_in::timestamptz, NOW()
    FROM unnest(
      $1::varchar[],  $2::text[],  $3::text[],  $4::text[],  $5::text[],
      $6::text[],     $7::text[],  $8::text[],  $9::text[],
      $10::text[],    $11::text[], $12::text[],
      $13::text[],    $14::text[], $15::text[],  $16::text[],
      $17::text[],    $18::text[], $19::text[],  $20::text[]
    ) AS u(
      ticket_id, subject, status, basestatus, createddate,
      last_update, ownerteam, owner_id, owner_name,
      urgency, category, service_full,
      resolved_in, closed_in, stopped_time_wt, stopped_time,
      sla_response_date, clientorganization, sla_solution_date, reopened_in
    )
    ON CONFLICT (ticket_id) DO UPDATE SET
      subject           = EXCLUDED.subject,
      status            = EXCLUDED.status,
      basestatus        = EXCLUDED.basestatus,
      last_update       = EXCLUDED.last_update,
      ownerteam         = EXCLUDED.ownerteam,
      owner_id          = EXCLUDED.owner_id,
      owner_name        = EXCLUDED.owner_name,
      urgency           = EXCLUDED.urgency,
      category          = EXCLUDED.category,
      service_full      = EXCLUDED.service_full,
      resolved_in       = EXCLUDED.resolved_in,
      closed_in         = EXCLUDED.closed_in,
      stopped_time_wt   = EXCLUDED.stopped_time_wt,
      stopped_time      = EXCLUDED.stopped_time,
      sla_response_date = EXCLUDED.sla_response_date,
      clientorganization = EXCLUDED.clientorganization,
      sla_solution_date = EXCLUDED.sla_solution_date,
      reopened_in       = EXCLUDED.reopened_in,
      extracted_at      = EXCLUDED.extracted_at
  `, [ids, subjects, statuses, baseStats, createdDts,
      lastUpdates, ownerTeams, ownerIds, ownerNames,
      urgencies, categories, services,
      resolvedIns, closedIns, stoppedTs, stoppedCs,
      slaRespDs, clientOrgs, slaSolDs, reopenedIns]));

  // ── 2. silver.ticket_acao ──
  // Dedup por (ticket_id, acao_id) — mesmo motivo do dedup de tickets acima:
  // se a API devolver uma ação repetida dentro do array actions[] de um
  // ticket (visto em tickets antigos/fechados, com histórico de ações bem
  // maior), o INSERT com ON CONFLICT (ticket_id, acao_id) quebra do mesmo
  // jeito. Mantemos a última ocorrência de cada par.
  const actionRowsPorChave = new Map();
  for (const t of tickets) {
    if (!Array.isArray(t.actions)) continue;
    for (const a of t.actions) {
      if (!a.id) continue;
      actionRowsPorChave.set(`${t.id}:${a.id}`, {
        acao_id:        String(a.id),
        ticket_id:      String(t.id),
        tipo:           a.type != null ? String(a.type) : null,
        descricao:      a.description ? a.description.slice(0, 500000) : null,
        is_public:      a.isPublic != null ? (a.isPublic ? 'true' : 'false') : null,
        status:         a.status || null,
        criado_em:      a.createdDate || null,
        criado_por_id:  a.createdBy?.id ? String(a.createdBy.id) : null,
        criado_por_nome: a.createdBy?.businessName || null,
      });
    }
  }
  const actionRows = [...actionRowsPorChave.values()];
  if (actionRows.length) {
    await comLockRetry(client => client.query(`
      INSERT INTO silver.ticket_acao
        (acao_id, ticket_id, tipo, descricao, is_public, status, criado_em,
         criado_por_id, criado_por_nome, extracted_at)
      SELECT
        u.acao_id::bigint, u.ticket_id::bigint, u.tipo::int, u.descricao,
        u.is_public::boolean, u.status, COALESCE(u.criado_em::timestamptz, NOW()),
        u.criado_por_id, u.criado_por_nome, NOW()
      FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[],
        $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
      ) AS u(acao_id, ticket_id, tipo, descricao, is_public, status, criado_em,
             criado_por_id, criado_por_nome)
      ON CONFLICT (ticket_id, acao_id) DO UPDATE SET
        descricao      = EXCLUDED.descricao,
        is_public      = EXCLUDED.is_public,
        status         = EXCLUDED.status,
        criado_em      = EXCLUDED.criado_em,
        criado_por_id  = EXCLUDED.criado_por_id,
        criado_por_nome = EXCLUDED.criado_por_nome,
        extracted_at   = EXCLUDED.extracted_at
    `, [
      actionRows.map(r => r.acao_id),
      actionRows.map(r => r.ticket_id),
      actionRows.map(r => r.tipo),
      actionRows.map(r => r.descricao),
      actionRows.map(r => r.is_public),
      actionRows.map(r => r.status),
      actionRows.map(r => r.criado_em),
      actionRows.map(r => r.criado_por_id),
      actionRows.map(r => r.criado_por_nome),
    ]));
  }

  // ── 3. silver.ticket_campo_customizado ──
  let cfRows = [];
  for (const t of tickets) {
    if (!Array.isArray(t.customFieldValues)) continue;
    for (const cf of t.customFieldValues) {
      if (cf.customFieldId == null) continue;
      // valor: string simples ou items (lista)
      let valorTexto = null;
      let itemsJson  = null;
      if (Array.isArray(cf.items) && cf.items.length) {
        const vals = cf.items.map(it => it.customFieldItem ?? it.value ?? it.text ?? '').filter(Boolean);
        valorTexto = vals.join(', ');
        itemsJson  = JSON.stringify(cf.items);
      } else if (cf.value !== undefined && cf.value !== null && cf.value !== '') {
        valorTexto = String(cf.value);
      }
      cfRows.push({
        ticket_id:            String(t.id),
        custom_field_id:      String(cf.customFieldId),
        custom_field_rule_id: cf.customFieldRuleId != null ? String(cf.customFieldRuleId) : null,
        valor_texto:          valorTexto,
        items_json:           itemsJson,
      });
    }
  }
  // A API às vezes devolve o mesmo customFieldId mais de uma vez pro mesmo
  // ticket (ex: variações por customFieldRuleId, que essa tabela nem grava) —
  // e silver.ticket_campo_customizado TEM unique constraint em
  // (ticket_id, custom_field_id) na produção (apesar do comentário abaixo
  // sobre o schema do extractor Java), então duplicatas quebram o INSERT em
  // lote com "duplicate key value violates ... ticket_campo_customizado_pk".
  // Dedupe mantendo a última ocorrência (prioriza item mais recente no array).
  cfRows = [...new Map(cfRows.map(r => [`${r.ticket_id}::${r.custom_field_id}`, r])).values()];
  if (cfRows.length) {
    // Sem unique constraint em (ticket_id, custom_field_id) no schema do extractor Java
    // (permite múltiplas linhas via item_ordem) — usa DELETE + INSERT por ticket.
    // DELETE e INSERT rodam na MESMA transação: se o INSERT falhar, o DELETE é
    // desfeito também — sem isso, um erro no meio deixava tickets sem nenhuma linha
    // de classificação (sumindo da Ouvidoria mesmo continuando em silver.ticket).
    const cfTicketIds = [...new Set(cfRows.map(r => r.ticket_id))];
    await comLockRetry(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `DELETE FROM silver.ticket_campo_customizado WHERE ticket_id = ANY($1::bigint[])`,
          [cfTicketIds]
        );
        await client.query(`
          INSERT INTO silver.ticket_campo_customizado
            (ticket_id, custom_field_id, valor_texto, items_json, extracted_at)
          SELECT
            u.ticket_id::bigint, u.custom_field_id::bigint,
            u.valor_texto, u.items_json, NOW()
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[]
          ) AS u(ticket_id, custom_field_id, valor_texto, items_json)
        `, [
          cfRows.map(r => r.ticket_id),
          cfRows.map(r => r.custom_field_id),
          cfRows.map(r => r.valor_texto),
          cfRows.map(r => r.items_json),
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }

  // ── 4. silver.ticket_cliente ── (schema Java: ticket_id, cliente_id, nome, email, organizacao_id, organizacao_nome)
  const cliRows = [];
  for (const t of tickets) {
    if (!Array.isArray(t.clients)) continue;
    for (const c of t.clients) {
      // Nem sempre a organização vem aninhada em c.organization — em tickets
      // como o #876730, a empresa aparece como um client PRÓPRIO dentro de
      // clients[] (personType 2 = pessoa jurídica), com organization:null
      // nela mesma. Sem esse fallback, nem o contato pessoa física nem o
      // registro da empresa ficavam com organizacao_id/nome preenchidos, e o
      // ticket caía em "Não informado" mesmo tendo organização clara no
      // Movidesk.
      const orgId   = c.organization?.id ? String(c.organization.id)
                     : (c.personType === 2 && c.id ? String(c.id) : null);
      const orgNome = c.organization?.businessName
                     || (c.personType === 2 ? c.businessName : null)
                     || null;
      cliRows.push({
        ticket_id:        String(t.id),
        cliente_id:       c.id ? String(c.id) : null,
        nome:             c.businessName || null,
        email:            c.email || null,
        organizacao_id:   orgId,
        organizacao_nome: orgNome,
        // profileType — um ticket pode ter mais de um "client" (o contato
        // externo de verdade E o próprio agente interno da Viasoft que
        // criou/atua no ticket). profileType=3 é o padrão do Movidesk pra
        // agente interno — guardamos pra poder priorizar o contato externo
        // na hora de escolher a organização do cliente (ver rotas
        // ouvidoria.js/gcc.js).
        profile_type:     c.profileType != null ? String(c.profileType) : null,
      });
    }
  }
  if (cliRows.length) {
    // Sem unique constraint confiável no schema do extractor Java — DELETE + INSERT
    // por ticket, na mesma transação (mesmo motivo do bloco acima).
    const cliTicketIds = [...new Set(cliRows.map(r => r.ticket_id))];
    await comLockRetry(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `DELETE FROM silver.ticket_cliente WHERE ticket_id = ANY($1::bigint[])`,
          [cliTicketIds]
        );
        await client.query(`
          INSERT INTO silver.ticket_cliente
            (ticket_id, cliente_id, nome, email, organizacao_id, organizacao_nome, profile_type, extracted_at)
          SELECT
            u.ticket_id::bigint, NULLIF(u.cliente_id, ''), u.nome, u.email,
            NULLIF(u.organizacao_id, ''), u.organizacao_nome, u.profile_type, NOW()
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
          ) AS u(ticket_id, cliente_id, nome, email, organizacao_id, organizacao_nome, profile_type)
        `, [
          cliRows.map(r => r.ticket_id),
          cliRows.map(r => r.cliente_id),
          cliRows.map(r => r.nome),
          cliRows.map(r => r.email),
          cliRows.map(r => r.organizacao_id),
          cliRows.map(r => r.organizacao_nome),
          cliRows.map(r => r.profile_type),
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }

  return tickets;
}

// ── Lógica de carga ───────────────────────────────────────────────────────────

/**
 * Carga COMPLETA — todos os tickets de todos os tempos.
 * Chama /tickets e /tickets/past sem filtro de data (ou filtrado por anos).
 * Ideal para rodar semanal (sábados madrugada) ou manualmente por ano.
 *
 * @param {object} [options]
 * @param {number[]} [options.years] - Anos a carregar. Vazio = todos os anos.
 * @param {string} [options.classification] - Filtra pelo campo "Classificação de
 *   Ticket" (CF 23946). Vazio = todas as classificações.
 * @param {string} [options.ownerTeam] - Filtra direto pelo campo "Equipe"
 *   (ownerTeam) da API — mais barato pra API do que o filtro por Classificação.
 *   Tem prioridade sobre o mapeamento fixo de CLASS_TO_OWNER_TEAM. Vazio = usa
 *   o mapeamento (se a classificação informada tiver uma equipe conhecida).
 */
async function runFull({ years = [], classification = '', ownerTeam = '' } = {}) {
  if (state.running) throw new Error('Já existe uma carga em andamento');

  const sortedYears = [...years].map(Number).filter(y => y > 2000 && y <= new Date().getFullYear()).sort();
  const modeLabel   = sortedYears.length ? 'full-anos' : 'full';
  const classValue     = String(classification || '').trim();
  const ownerTeamInput = String(ownerTeam || '').trim();
  // ownerTeam explícito (campo da UI) tem prioridade sobre o mapeamento fixo
  // (CLASS_TO_OWNER_TEAM) — permite testar/usar qualquer equipe sem precisar
  // mexer no código, inclusive combinado com uma Classificação de Ticket (que
  // nesse caso só serve pra conferir/corrigir o campo depois de buscar, não
  // pro filtro da API). Escapa aspas simples pro filtro OData ('' = ' literal).
  const ownerTeamVal = ownerTeamInput || CLASS_TO_OWNER_TEAM[classValue] || '';
  const classFilter  = ownerTeamVal
    ? `ownerTeam eq '${ownerTeamVal.replace(/'/g, "''")}'`
    : (classValue
        ? `customFieldValues/any(cf: cf/customFieldId eq ${CF_CLASSIFICACAO}` +
          ` and cf/items/any(item: item/customFieldItem eq '${classValue.replace(/'/g, "''")}'))`
        : null);
  const classPageSize = ownerTeamVal ? PAGE_SIZE : CLASS_FILTER_PAGE_SIZE;
  // Classificação efetiva usada pro patch de canonicalização (ver
  // makeSaveComClassificacao) — se o usuário só preencheu Equipe e essa
  // equipe corresponde a uma classificação conhecida, usamos ela mesmo sem
  // o campo Classificação preenchido. Sem isso, os tickets ficam salvos em
  // silver.ticket mas somem das telas de Ouvidoria/GCC (que filtram pela
  // classificação, não pela equipe).
  const classValueEfetivo = classValue || (ownerTeamVal ? OWNER_TEAM_TO_CLASS[ownerTeamVal] : '') || '';

  // marca como running ANTES de qualquer await para que /status reflita imediatamente
  state.running          = true;
  state.cancelRequested  = false;
  state.mode             = modeLabel;
  state.startedAt        = new Date().toISOString();
  state.phase            = 'preparando';
  state.pagesDone        = 0;
  state.ticketsDone      = 0;
  state.savedIds         = new Set();
  state.errors           = [];
  state.years            = sortedYears;
  state.currentYear      = null;
  state.yearsTotal       = sortedYears.length;
  state.yearsDone        = 0;

  console.log('[loader] ensureTables...');
  await ensureTables();
  console.log('[loader] ensureTables OK');

  // Limpa registros "running" anteriores que ficaram travados (crash/restart)
  await db.query(
    `UPDATE silver.carga_log SET status='error', error_msg='Interrompido (reinício do servidor)', finished_at=NOW() WHERE status='running'`
  ).catch(() => {});
  console.log('[loader] carga_log cleanup OK');

  const logRow = await db.query(
    `INSERT INTO silver.carga_log (mode, started_at, status, years, classification, owner_team)
     VALUES ($1, NOW(), 'running', $2, $3, $4) RETURNING id`,
    [modeLabel, sortedYears.length ? sortedYears : null, classValueEfetivo || null, ownerTeamVal || null]
  ).catch(() => ({ rows: [{ id: null }] }));
  const logId = logRow.rows?.[0]?.id;
  console.log('[loader] carga_log insert OK, id:', logId);

  const yearsDesc = sortedYears.length ? `anos: ${sortedYears.join(', ')}` : 'todos os anos';
  console.log(`[loader] ▶ Carga FULL iniciada — ${yearsDesc}`);

  try {
    const token = await getMovideskToken();
    console.log(`[loader] token carregado: ...${token.slice(-6)} (últimos 6 chars)`);

    // Mesmo bug de sempre: QUALQUER $filter (classificação, ou só o filtro de
    // data por ano) + $expand=customFieldValues quebra os campos customizados
    // (ver corrigirCustomFieldValues). Sem filtro nenhum (full sem ano nem
    // classificação) os dados já vêm certos — nesse caso não vale a pena o
    // custo de 1 chamada extra por ticket em cima de todo o histórico.
    const usaFiltro = sortedYears.length > 0 || !!classFilter;
    // Canonicaliza a classificação (força CF 23946) só quando o usuário
    // preencheu "Classificação de Ticket" explicitamente — é uma intenção
    // clara de "estes tickets SÃO dessa classificação". Quando só a Equipe é
    // selecionada, salva os tickets como estão de verdade (sem forçar nada):
    // a Equipe é só um filtro de busca mais barato pra API, não uma garantia
    // de que todo ticket dessa equipe tem essa classificação — forçar isso
    // sobrescrevia a classificação real de tickets que só passam pela equipe
    // mas já foram reclassificados pra outra coisa (ex: #874687, ownerTeam
    // "Ouvidoria" mas classificação real "Visitas a Clientes").
    const baseSave = classValue ? makeSaveComClassificacao(classValue) : saveBatch;
    const saveWithClassPatch = usaFiltro
      ? async (batch) => { await corrigirCustomFieldValues(token, batch); return baseSave(batch); }
      : baseSave;

    if (sortedYears.length) {
      // ── Carga por ano selecionado ──────────────────────────────────────────
      for (const year of sortedYears) {
        state.currentYear = year;
        // Inclui jan do ano seguinte no filtro para pegar horários de fuseau diferente
        const from = `${year}-01-01T00:00:00Z`;
        const to   = `${year}-12-31T23:59:59Z`;
        const dateFilter = `createdDate ge ${from} and createdDate le ${to}`;
        const filterStr = classFilter ? `${dateFilter} and ${classFilter}` : dateFilter;

        console.log(`[loader]   ── Ano ${year}${classValueEfetivo ? ` — classificação "${classValueEfetivo}"` : ''} ──`);
        for (const ep of ['/tickets', '/tickets/past']) {
          console.log(`[loader]     endpoint ${ep}`);
          await fetchEndpoint(token, ep, filterStr, saveWithClassPatch, classFilter ? classPageSize : PAGE_SIZE);
        }
        state.yearsDone++;
        console.log(`[loader]   ✓ Ano ${year} concluído — ${state.ticketsDone} tickets acumulados`);
      }
      state.currentYear = null;
    } else {
      // ── Carga total (filtrada só por classificação, ou sem filtro nenhum) ───
      console.log(`[loader]   ${classValueEfetivo ? `classificação "${classValueEfetivo}"` : 'sem filtro de data ou classificação'}`);
      for (const ep of ['/tickets', '/tickets/past']) {
        console.log(`[loader]   endpoint ${ep}`);
        await fetchEndpoint(token, ep, classFilter, saveWithClassPatch, classFilter ? classPageSize : PAGE_SIZE);
      }
    }

    state.phase     = 'idle';
    state.running   = false;
    state.lastFinish = new Date().toISOString();
    state.lastResult = { mode: modeLabel, tickets: state.ticketsDone, years: sortedYears };

    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), tickets_loaded=$1, status='done' WHERE id=$2`,
        [state.ticketsDone, logId]
      ).catch(() => {});
    }
    console.log(`[loader] ✔ Carga FULL concluída — ${state.ticketsDone} tickets`);
    return state.lastResult;
  } catch (err) {
    state.running          = false;
    state.phase            = 'idle';
    state.currentYear      = null;
    state.cancelRequested  = false;
    const wasCancelled = err.cancelled === true;
    if (!wasCancelled) state.errors.push(err.message);
    const logStatus = wasCancelled ? 'cancelled' : 'error';
    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), status=$1, error_msg=$2 WHERE id=$3`,
        [logStatus, wasCancelled ? 'Cancelado pelo usuário' : err.message, logId]
      ).catch(() => {});
    }
    if (wasCancelled) {
      console.log(`[loader] ⏹ Carga FULL cancelada — ${state.ticketsDone} tickets salvos`);
      state.lastResult = { mode: modeLabel, tickets: state.ticketsDone, cancelled: true };
    } else {
      console.error('[loader] ✖ Carga FULL com erro:', err.message);
      throw err;
    }
  }
}

/**
 * Carga INCREMENTAL — tickets em aberto + atualizados nas últimas 24h.
 *
 * Estratégia dupla:
 *   1. lastUpdate nas últimas 24h (qualquer status) — captura mudanças recentes
 *   2. baseStatus aberto sem filtro de data — garante que todos os abertos estão frescos
 *
 * Ideal para rodar diariamente (05h).
 */
async function runIncremental() {
  if (state.running) throw new Error('Já existe uma carga em andamento');

  state.running         = true;
  state.cancelRequested = false;
  state.mode            = 'incremental';
  state.startedAt       = new Date().toISOString();
  state.phase           = 'preparando';
  state.pagesDone       = 0;
  state.ticketsDone     = 0;
  state.savedIds        = new Set();
  state.errors          = [];

  console.log('[loader] ensureTables...');
  await ensureTables();
  console.log('[loader] ensureTables OK');

  // Limpa registros "running" anteriores que ficaram travados (crash/restart)
  await db.query(
    `UPDATE silver.carga_log SET status='error', error_msg='Interrompido (reinício do servidor)', finished_at=NOW() WHERE status='running'`
  ).catch(() => {});
  console.log('[loader] carga_log cleanup OK');

  const logRow = await db.query(
    `INSERT INTO silver.carga_log (mode, started_at, status) VALUES ('incremental', NOW(), 'running') RETURNING id`
  ).catch(() => ({ rows: [{ id: null }] }));
  const logId = logRow.rows?.[0]?.id;
  console.log('[loader] carga_log insert OK, id:', logId);

  console.log('[loader] ▶ Carga INCREMENTAL iniciada');

  try {
    const token = await getMovideskToken();
    console.log(`[loader] token carregado: ...${token.slice(-6)} (últimos 6 chars)`);

    // Filtro 1 — atualizados nas últimas 25h (margem de 1h)
    const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const filterRecent = `lastUpdate ge ${since}`;

    // Filtro 2 — atualmente em aberto (sem filtro de data)
    const closedExclusion = CLOSED_STATUSES
      .map(s => `baseStatus ne '${s}'`)
      .join(' and ');

    const seen = new Set(); // dedup por ticket_id entre as duas passagens

    const dedupSave = async (batch) => {
      const fresh = batch.filter(t => !seen.has(String(t.id)));
      fresh.forEach(t => seen.add(String(t.id)));
      if (fresh.length) await saveBatch(fresh);
      return fresh;
    };

    for (const ep of ['/tickets', '/tickets/past']) {
      console.log(`[loader]   ${ep} — atualizados recentemente`);
      await fetchEndpoint(token, ep, filterRecent, dedupSave);

      console.log(`[loader]   ${ep} — em aberto (todos)`);
      await fetchEndpoint(token, ep, closedExclusion, dedupSave);
    }

    state.phase      = 'idle';
    state.running    = false;
    state.lastFinish = new Date().toISOString();
    state.lastResult = { mode: 'incremental', tickets: state.ticketsDone };

    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), tickets_loaded=$1, status='done' WHERE id=$2`,
        [state.ticketsDone, logId]
      ).catch(() => {});
    }
    console.log(`[loader] ✔ Carga INCREMENTAL concluída — ${state.ticketsDone} tickets`);
    return state.lastResult;
  } catch (err) {
    state.running         = false;
    state.phase           = 'idle';
    state.cancelRequested = false;
    const wasCancelled = err.cancelled === true;
    if (!wasCancelled) state.errors.push(err.message);
    const logStatus = wasCancelled ? 'cancelled' : 'error';
    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), status=$1, error_msg=$2 WHERE id=$3`,
        [logStatus, wasCancelled ? 'Cancelado pelo usuário' : err.message, logId]
      ).catch(() => {});
    }
    if (wasCancelled) {
      console.log(`[loader] ⏹ Carga INCREMENTAL cancelada — ${state.ticketsDone} tickets salvos`);
      state.lastResult = { mode: 'incremental', tickets: state.ticketsDone, cancelled: true };
    } else {
      console.error('[loader] ✖ Carga INCREMENTAL com erro:', err.message);
      throw err;
    }
  }
}

/**
 * Carga OUVIDORIA — busca apenas tickets classificados como "Ouvidoria"
 * (campo personalizado 23946 "Classificação de Ticket") e grava em silver.*.
 * Mais leve que a incremental completa: filtra na própria API do Movidesk,
 * então não precisa varrer todos os tickets em aberto. Ideal para rodar a
 * cada 2h.
 */
/**
 * Carga por CLASSIFICAÇÃO — busca apenas tickets em aberto cuja "Classificação
 * de Ticket" (CF 23946) seja `classValue`, e grava em silver.*. Base genérica
 * usada por runOuvidoria() e runGcc().
 *
 * @param {string} mode - rótulo curto pra state.mode / silver.carga_log (ex: 'ouvidoria', 'gcc')
 * @param {string} classValue - valor exato do CF 23946 a filtrar (ex: 'Ouvidoria')
 */
async function runByClassification(mode, classValue) {
  if (state.running) throw new Error('Já existe uma carga em andamento');

  const modeUpper = mode.toUpperCase();

  state.running         = true;
  state.cancelRequested = false;
  state.mode            = mode;
  state.startedAt       = new Date().toISOString();
  state.phase           = 'preparando';
  state.pagesDone       = 0;
  state.ticketsDone     = 0;
  state.savedIds        = new Set();
  state.errors          = [];

  console.log('[loader] ensureTables...');
  await ensureTables();
  console.log('[loader] ensureTables OK');

  await db.query(
    `UPDATE silver.carga_log SET status='error', error_msg='Interrompido (reinício do servidor)', finished_at=NOW() WHERE status='running'`
  ).catch(() => {});

  const logRow = await db.query(
    `INSERT INTO silver.carga_log (mode, started_at, status) VALUES ($1, NOW(), 'running') RETURNING id`,
    [mode]
  ).catch(() => ({ rows: [{ id: null }] }));
  const logId = logRow.rows?.[0]?.id;

  console.log(`[loader] ▶ Carga ${modeUpper} iniciada`);

  try {
    const token = await getMovideskToken();
    console.log(`[loader] token carregado: ...${token.slice(-6)} (últimos 6 chars)`);

    // Quando a classificação tem ownerTeam mapeado (ver CLASS_TO_OWNER_TEAM),
    // filtramos por esse campo plano — bem mais barato pra API do que o filtro
    // aninhado customFieldValues/any(...), permitindo $top normal (PAGE_SIZE).
    // Sem ownerTeam mapeado, cai no filtro aninhado com $top reduzido
    // (CLASS_FILTER_PAGE_SIZE), mais custoso pra API processar junto com $expand.
    const ownerTeamVal = CLASS_TO_OWNER_TEAM[classValue];
    const closedExclusion = CLOSED_STATUSES.map(s => `baseStatus ne '${s}'`).join(' and ');
    const classFilter = ownerTeamVal
      ? `ownerTeam eq '${ownerTeamVal.replace(/'/g, "''")}'`
      : `customFieldValues/any(cf: cf/customFieldId eq ${CF_CLASSIFICACAO}` +
        ` and cf/items/any(item: item/customFieldItem eq '${classValue.replace(/'/g, "''")}'))`;
    const idFilter = `${classFilter} and ${closedExclusion}`;
    const pageSize = ownerTeamVal ? PAGE_SIZE : CLASS_FILTER_PAGE_SIZE;

    // Poucos tickets nessa carga (em aberto só) — vale a pena a chamada extra
    // por ticket pra corrigir os campos customizados quebrados pelo bug do
    // $filter+$expand (ver corrigirCustomFieldValues). No backfill completo
    // (milhares de tickets históricos) isso não é feito, ficaria lento demais.
    const baseSave = makeSaveComClassificacao(classValue);
    const savePatched = async (batch) => {
      state.phase = 'corrigindo';
      await corrigirCustomFieldValues(token, batch);
      return baseSave(batch);
    };

    console.log(`[loader]   /tickets — buscando ${modeUpper} em aberto`);
    await fetchEndpoint(token, '/tickets', idFilter, savePatched, pageSize);
    console.log(`[loader]   ${state.ticketsDone} ticket(s) de ${modeUpper} em aberto encontrados`);

    state.phase      = 'idle';
    state.running    = false;
    state.lastFinish = new Date().toISOString();
    state.lastResult = { mode, tickets: state.ticketsDone };

    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), tickets_loaded=$1, status='done' WHERE id=$2`,
        [state.ticketsDone, logId]
      ).catch(() => {});
    }
    console.log(`[loader] ✔ Carga ${modeUpper} concluída — ${state.ticketsDone} tickets`);
    return state.lastResult;
  } catch (err) {
    state.running         = false;
    state.phase           = 'idle';
    state.cancelRequested = false;
    const wasCancelled = err.cancelled === true;
    if (!wasCancelled) state.errors.push(err.message);
    const logStatus = wasCancelled ? 'cancelled' : 'error';
    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), status=$1, error_msg=$2 WHERE id=$3`,
        [logStatus, wasCancelled ? 'Cancelado pelo usuário' : err.message, logId]
      ).catch(() => {});
    }
    if (wasCancelled) {
      console.log(`[loader] ⏹ Carga ${modeUpper} cancelada — ${state.ticketsDone} tickets salvos`);
      state.lastResult = { mode, tickets: state.ticketsDone, cancelled: true };
    } else {
      console.error(`[loader] ✖ Carga ${modeUpper} com erro:`, err.message);
      throw err;
    }
  }
}

async function runOuvidoria() {
  return runByClassification('ouvidoria', 'Ouvidoria');
}

async function runGcc() {
  return runByClassification('gcc', 'Gestão de Combate ao Churn');
}

// Busca só os tickets de Ouvidoria/GCC cuja organização não foi identificada
// ("Não informado" no painel) e re-sincroniza CADA UM individualmente via
// "id=" (mesma chamada limpa usada em corrigirCustomFieldValues — sem
// $filter, então sem o bug que corrompe clients/customFieldValues). Muito
// mais barato que rodar uma Full inteira quando o problema é pontual (ex:
// bug de extração corrigido, só precisa re-processar os já afetados).
async function runFixOrganizacao() {
  if (state.running) throw new Error('Já existe uma carga em andamento');

  const { rows } = await db.query(`
    SELECT DISTINCT t.ticket_id
    FROM silver.ticket t
    JOIN silver.ticket_campo_customizado cf_class
      ON cf_class.ticket_id = t.ticket_id
      AND cf_class.custom_field_id = ${CF_CLASSIFICACAO}
      AND cf_class.valor_texto IN ('Ouvidoria', 'Gestão de Combate ao Churn')
    LEFT JOIN LATERAL (
      SELECT organizacao_nome
      FROM silver.ticket_cliente
      WHERE ticket_id = t.ticket_id
      ORDER BY (email ILIKE '%@viasoft.com.br'), (profile_type = '3'), organizacao_nome IS NULL
      LIMIT 1
    ) tc ON true
    WHERE tc.organizacao_nome IS NULL OR tc.organizacao_nome = ''
  `).catch(() => ({ rows: [] }));
  const ticketIds = rows.map(r => r.ticket_id);

  state.running          = true;
  state.cancelRequested  = false;
  state.mode             = 'fix-organizacao';
  state.startedAt        = new Date().toISOString();
  state.phase            = 'corrigindo';
  state.pagesDone        = 0;
  state.ticketsDone      = 0;
  state.savedIds         = new Set();
  state.errors           = [];

  await ensureTables();
  await db.query(
    `UPDATE silver.carga_log SET status='error', error_msg='Interrompido (reinício do servidor)', finished_at=NOW() WHERE status='running'`
  ).catch(() => {});
  const logRow = await db.query(
    `INSERT INTO silver.carga_log (mode, started_at, status) VALUES ('fix-organizacao', NOW(), 'running') RETURNING id`
  ).catch(() => ({ rows: [{ id: null }] }));
  const logId = logRow.rows?.[0]?.id;

  console.log(`[loader] ▶ Correção de organização iniciada — ${ticketIds.length} ticket(s) afetado(s)`);

  try {
    if (ticketIds.length) {
      const token = await getMovideskToken();
      for (const id of ticketIds) {
        if (state.cancelRequested) {
          throw Object.assign(new Error('Carga cancelada pelo usuário'), { cancelled: true });
        }
        try {
          const url = `${MOVI_BASE}/tickets?${qs({ token, id, '$select': 'id', '$expand': EXPAND_FIELDS })}`;
          const resp = await fetchWithRetry(url);
          const data = await resp.json();
          const full = Array.isArray(data) ? data[0] : data;
          if (full) {
            await saveBatch([full]);
            state.ticketsDone++;
          }
        } catch (e) {
          state.errors.push(`Ticket ${id}: ${e.message}`);
          console.warn(`[loader] correção do ticket ${id} falhou: ${e.message}`);
        }
        await sleep(120);
      }
    }

    state.phase      = 'idle';
    state.running    = false;
    state.lastFinish = new Date().toISOString();
    state.lastResult = { mode: 'fix-organizacao', tickets: state.ticketsDone, totalEncontrados: ticketIds.length };

    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), tickets_loaded=$1, status='done' WHERE id=$2`,
        [state.ticketsDone, logId]
      ).catch(() => {});
    }
    console.log(`[loader] ✔ Correção de organização concluída — ${state.ticketsDone}/${ticketIds.length} ticket(s) reprocessado(s)`);
    return state.lastResult;
  } catch (err) {
    state.running          = false;
    state.phase            = 'idle';
    state.cancelRequested  = false;
    const wasCancelled = err.cancelled === true;
    if (!wasCancelled) state.errors.push(err.message);
    const logStatus = wasCancelled ? 'cancelled' : 'error';
    if (logId) {
      await db.query(
        `UPDATE silver.carga_log SET finished_at=NOW(), status=$1, error_msg=$2 WHERE id=$3`,
        [logStatus, wasCancelled ? 'Cancelado pelo usuário' : err.message, logId]
      ).catch(() => {});
    }
    if (wasCancelled) {
      state.lastResult = { mode: 'fix-organizacao', tickets: state.ticketsDone, cancelled: true };
    } else {
      throw err;
    }
  }
}

function cancelLoad() {
  if (!state.running) return false;
  // Protege contra cancel residual de carga anterior que chega após nova carga iniciar:
  // ignora cancel se a carga tem menos de 2 segundos.
  const ageMs = state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 9999;
  if (ageMs < 2000) {
    console.warn('[loader] cancel ignorado — carga acabou de iniciar (< 2s)');
    return false;
  }
  state.cancelRequested = true;
  state.phase = 'cancelling';
  console.log('[loader] ⏹ Cancelamento solicitado');
  return true;
}

// ── Sincronização da pesquisa de satisfação (silver.ticket_satisfacao) ──────
// Estado PRÓPRIO (não usa `state`/state.running de propósito): esse job
// cobre TODO o histórico de tickets finalizados da empresa (centenas de
// milhares), então roda por dias/semanas em background — se ele bloqueasse
// (ou fosse bloqueado por) as cargas normais de Ouvidoria/GCC/Full/Incremental
// via `state.running`, essas cargas ficariam paradas o tempo todo.
//
// Limite real confirmado da API do Movidesk: 240 req/min, pra conta inteira
// (compartilhado com todas as outras chamadas — Ouvidoria/GCC, Curadoria,
// etc). Roda a 50 req/min por escolha explícita (bem abaixo do limite real,
// margem de segurança grande) — cada ticket exige uma requisição própria.
//
// TESTADO E CONFIRMADO (21/09/2026, via curl direto): buscar em lote com
// $filter=createdDate + $expand=satisfactionSurveyResponses NÃO é seguro —
// não é um caso de dado corrompido (como o bug já conhecido com
// customFieldValues), é pior: o ticket que REALMENTE tem uma resposta de
// pesquisa some inteiro do resultado filtrado. Testado com o ticket #856368
// (criado 2026-05-13, nota real=4, comentário="45444", confirmado por busca
// limpa sem filtro) — ele não aparece na lista de $filter+$expand daquele
// dia, enquanto todos os tickets vizinhos (sem resposta) aparecem normal.
// Ou seja, buscar em lote perderia exatamente os tickets que importam. Por
// isso a busca continua sendo OBRIGATORIAMENTE 1 requisição por ticket, sem
// $filter (só $select=id,satisfactionSurveyResponses).
const SATISFACAO_THROTTLE_MS = 1200;

const satisfacaoState = {
  running: false, total: 0, processed: 0, updated: 0, skipped: 0, errors: 0,
  currentTicketId: null, startedAt: null, finishedAt: null,
  stopRequested: false, lastError: null, years: [],
};

function normalizeSurveyValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(5, Math.round(value)));
  }
  return null;
}

// Se houver mais de uma resposta (ex: pesquisa reenviada), usa a mais recente.
function extractSatisfacao(responses) {
  const withSmiley = (responses || []).filter(r => r.satisfactionSurveySmileyFacesResponse != null);
  if (!withSmiley.length) return null;
  const [latest] = [...withSmiley].sort((a, b) => String(b.responseDate || '').localeCompare(String(a.responseDate || '')));
  const nota = normalizeSurveyValue(latest.satisfactionSurveySmileyFacesResponse);
  if (nota === null) return null;
  return { nota, comentario: latest.comments || null, respondidoEm: latest.responseDate || null };
}

async function fetchTicketSurvey(token, ticketId) {
  const url = `${MOVI_BASE}/tickets?${qs({ token, id: ticketId, '$select': 'id,satisfactionSurveyResponses' })}`;
  const resp = await fetchWithRetry(url);
  const data = await resp.json();
  const full = Array.isArray(data) ? data[0] : data;
  return full?.satisfactionSurveyResponses || [];
}

let activeSatisfacaoSync = null;

async function runSatisfacaoSyncLoop(years) {
  try {
    await ensureTables();
    const token = await getMovideskToken();

    // Só tickets finalizados (a pesquisa só é enviada após o encerramento) e
    // que ainda não foram checados — retomável: se o processo cair/reiniciar,
    // continua de onde parou sem refazer os já verificados. `years` (opcional)
    // prioriza um recorte específico — útil pra não esperar o backlog
    // inteiro (centenas de milhares de tickets) só pra ver dados de um ano
    // recente.
    const sortedYears = Array.isArray(years) ? years.map(Number).filter(y => y > 2000 && y <= new Date().getFullYear()) : [];
    const yearFilter = sortedYears.length ? `AND EXTRACT(YEAR FROM t.createddate) = ANY($1::int[])` : '';
    // Sem .catch aqui de propósito: um erro real na query (ex: tabela ainda
    // não existe, tipo incompatível) precisa estourar pro catch de fora, que
    // grava em satisfacaoState.lastError e loga no console — antes ficava
    // engolido em silêncio (virava "0 tickets processados" sem pista nenhuma
    // do motivo).
    const { rows } = await db.query(`
      SELECT t.ticket_id
      FROM silver.ticket t
      LEFT JOIN silver.ticket_satisfacao ts ON ts.ticket_id = t.ticket_id
      WHERE ts.ticket_id IS NULL
        AND t.basestatus IN ('Resolved', 'Closed', 'Resolvido', 'Fechado')
        ${yearFilter}
      ORDER BY t.createddate DESC
    `, sortedYears.length ? [sortedYears] : []);
    satisfacaoState.total = rows.length;
    console.log(`[loader] satisfacao: ${rows.length} ticket(s) pendente(s)${sortedYears.length ? ` (anos ${sortedYears.join(', ')})` : ''}`);
    satisfacaoState.years = sortedYears;

    for (const row of rows) {
      if (satisfacaoState.stopRequested) break;
      satisfacaoState.currentTicketId = row.ticket_id;

      try {
        const responses = await fetchTicketSurvey(token, row.ticket_id);
        const sat = extractSatisfacao(responses);
        if (sat) {
          await db.query(`
            INSERT INTO silver.ticket_satisfacao (ticket_id, nota, comentario, respondido_em, verificado_em)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (ticket_id) DO UPDATE SET
              nota = EXCLUDED.nota, comentario = EXCLUDED.comentario,
              respondido_em = EXCLUDED.respondido_em, verificado_em = NOW()
          `, [row.ticket_id, sat.nota, sat.comentario, sat.respondidoEm]);
          satisfacaoState.updated++;
        } else {
          // Verificado, mas o cliente não respondeu — marca como visto pra
          // não tentar de novo a cada execução (nota continua NULL).
          await db.query(`
            INSERT INTO silver.ticket_satisfacao (ticket_id, verificado_em)
            VALUES ($1, NOW())
            ON CONFLICT (ticket_id) DO UPDATE SET verificado_em = NOW()
          `, [row.ticket_id]);
          satisfacaoState.skipped++;
        }
      } catch (e) {
        satisfacaoState.errors++;
        console.warn(`[loader] satisfacao: falha no ticket ${row.ticket_id}: ${e.message}`);
      }

      satisfacaoState.processed++;
      await sleep(SATISFACAO_THROTTLE_MS);
    }
  } catch (err) {
    satisfacaoState.lastError = err.message;
    console.error('[loader] satisfacao sync erro:', err.message);
  } finally {
    satisfacaoState.running = false;
    satisfacaoState.currentTicketId = null;
    satisfacaoState.finishedAt = new Date().toISOString();
    activeSatisfacaoSync = null;
  }
}

function runSatisfacaoSync({ years = [] } = {}) {
  if (activeSatisfacaoSync) return satisfacaoState;
  satisfacaoState.running = true;
  satisfacaoState.total = 0;
  satisfacaoState.processed = 0;
  satisfacaoState.updated = 0;
  satisfacaoState.skipped = 0;
  satisfacaoState.errors = 0;
  satisfacaoState.startedAt = new Date().toISOString();
  satisfacaoState.finishedAt = null;
  satisfacaoState.stopRequested = false;
  satisfacaoState.lastError = null;
  satisfacaoState.years = [];
  activeSatisfacaoSync = runSatisfacaoSyncLoop(years);
  return satisfacaoState;
}

function stopSatisfacaoSync() {
  satisfacaoState.stopRequested = true;
  return satisfacaoState;
}

module.exports = {
  runFull, runIncremental, runOuvidoria, runGcc, runFixOrganizacao, cancelLoad, ensureTables, state,
  runSatisfacaoSync, stopSatisfacaoSync, satisfacaoState,
};
