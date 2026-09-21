'use strict';
/**
 * teste-satisfacao-lote.js
 *
 * Teste manual (não roda automaticamente, não mexe no banco) pra confirmar
 * se dá pra buscar satisfactionSurveyResponses em LOTE via /tickets
 * ($filter + $expand), em vez de 1 requisição por ticket.
 *
 * Já existe um bug CONFIRMADO no /tickets: QUALQUER $filter combinado com
 * $expand=customFieldValues corrompe os campos customizados retornados (ver
 * corrigirCustomFieldValues em movidesk-loader.js). Não se sabe se
 * $expand=satisfactionSurveyResponses sofre do mesmo problema — é isso que
 * este script verifica, comparando o valor vindo em lote (com $filter) com
 * o valor vindo de uma busca limpa por id (sem $filter, mesmo método já
 * usado em produção pela Curadoria).
 *
 * Uso: docker compose exec painel node scripts/teste-satisfacao-lote.js
 */

const fetch = require('node-fetch');
const { getToken } = require('../routes/config');

const MOVI_BASE = 'https://apimovidesk.viasoftcloud.com.br/public/v1';

function getMovideskToken() {
  return new Promise((resolve, reject) => getToken((err, tok) => (err ? reject(err) : resolve(tok))));
}

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function main() {
  console.log('▶ Buscando token do Movidesk...');
  const token = await getMovideskToken();
  console.log(`  token: ...${token.slice(-6)}`);

  // Ajuste o período aqui se quiser testar outro mês/ano.
  const from = '2026-01-01T00:00:00Z';
  const to = '2026-01-31T23:59:59Z';
  const filter = `createdDate ge ${from} and createdDate le ${to}`;

  console.log(`\n▶ Buscando lote de tickets (${from} .. ${to}) com $expand=satisfactionSurveyResponses...`);
  const urlLote = `${MOVI_BASE}/tickets?${qs({
    token,
    '$select': 'id,subject,baseStatus,createdDate,resolvedIn',
    '$filter': filter,
    '$expand': 'satisfactionSurveyResponses',
    '$top': 10,
  })}`;
  const lote = await fetchJson(urlLote);
  const ticketsLote = Array.isArray(lote) ? lote : (lote.value || []);
  console.log(`  ${ticketsLote.length} ticket(s) retornado(s) no lote.\n`);

  ticketsLote.forEach(t => {
    const respostas = t.satisfactionSurveyResponses || [];
    console.log(`  #${t.id} [${t.baseStatus}] criado=${t.createdDate} resolvido=${t.resolvedIn || '-'} — ${respostas.length} resposta(s) de pesquisa`);
    respostas.forEach(r => console.log(`      nota=${r.satisfactionSurveySmileyFacesResponse} comentario="${(r.comments || '').slice(0, 60)}" data=${r.responseDate}`));
  });

  if (!ticketsLote.length) {
    console.log('\n⚠ Nenhum ticket retornado nesse período — ajuste as datas `from`/`to` no script e rode de novo.');
    return;
  }

  // ── Comparação: busca limpa (sem $filter) do primeiro ticket do lote ──
  const alvo = ticketsLote.find(t => (t.satisfactionSurveyResponses || []).length) || ticketsLote[0];
  console.log(`\n▶ Comparando com busca limpa (sem $filter) do ticket #${alvo.id}...`);
  const urlLimpo = `${MOVI_BASE}/tickets?${qs({
    token,
    id: alvo.id,
    '$select': 'id,satisfactionSurveyResponses',
  })}`;
  const limpo = await fetchJson(urlLimpo);
  const ticketLimpo = Array.isArray(limpo) ? limpo[0] : limpo;
  const respostasLimpo = ticketLimpo?.satisfactionSurveyResponses || [];
  console.log(`  Busca limpa: ${respostasLimpo.length} resposta(s) de pesquisa`);
  respostasLimpo.forEach(r => console.log(`      nota=${r.satisfactionSurveySmileyFacesResponse} comentario="${(r.comments || '').slice(0, 60)}" data=${r.responseDate}`));

  const respostasLote = alvo.satisfactionSurveyResponses || [];
  const bateu = JSON.stringify(respostasLote) === JSON.stringify(respostasLimpo);
  console.log(`\n${bateu ? '✅ BATEU' : '❌ NÃO BATEU'} — lote (com $filter) ${bateu ? '==' : '!='} busca limpa (sem $filter)`);
  if (!bateu) {
    console.log('  → Mesmo bug do customFieldValues: $filter + $expand=satisfactionSurveyResponses corrompe o dado. NÃO usar em lote.');
  } else {
    console.log('  → Seguro usar $filter + $expand=satisfactionSurveyResponses em lote. Dá pra reescrever a sincronização pra buscar por página em vez de ticket a ticket.');
  }
}

main().catch(e => {
  console.error('Erro no teste:', e.message);
  process.exit(1);
});
