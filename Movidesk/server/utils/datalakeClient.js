// Cliente HTTP fino para a apidatalake (bronze/silver/gold do Movidesk via API
// própria em https://apidatalake.viasoftcloud.com.br), usado por
// server/routes/tickets.js a partir da Fase 1 da migração (ver plano em
// .claude/plans — migração PAINEL-SI → apidatalake).
//
// Autenticação: Authorization: Bearer <DATALAKE_API_TOKEN>. NUNCA reaproveitar
// aqui o token do Movidesk (movidesk_token, salvo via config.js) nem o token
// do Gateway Proxy / "Ponte API" (X-Gateway-Token, apimovidesk.viasoftcloud.com.br)
// — são três credenciais de sistemas diferentes.
//
// DATALAKE_API_URL/DATALAKE_API_TOKEN vêm do .env do painel (não commitados).

const fetch = require('node-fetch');

const BASE_URL = (process.env.DATALAKE_API_URL || '').replace(/\/+$/, '');
const API_TOKEN = process.env.DATALAKE_API_TOKEN || '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Erro de configuração (variáveis de ambiente ausentes) — sempre deve
// aparecer explicitamente, nunca deve ser mascarado por um fallback silencioso.
class DatalakeConfigError extends Error {}

// Rede/DNS/5xx da apidatalake — condição em que faz sentido cair no fallback
// pro banco local (tabela `tickets`) durante a transição.
class DatalakeUnavailableError extends Error {}

// 4xx de negócio (401/403/404/422) — token inválido, escopo insuficiente,
// ticket não encontrado, parâmetro inválido. Não deve ser mascarado por
// fallback: é um erro de configuração/uso que precisa aparecer no log.
class DatalakeApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'DatalakeApiError';
    this.status = status;
    this.body = body;
  }
}

function ensureConfigured() {
  if (!BASE_URL || !API_TOKEN) {
    throw new DatalakeConfigError(
      'DATALAKE_API_URL/DATALAKE_API_TOKEN não configurados no .env do painel'
    );
  }
}

async function datalakeGet(path, { query = {}, attempt = 0 } = {}) {
  ensureConfigured();

  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      timeout: 15000,
    });
  } catch (error) {
    throw new DatalakeUnavailableError(`Falha de rede ao chamar apidatalake: ${error.message}`);
  }

  // 429 (rate limit por perfil) — respeita Retry-After se vier, senão backoff linear.
  if (response.status === 429 && attempt < 3) {
    const retry = response.headers.get('retry-after');
    const waitMs = Math.max(1000, Number(retry) * 1000 || Date.parse(retry) - Date.now() || 1000 * (attempt + 1));
    if (waitMs > 15000) throw new DatalakeUnavailableError('Limite temporário do datalake; tente mais tarde');
    console.warn(`[datalakeClient] 429 em ${path}. Aguardando ${waitMs}ms (tentativa ${attempt + 1}/3)...`);
    await sleep(waitMs);
    return datalakeGet(path, { query, attempt: attempt + 1 });
  }

  // 5xx — trata como indisponibilidade transitória, com retry curto antes de desistir.
  if (response.status >= 500 && attempt < 2) {
    const waitMs = 800 * (attempt + 1);
    console.warn(`[datalakeClient] ${response.status} em ${path}. Retentando em ${waitMs}ms...`);
    await sleep(waitMs);
    return datalakeGet(path, { query, attempt: attempt + 1 });
  }

  let raw;
  try { raw = await response.text(); } catch (_) { throw new DatalakeUnavailableError('Falha ao receber dados do datalake'); }
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (!response.ok) {
    if (response.status >= 500) {
      throw new DatalakeUnavailableError(
        `apidatalake retornou ${response.status}${raw ? `: ${String(raw).slice(0, 300)}` : ''}`
      );
    }
    const message = (parsed && parsed.message) || `apidatalake retornou ${response.status}`;
    throw new DatalakeApiError(message, response.status, parsed);
  }

  if (!parsed || typeof parsed !== 'object') throw new DatalakeUnavailableError('Resposta inválida do datalake');
  return parsed;
}

// Percorre GET /legacy/tickets por cursor até esgotar ou atingir maxPages
// (teto de segurança — a paginação é sempre "pra frente", nunca reversa).
async function fetchAllLegacyTickets({ status, limit = 100, campos, maxPages = 100 } = {}) {
  const all = [];
  let cursor;
  let page = 0;

  while (page < maxPages) {
    const result = await datalakeGet('/legacy/tickets', {
      query: { status, limit, campos, cursor },
    });
    const rows = Array.isArray(result?.data) ? result.data : [];
    all.push(...rows);
    page += 1;

    if (!result?.pageInfo?.hasMore || !result?.pageInfo?.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }

  return all;
}

// campos='*' e incluir='actionsjson,statushistoriesjson,clientsjson' por padrão:
// cobre tudo que inferTicketContext/calcularSLAPrimeiroContato precisam numa
// única chamada. Ver adaptadores em tickets.js para o mapeamento de shape.
async function fetchLegacyTicketDetail(
  id,
  { campos = '*', incluir = 'actionsjson,statushistoriesjson,clientsjson' } = {}
) {
  const result = await datalakeGet(`/legacy/tickets/${encodeURIComponent(id)}`, {
    query: { campos, incluir },
  });
  return result?.data || null;
}

async function fetchLegacyCustomFieldsCatalog() {
  const result = await datalakeGet('/legacy/custom-fields');
  return Array.isArray(result?.data) ? result.data : [];
}

// Detalhe "nativo" de um ticket (silver.ticket + gold.mv_ticket_campos_principais,
// via GET /tickets/:id, mais os sub-recursos /acoes, /clientes e
// /status-historico), usado por tickets.js a partir da Fase 2 da migração no
// lugar de fetchLegacyTicketDetail (/legacy/tickets/:id exige o escopo
// legacy:read, não concedido ao perfil painel-sla — ver README da apidatalake).
// Os sub-recursos nativos, ao contrário do /legacy, vêm com nomes de coluna
// limpos e, no caso de /acoes, com os códigos numéricos reais de tipo/origem
// do Movidesk — não precisa de heurística nenhuma pra adaptar (ver
// nativeRowToTicketShape em tickets.js).
async function fetchNativeTicketDetail(id) {
  const ticketResult = await datalakeGet(`/tickets/${encodeURIComponent(id)}`);
  const ticket = ticketResult?.data;
  if (!ticket || Object.keys(ticket).length === 0) return null;

  const [acoesResult, clientesResult, statusResult] = await Promise.all([
    datalakeGet(`/tickets/${encodeURIComponent(id)}/acoes`),
    datalakeGet(`/tickets/${encodeURIComponent(id)}/clientes`),
    datalakeGet(`/tickets/${encodeURIComponent(id)}/status-historico`),
  ]);

  return {
    ...ticket,
    acoes: Array.isArray(acoesResult?.data) ? acoesResult.data : [],
    clientes: Array.isArray(clientesResult?.data) ? clientesResult.data : [],
    statusHistorico: Array.isArray(statusResult?.data) ? statusResult.data : [],
  };
}

// Custom fields (formato longo, com máscara de PII se aplicável) de um
// ticket — GET /tickets/:id/campos, escopo tickets:read. Reaproveitado por
// filterByCustomFieldCondition (tickets.js) e pelo sync de Módulo x Rotina
// (curadoria.js), no lugar da chamada direta a api.movidesk.com.
async function fetchTicketCamposDatalake(id) {
  const result = await datalakeGet(`/tickets/${encodeURIComponent(id)}/campos`);
  return Array.isArray(result?.data) ? result.data : [];
}

module.exports = {
  DatalakeConfigError,
  DatalakeUnavailableError,
  DatalakeApiError,
  datalakeGet,
  fetchAllLegacyTickets,
  fetchLegacyTicketDetail,
  fetchLegacyCustomFieldsCatalog,
  fetchNativeTicketDetail,
  fetchTicketCamposDatalake,
};
