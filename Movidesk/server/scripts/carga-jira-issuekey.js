'use strict';
/**
 * carga-jira-issuekey.js — traz do Movidesk a tarefa do Jira vinculada a cada chamado (campo jiraIssueKey) e grava em
 * silver.ticket.jiraissuekey, ano a ano (pela data de criação do chamado). Alimenta o card "Tarefas do Jira × chamados" do Painel Geral.
 *
 * Só LÊ do Movidesk e só altera a coluna jiraissuekey (nenhum outro dado do chamado). Ritmo ~27 requisições/min, sequencial: o perfil do Movidesk
 * aceita 150/min e o contêiner já usa parte disso (em 429 espera a janela virar).
 *
 * Uso (na VM, pasta Movidesk):
 *   docker compose exec -T painel node server/scripts/carga-jira-issuekey.js --ano=2026            # carga do ano
 *   docker compose exec -T painel node server/scripts/carga-jira-issuekey.js --ano=2026 --simular  # só mostra o que gravaria
 * Repita para cada ano (2025, 2024, …). Os chamados novos/atualizados passam a trazer a chave sozinhos pela carga normal (movidesk-loader.js).
 *
 * Como lista: tenta só os chamados COM tarefa ($filter=jiraIssueKey ne null — poucas páginas); se o Movidesk não aceitar o filtro, lista todos do mês
 * pedindo só id+jiraIssueKey e guarda os que têm chave. Percorre /tickets e /tickets/past (parados há ~90+ dias só aparecem no /past).
 */
const db = require('../db/remote');
const { movidesk } = require('../utils/movideskPeople');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const ANO = Number(args.ano);
const SIMULAR = !!args.simular;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSA_MS = 2200;
const pad = (n) => String(n).padStart(2, '0');

async function pedir(endpoint, filtro, skip) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const q = { $select: 'id,jiraIssueKey', $top: 1000, $skip: skip };
      if (filtro) q.$filter = filtro;
      const r = await movidesk('GET', endpoint, { query: q });
      await sleep(PAUSA_MS);
      return Array.isArray(r) ? r : [];
    } catch (e) {
      if (e && e.status === 429 && tentativa < 5) { console.log('[jira-key] limite de requisições: esperando 65 s'); await sleep(65000); continue; }
      if (tentativa < 3 && !(e && e.status >= 400 && e.status < 500)) { await sleep(5000); continue; }
      throw e;
    }
  }
}

async function listarMes(endpoint, ini, fim, usarFiltro, achados) {
  const base = `createdDate ge ${ini} and createdDate lt ${fim}`;
  const filtro = usarFiltro ? `jiraIssueKey ne null and ${base}` : base;
  let lidos = 0;
  for (let skip = 0; ; skip += 1000) {
    const lote = await pedir(endpoint, filtro, skip);
    lidos += lote.length;
    for (const t of lote) { const k = String(t.jiraIssueKey || '').trim(); if (k) achados.set(String(t.id), k); }
    if (lote.length < 1000) break;
  }
  return lidos;
}

(async () => {
  if (!Number.isInteger(ANO) || ANO < 2015 || ANO > 2100) { console.log('Informe o ano: --ano=2026'); process.exit(1); }
  console.log(`[jira-key] ano ${ANO}${SIMULAR ? ' (simulação: nada será gravado)' : ''}`);

  // O Movidesk aceita filtrar por jiraIssueKey? Testa uma vez; senão lista tudo e filtra aqui.
  let usarFiltro = true;
  try { await pedir('/tickets', 'jiraIssueKey ne null', 0).then((l) => console.log(`[jira-key] filtro por jiraIssueKey aceito (${l.length} na 1ª página de teste)`)); }
  catch (e) { usarFiltro = false; console.log(`[jira-key] o Movidesk não aceitou o filtro (${String(e.message).slice(0, 120)}): vou listar tudo de cada mês`); }

  const achados = new Map();   // id -> chave
  let completo = true;
  for (let m = 1; m <= 12; m++) {
    const ini = `${ANO}-${pad(m)}-01T00:00:00-03:00`;
    const fim = m === 12 ? `${ANO + 1}-01-01T00:00:00-03:00` : `${ANO}-${pad(m + 1)}-01T00:00:00-03:00`;
    let lidos = 0;
    for (const ep of ['/tickets', '/tickets/past']) {
      try { lidos += await listarMes(ep, ini, fim, usarFiltro, achados); }
      catch (e) { completo = false; console.log(`[jira-key] ${ANO}-${pad(m)} ${ep} falhou: ${String(e.message).slice(0, 160)}`); }
    }
    console.log(`[jira-key] ${ANO}-${pad(m)}: ${lidos} lido(s); com tarefa no ano até agora: ${achados.size}`);
  }

  const ids = [...achados.keys()], chaves = ids.map((id) => achados.get(id));
  const dist = new Set(chaves).size;
  console.log(`[jira-key] ${ids.length} chamado(s) com tarefa vinculada, ${dist} tarefa(s) distinta(s)`);
  if (SIMULAR) { console.log('[jira-key] simulação: nada gravado'); process.exit(0); }
  if (!ids.length) { console.log('[jira-key] nada a gravar'); process.exit(0); }

  // 1) grava a chave (só onde mudou); chamados que ainda não estão no banco ficam de fora e são contados
  const up = await db.query(`
    UPDATE silver.ticket t SET jiraissuekey = u.k
      FROM unnest($1::bigint[], $2::text[]) AS u(id, k)
     WHERE t.ticket_id = u.id AND t.jiraissuekey IS DISTINCT FROM u.k`, [ids, chaves]);
  const noBanco = (await db.query(`SELECT COUNT(*)::int AS n FROM silver.ticket WHERE ticket_id = ANY($1::bigint[])`, [ids])).rows[0].n;
  console.log(`[jira-key] gravado em ${up.rowCount} chamado(s); ${noBanco} dos ${ids.length} estão no banco (os demais ainda não foram carregados)`);

  // 2) só com a listagem completa do ano: quem tinha chave no banco e não tem mais no Movidesk, limpa
  if (completo) {
    const limpou = await db.query(`
      UPDATE silver.ticket SET jiraissuekey = NULL
       WHERE createddate >= $1::timestamptz AND createddate < $2::timestamptz AND jiraissuekey IS NOT NULL AND NOT (ticket_id = ANY($3::bigint[]))`,
      [`${ANO}-01-01T00:00:00-03:00`, `${ANO + 1}-01-01T00:00:00-03:00`, ids]);
    console.log(`[jira-key] chaves removidas de chamados que não têm mais tarefa no Movidesk: ${limpou.rowCount}`);
  } else console.log('[jira-key] listagem incompleta: não removi nenhuma chave antiga');
  console.log('[jira-key] FIM');
  process.exit(0);
})().catch((e) => { console.log('[jira-key] erro fatal:', e.message); process.exit(1); });
