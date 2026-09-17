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

// Campo personalizado "Classificação de Ticket" — usado pela carga Ouvidoria
const CF_CLASSIFICACAO = 23946;

// ── Estado em memória (acessado pela rota de status) ─────────────────────────
const state = {
  running:    false,
  mode:       null,       // 'full' | 'full-anos' | 'incremental'
  startedAt:  null,
  phase:      'idle',     // 'fetching' | 'saving' | 'cancelling' | 'idle'
  endpoint:   null,       // '/tickets' | '/tickets/past'
  pagesDone:  0,
  ticketsDone: 0,
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
].join(',');

// Movidesk OData não suporta sintaxe aninhada v4 (semicolons, $select dentro de $expand).
// Expande apenas os nomes das entidades — o servidor retorna todos os campos delas.
const EXPAND_FIELDS = 'owner,clients,customFieldValues,actions';

// ── Busca uma página da API ───────────────────────────────────────────────────
async function fetchPage(token, endpoint, filter, skip) {
  const params = {
    token,
    '$select': SELECT_FIELDS,
    '$expand': EXPAND_FIELDS,
    '$top':    PAGE_SIZE,
    '$skip':   skip,
  };
  if (filter) params['$filter'] = filter;

  const url = `${MOVI_BASE}${endpoint}?${qs(params)}`;
  const resp = await fetchWithRetry(url);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// ── Descoberta leve de IDs (sem $expand) ──────────────────────────────────────
// O filtro aninhado customFieldValues/any(...) combinado com $expand completo
// é caro demais pra API do Movidesk processar junto (timeout/429). Descobrir
// só os IDs primeiro (sem $expand) é rápido mesmo com filtro complexo — depois
// buscamos os detalhes completos só desses IDs específicos.
const ID_PAGE_SIZE = 1000;

// A API do Movidesk limita o $filter a 100 "nodes" — retorna HTTP 400 "node
// count limit of '100' has been exceeded" se passar disso. Cada "id eq X"
// conta como 3 nodes (propriedade + constante + comparação) e cada "or"
// entre comparações conta mais 1 node, então um filtro com N ids em OR tem
// 4N-1 nodes (confirmado: um lote de 40 ids — 159 nodes — ainda deu 400).
// N=20 dá 79 nodes, com folga.
const ID_FILTER_CHUNK = 20;

function buildIdFilter(ids) {
  return ids.map(id => `id eq ${id}`).join(' or ');
}

async function fetchIdPage(token, endpoint, filter, skip) {
  const params = { token, '$select': 'id', '$top': ID_PAGE_SIZE, '$skip': skip };
  if (filter) params['$filter'] = filter;
  const url = `${MOVI_BASE}${endpoint}?${qs(params)}`;
  const resp = await fetchWithRetry(url);
  const data = await resp.json();
  return Array.isArray(data) ? data.map(t => t.id) : [];
}

async function fetchAllIds(token, endpoints, filter) {
  const ids = [];
  for (const ep of endpoints) {
    let skip = 0;
    while (true) {
      if (state.cancelRequested) {
        throw Object.assign(new Error('Carga cancelada pelo usuário'), { cancelled: true });
      }
      const page = await fetchIdPage(token, ep, filter, skip);
      if (!page.length) break;
      ids.push(...page);
      if (page.length < ID_PAGE_SIZE) break;
      skip += ID_PAGE_SIZE;
      await sleep(150);
    }
  }
  return [...new Set(ids)];
}

// Busca os detalhes completos (com $expand) de uma lista de IDs, em lotes de
// ID_FILTER_CHUNK (limite de "nodes" do $filter da API), salvando cada lote
// via onBatch. Usado quando o filtro original é complexo demais pra combinar
// direto com $expand (ver fetchAllIds acima).
async function fetchDetailsAndSave(token, ids, onBatch) {
  let total = 0;
  for (let i = 0; i < ids.length; i += ID_FILTER_CHUNK) {
    if (state.cancelRequested) {
      throw Object.assign(new Error('Carga cancelada pelo usuário'), { cancelled: true });
    }
    const chunk = ids.slice(i, i + ID_FILTER_CHUNK);
    const idsOr = buildIdFilter(chunk);
    state.phase = 'fetching';
    const batch = await fetchPage(token, '/tickets', idsOr, 0);
    state.phase = 'saving';
    await onBatch(batch);
    state.pagesDone++;
    state.ticketsDone += batch.length;
    total += batch.length;
    await sleep(150);
  }
  return total;
}

// ── Itera todas as páginas de um endpoint, chamando onBatch a cada página ────
async function fetchEndpoint(token, endpoint, filter, onBatch) {
  let skip = 0;
  let total = 0;

  state.endpoint = endpoint;

  while (true) {
    if (state.cancelRequested) {
      console.log('[loader] cancelamento solicitado — interrompendo fetchEndpoint');
      throw Object.assign(new Error('Carga cancelada pelo usuário'), { cancelled: true });
    }

    state.phase = 'fetching';
    const batch = await fetchPage(token, endpoint, filter, skip);
    if (!batch.length) break;

    state.phase = 'saving';
    await onBatch(batch);

    state.pagesDone++;
    state.ticketsDone += batch.length;
    total += batch.length;

    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
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
  if (!tickets.length) return;

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
  // clientorganization — pega da primeira org dos clients
  const clientOrgs  = tickets.map(t => {
    const c = Array.isArray(t.clients) ? t.clients[0] : null;
    return c?.organization?.businessName || c?.businessName || null;
  });

  await db.query(`
    INSERT INTO silver.ticket
      (ticket_id, subject, status, basestatus, createddate,
       last_update, ownerteam, owner_id, owner_name,
       urgency, category, service_full,
       resolved_in, closed_in, stopped_time_wt, stopped_time,
       sla_response_date, clientorganization, extracted_at)
    SELECT
      u.ticket_id::bigint, u.subject, u.status, u.basestatus, u.createddate::timestamptz,
      u.last_update::timestamptz, u.ownerteam, u.owner_id, u.owner_name,
      u.urgency, u.category, u.service_full,
      u.resolved_in::timestamptz, u.closed_in::timestamptz,
      u.stopped_time_wt::float, u.stopped_time::float,
      u.sla_response_date::timestamptz, u.clientorganization, NOW()
    FROM unnest(
      $1::varchar[],  $2::text[],  $3::text[],  $4::text[],  $5::text[],
      $6::text[],     $7::text[],  $8::text[],  $9::text[],
      $10::text[],    $11::text[], $12::text[],
      $13::text[],    $14::text[], $15::text[],  $16::text[],
      $17::text[],    $18::text[]
    ) AS u(
      ticket_id, subject, status, basestatus, createddate,
      last_update, ownerteam, owner_id, owner_name,
      urgency, category, service_full,
      resolved_in, closed_in, stopped_time_wt, stopped_time,
      sla_response_date, clientorganization
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
      extracted_at      = EXCLUDED.extracted_at
  `, [ids, subjects, statuses, baseStats, createdDts,
      lastUpdates, ownerTeams, ownerIds, ownerNames,
      urgencies, categories, services,
      resolvedIns, closedIns, stoppedTs, stoppedCs,
      slaRespDs, clientOrgs]);

  // ── 2. silver.ticket_acao ──
  const actionRows = [];
  for (const t of tickets) {
    if (!Array.isArray(t.actions)) continue;
    for (const a of t.actions) {
      if (!a.id) continue;
      actionRows.push({
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
  if (actionRows.length) {
    await db.query(`
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
    ]);
  }

  // ── 3. silver.ticket_campo_customizado ──
  const cfRows = [];
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
  if (cfRows.length) {
    // Sem unique constraint em (ticket_id, custom_field_id) no schema do extractor Java
    // (permite múltiplas linhas via item_ordem) — usa DELETE + INSERT por ticket.
    // DELETE e INSERT rodam na MESMA transação: se o INSERT falhar, o DELETE é
    // desfeito também — sem isso, um erro no meio deixava tickets sem nenhuma linha
    // de classificação (sumindo da Ouvidoria mesmo continuando em silver.ticket).
    const cfTicketIds = [...new Set(cfRows.map(r => r.ticket_id))];
    await db.withClient(async (client) => {
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
      cliRows.push({
        ticket_id:        String(t.id),
        cliente_id:       c.id ? String(c.id) : null,
        nome:             c.businessName || null,
        email:            c.email || null,
        organizacao_id:   c.organization?.id ? String(c.organization.id) : null,
        organizacao_nome: c.organization?.businessName || null,
      });
    }
  }
  if (cliRows.length) {
    // Sem unique constraint confiável no schema do extractor Java — DELETE + INSERT
    // por ticket, na mesma transação (mesmo motivo do bloco acima).
    const cliTicketIds = [...new Set(cliRows.map(r => r.ticket_id))];
    await db.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `DELETE FROM silver.ticket_cliente WHERE ticket_id = ANY($1::bigint[])`,
          [cliTicketIds]
        );
        await client.query(`
          INSERT INTO silver.ticket_cliente
            (ticket_id, cliente_id, nome, email, organizacao_id, organizacao_nome, extracted_at)
          SELECT
            u.ticket_id::bigint, NULLIF(u.cliente_id, ''), u.nome, u.email,
            NULLIF(u.organizacao_id, ''), u.organizacao_nome, NOW()
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]
          ) AS u(ticket_id, cliente_id, nome, email, organizacao_id, organizacao_nome)
        `, [
          cliRows.map(r => r.ticket_id),
          cliRows.map(r => r.cliente_id),
          cliRows.map(r => r.nome),
          cliRows.map(r => r.email),
          cliRows.map(r => r.organizacao_id),
          cliRows.map(r => r.organizacao_nome),
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }
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
 */
async function runFull({ years = [], classification = '' } = {}) {
  if (state.running) throw new Error('Já existe uma carga em andamento');

  const sortedYears = [...years].map(Number).filter(y => y > 2000 && y <= new Date().getFullYear()).sort();
  const modeLabel   = sortedYears.length ? 'full-anos' : 'full';
  const classValue   = String(classification || '').trim();
  // Escapa aspas simples no valor pro filtro OData (padrão: '' representa um ' literal)
  const classFilter  = classValue
    ? `customFieldValues/any(cf: cf/customFieldId eq ${CF_CLASSIFICACAO}` +
      ` and cf/items/any(item: item/customFieldItem eq '${classValue.replace(/'/g, "''")}'))`
    : null;

  // marca como running ANTES de qualquer await para que /status reflita imediatamente
  state.running          = true;
  state.cancelRequested  = false;
  state.mode             = modeLabel;
  state.startedAt        = new Date().toISOString();
  state.phase            = 'preparando';
  state.pagesDone        = 0;
  state.ticketsDone      = 0;
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
    `INSERT INTO silver.carga_log (mode, started_at, status) VALUES ($1, NOW(), 'running') RETURNING id`,
    [modeLabel]
  ).catch(() => ({ rows: [{ id: null }] }));
  const logId = logRow.rows?.[0]?.id;
  console.log('[loader] carga_log insert OK, id:', logId);

  const yearsDesc = sortedYears.length ? `anos: ${sortedYears.join(', ')}` : 'todos os anos';
  console.log(`[loader] ▶ Carga FULL iniciada — ${yearsDesc}`);

  // Quando há filtro de classificação, o filtro aninhado customFieldValues/any(...)
  // combinado com $expand completo é caro demais pra API do Movidesk (mesmo bug
  // de timeout/429 encontrado na carga de Ouvidoria/GCC). Nesse caso, buscamos os
  // IDs primeiro (sem $expand — rápido mesmo com filtro complexo) e só então os
  // detalhes completos desses IDs específicos. Também aplicamos o mesmo workaround
  // pro bug de serialização (customFieldValues[].items ausente) da carga por
  // classificação.
  const saveWithClassPatch = classValue ? async (batch) => {
    for (const t of batch) {
      if (!Array.isArray(t.customFieldValues)) t.customFieldValues = [];
      let cf = t.customFieldValues.find(c => c.customFieldId === CF_CLASSIFICACAO);
      if (!cf) {
        cf = { customFieldId: CF_CLASSIFICACAO };
        t.customFieldValues.push(cf);
      }
      if (!Array.isArray(cf.items) || !cf.items.length) {
        cf.items = [{ customFieldItem: classValue }];
      }
    }
    await saveBatch(batch);
  } : saveBatch;

  try {
    const token = await getMovideskToken();
    console.log(`[loader] token carregado: ...${token.slice(-6)} (últimos 6 chars)`);

    if (sortedYears.length) {
      // ── Carga por ano selecionado ──────────────────────────────────────────
      for (const year of sortedYears) {
        state.currentYear = year;
        // Inclui jan do ano seguinte no filtro para pegar horários de fuseau diferente
        const from = `${year}-01-01T00:00:00Z`;
        const to   = `${year}-12-31T23:59:59Z`;
        const dateFilter = `createdDate ge ${from} and createdDate le ${to}`;

        console.log(`[loader]   ── Ano ${year}${classValue ? ` — classificação "${classValue}"` : ''} ──`);
        if (classFilter) {
          const ids = await fetchAllIds(token, ['/tickets', '/tickets/past'], `${dateFilter} and ${classFilter}`);
          console.log(`[loader]     ${ids.length} ticket(s) encontrados`);
          await fetchDetailsAndSave(token, ids, saveWithClassPatch);
        } else {
          for (const ep of ['/tickets', '/tickets/past']) {
            console.log(`[loader]     endpoint ${ep}`);
            await fetchEndpoint(token, ep, dateFilter, saveBatch);
          }
        }
        state.yearsDone++;
        console.log(`[loader]   ✓ Ano ${year} concluído — ${state.ticketsDone} tickets acumulados`);
      }
      state.currentYear = null;
    } else if (classFilter) {
      // ── Carga total filtrada só por classificação (sem filtro de data) ──────
      console.log(`[loader]   classificação "${classValue}" — descobrindo IDs`);
      const ids = await fetchAllIds(token, ['/tickets', '/tickets/past'], classFilter);
      console.log(`[loader]   ${ids.length} ticket(s) encontrados`);
      await fetchDetailsAndSave(token, ids, saveWithClassPatch);
    } else {
      // ── Carga total sem filtro nenhum ───────────────────────────────────────
      console.log('[loader]   sem filtro de data ou classificação');
      for (const ep of ['/tickets', '/tickets/past']) {
        console.log(`[loader]   endpoint ${ep}`);
        await fetchEndpoint(token, ep, null, saveBatch);
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

    // O filtro OData aninhado customFieldValues/any(...) combinado com $expand=owner,
    // clients,customFieldValues,actions é caro demais pra API do Movidesk processar
    // junto (dava timeout de 60s). O filtro sozinho, SEM $expand, é rápido — então
    // fazemos em duas fases: (1) descobre os IDs com uma consulta leve (só id,
    // filtro completo), (2) busca os detalhes completos (com $expand) só desses IDs.
    const closedExclusion = CLOSED_STATUSES.map(s => `baseStatus ne '${s}'`).join(' and ');
    const classFilter = `customFieldValues/any(cf: cf/customFieldId eq ${CF_CLASSIFICACAO}` +
                        ` and cf/items/any(item: item/customFieldItem eq '${classValue.replace(/'/g, "''")}'))`;
    const idFilter = `${classFilter} and ${closedExclusion}`;

    console.log(`[loader]   /tickets — descobrindo IDs de ${modeUpper} em aberto`);
    const idUrl = `${MOVI_BASE}/tickets?${qs({ token, '$select': 'id', '$filter': idFilter, '$top': 1000 })}`;
    const idResp = await fetchWithRetry(idUrl);
    const idList = await idResp.json();
    const ids = (Array.isArray(idList) ? idList : []).map(t => t.id);
    console.log(`[loader]   ${ids.length} ticket(s) de ${modeUpper} em aberto encontrados`);

    // Fase 2 — busca os detalhes completos só desses IDs.
    //
    // Bug confirmado na API do Movidesk: para tickets abertos criados via
    // formulário web/automação, o customFieldValues[] retornado vem com
    // value:null e SEM a chave "items" para o campo 23946 — mesmo quando o
    // próprio $filter usado pra localizar o ticket depende desse valor.
    // Confirmado com curl direto na API, com e sem o filtro de classificação
    // combinado: mesmo resultado quebrado nos dois casos. É uma inconsistência
    // da serialização da API do Movidesk, não do nosso código.
    //
    // Como a Fase 1 já PROVOU a classificação (foi exatamente esse filtro que
    // trouxe o ticket), não precisamos confiar na resposta quebrada da Fase 2
    // pra esse campo específico — corrigimos o valor no objeto antes de salvar.
    if (ids.length) {
      const savePatched = async (batch) => {
        for (const t of batch) {
          if (!Array.isArray(t.customFieldValues)) t.customFieldValues = [];
          let cf = t.customFieldValues.find(c => c.customFieldId === CF_CLASSIFICACAO);
          if (!cf) {
            cf = { customFieldId: CF_CLASSIFICACAO };
            t.customFieldValues.push(cf);
          }
          if (!Array.isArray(cf.items) || !cf.items.length) {
            cf.items = [{ customFieldItem: classValue }];
          }
        }
        await saveBatch(batch);
      };
      await fetchDetailsAndSave(token, ids, savePatched);
    }

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

module.exports = { runFull, runIncremental, runOuvidoria, runGcc, cancelLoad, state };
