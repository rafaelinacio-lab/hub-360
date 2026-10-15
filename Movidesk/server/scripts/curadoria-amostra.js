'use strict';
/**
 * curadoria-amostra.js — roda a Curadoria (IA que lê o chamado inteiro e diagnostica a causa) numa AMOSTRA de chamados de 2026 da visão
 * Suporte Técnico, para ver custo e qualidade antes de processar o ano todo. Alimenta o painel "Top 10 causas" do Painel Geral.
 *
 * Os chamados vêm do próprio banco do Hub (silver.ticket + silver.ticket_acao), sem chamar o Movidesk: as ações são gravadas em
 * public.curadoria_chamados (banco movidesk_curadoria) no mesmo formato que a importação da Curadoria usa e processadas pela MESMA rotina
 * da tela (processOneCuradoriaTicket: prompt, modelo e validação configurados em Configurações → Curadoria Avançado).
 *
 * Gasto de IA: tem teto em dólares (--teto, padrão 30): ao passar dele, para. Cada chamado custa em média ~US$ 0,004 (gpt-4.1-mini).
 * Retomável: o que já foi processado (processado = 1) fica de fora numa nova rodada.
 *
 * Uso (na VM, pasta Movidesk):
 *   docker compose exec -T painel node server/scripts/curadoria-amostra.js --n=5000 --paralelo=4 --teto=30
 *   docker compose exec -T painel node server/scripts/curadoria-amostra.js --n=5000 --simular   # só monta a amostra e mostra, sem gastar
 */
const db = require('../db/remote');
const curadoria = require('../routes/curadoria');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const N = Math.min(100000, Math.max(1, Number(args.n) || 5000));
const PARALELO = Math.min(8, Math.max(1, Number(args.paralelo) || 4));
const TETO_USD = Number(args.teto) || 30;
const SIMULAR = !!args.simular;
const ANO = Number(args.ano) || new Date().getFullYear();
const CUR = (sql, params) => db.queryDatabase('movidesk_curadoria', sql, params);
const iso = (d) => (d ? new Date(d).toISOString().replace('Z', '0') : null);   // mesmo formato da importação: 2026-01-02T11:17:57.0190594

async function montarAmostra() {
  // chamados encerrados do ano na visão Suporte Técnico (classificação + categoria + equipe de suporte), em ordem pseudo-aleatória fixa
  const r = await db.query(`
    SELECT t.ticket_id::text AS id, t.subject, t.status, t.urgency, t.owner_name, t.ownerteam, t.createddate, COALESCE(t.resolved_in, t.closed_in) AS resolvido,
           COALESCE(NULLIF(btrim(o.organizacao_nome), ''), NULLIF(btrim(t.clientorganization), '')) AS organizacao
      FROM silver.ticket t
      JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = 23946 AND cf.valor_texto = 'Suporte Técnico'
      LEFT JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id
     WHERE t.createddate >= make_date($1::int, 1, 1) AND t.createddate < make_date($1::int + 1, 1, 1)
       AND t.basestatus IN ('Resolved', 'Closed') AND t.category = 'Suporte Técnico'
       AND (lower(t.ownerteam) LIKE '%suporte%' OR lower(btrim(t.ownerteam)) = 'analytics - b.i')
     ORDER BY md5(t.ticket_id::text) LIMIT $2`, [ANO, Math.ceil(N * 1.25)]);
  const ids = r.rows.map((x) => x.id);
  // já processados na Curadoria ficam de fora
  const feitos = new Set((await CUR(`SELECT ticket_id::text AS id FROM public.curadoria_chamados WHERE processado = 1 AND ticket_id = ANY($1::bigint[])`, [ids])).rows.map((x) => x.id));
  const clientes = new Map();
  for (let i = 0; i < ids.length; i += 3000) {
    (await db.query(`SELECT DISTINCT ON (ticket_id) ticket_id::text AS id, nome FROM silver.ticket_cliente WHERE ticket_id = ANY($1::bigint[]) AND COALESCE(email, '') NOT ILIKE '%@viasoft.com.br' ORDER BY ticket_id, nome`, [ids.slice(i, i + 3000)]))
      .rows.forEach((x) => clientes.set(x.id, x.nome));
  }
  const acoes = new Map();
  for (let i = 0; i < ids.length; i += 1500) {
    const a = await db.query(`SELECT ticket_id::text AS id, tipo, origem, status, descricao, criado_em FROM silver.ticket_acao WHERE ticket_id = ANY($1::bigint[]) ORDER BY ticket_id, criado_em, acao_id`, [ids.slice(i, i + 1500)]);
    for (const x of a.rows) { if (!acoes.has(x.id)) acoes.set(x.id, []); acoes.get(x.id).push(x); }
  }
  const amostra = [];
  for (const t of r.rows) {
    if (feitos.has(t.id)) continue;
    const lista = acoes.get(t.id) || [];
    if (lista.length < 2) continue;   // sem conversa não há o que diagnosticar
    const actions = JSON.stringify(lista.map((x, i) => ({ id: i + 1, type: x.tipo, origin: x.origem, status: x.status, createdDate: iso(x.criado_em), description: x.descricao || '' })));
    amostra.push({ ticket_id: t.id, servico: t.subject || '', owner: t.owner_name || null, solicitante: clientes.get(t.id) || null, urgencia: t.urgency || null,
      aberto_em: iso(t.createddate), resolvido_em: iso(t.resolvido), actions, status: t.status, organizacao: t.organizacao, owner_team: t.ownerteam });
    if (amostra.length >= N) break;
  }
  return amostra;
}

async function gravarNaCuradoria(lote) {
  for (let i = 0; i < lote.length; i += 200) {
    const p = lote.slice(i, i + 200);
    await CUR(`
      INSERT INTO public.curadoria_chamados (ticket_id, servico, owner, solicitante, urgencia, aberto_em, resolvido_em, actions, status, organizacao, owner_team, processado)
      SELECT u.id::bigint, u.servico, u.owner, u.solicitante, u.urgencia, u.aberto_em, u.resolvido_em, u.actions, u.status, u.organizacao, u.owner_team, 0
        FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
          AS u(id, servico, owner, solicitante, urgencia, aberto_em, resolvido_em, actions, status, organizacao, owner_team)
      ON CONFLICT (ticket_id) DO UPDATE SET servico = EXCLUDED.servico, owner = EXCLUDED.owner, solicitante = EXCLUDED.solicitante, urgencia = EXCLUDED.urgencia,
        aberto_em = EXCLUDED.aberto_em, resolvido_em = EXCLUDED.resolvido_em, actions = EXCLUDED.actions, status = EXCLUDED.status,
        organizacao = EXCLUDED.organizacao, owner_team = EXCLUDED.owner_team, processado = 0
        WHERE public.curadoria_chamados.processado IS DISTINCT FROM 1`,
      ['ticket_id', 'servico', 'owner', 'solicitante', 'urgencia', 'aberto_em', 'resolvido_em', 'actions', 'status', 'organizacao', 'owner_team'].map((k) => p.map((x) => x[k] == null ? null : String(x[k]))));
  }
}

async function custoDesde(t0) {
  const r = await db.query(`SELECT COALESCE(SUM(estimated_cost_usd), 0)::float AS usd, COUNT(*)::int AS n FROM ai_usage_log WHERE source = 'curadoria_processamento' AND created_at >= $1`, [t0]);
  return r.rows[0];
}

(async () => {
  console.log(`[amostra] ano ${ANO}: até ${N} chamados de Suporte Técnico, ${PARALELO} em paralelo, teto de US$ ${TETO_USD}${SIMULAR ? ' (simulação: nada é gravado nem enviado à IA)' : ''}`);
  if (typeof curadoria.processOneCuradoriaTicket !== 'function') throw new Error('processOneCuradoriaTicket não está exportado por routes/curadoria.js');
  const amostra = await montarAmostra();
  console.log(`[amostra] ${amostra.length} chamados montados (com pelo menos 2 ações, ainda não processados)`);
  const meses = {}; amostra.forEach((x) => { const m = String(x.aberto_em).slice(0, 7); meses[m] = (meses[m] || 0) + 1; });
  console.log('[amostra] por mês de abertura:', JSON.stringify(meses));
  if (SIMULAR || !amostra.length) { console.log('[amostra] FIM (nada processado)'); process.exit(0); }

  await gravarNaCuradoria(amostra);
  console.log('[amostra] chamados gravados na base da Curadoria; iniciando a IA');
  const t0 = new Date(Date.now() - 2000).toISOString();
  let proximo = 0, feitos = 0, falhas = 0, seguidas = 0, parar = false;
  const erros = {};
  const trabalhar = async () => {
    while (!parar) {
      const i = proximo++; if (i >= amostra.length) return;
      const row = amostra[i];
      try { await curadoria.processOneCuradoriaTicket({ ...row, fato: null, causa: null, modulo_x_rotina: null }); feitos++; seguidas = 0; }
      catch (e) {
        falhas++; seguidas++;
        const msg = String(e.message || e).slice(0, 90); erros[msg] = (erros[msg] || 0) + 1;
        if (seguidas >= 25) { console.log('[amostra] 25 falhas seguidas: parando para não gastar à toa'); parar = true; }
      }
      if ((feitos + falhas) % 100 === 0) {
        const c = await custoDesde(t0);
        console.log(`[amostra] ${feitos + falhas}/${amostra.length} — ok ${feitos}, falhas ${falhas}, gasto US$ ${c.usd.toFixed(2)} (${c.n} chamadas)`);
        if (c.usd > TETO_USD) { console.log(`[amostra] teto de US$ ${TETO_USD} atingido: parando`); parar = true; }
      }
    }
  };
  await Promise.all(Array.from({ length: PARALELO }, trabalhar));

  const c = await custoDesde(t0);
  console.log(`[amostra] FIM — ok ${feitos}, falhas ${falhas}, gasto total US$ ${c.usd.toFixed(2)} em ${c.n} chamadas (média US$ ${(c.usd / Math.max(1, c.n)).toFixed(4)} por chamada)`);
  if (falhas) console.log('[amostra] motivos das falhas:', JSON.stringify(Object.entries(erros).sort((a, b) => b[1] - a[1]).slice(0, 5)));
  const ids = amostra.map((x) => x.ticket_id);
  const top = await CUR(`SELECT COALESCE(NULLIF(btrim(causa_normalizada::text), ''), NULLIF(btrim(causa::text), '')) AS causa, COUNT(*)::int AS n FROM public.curadoria_chamados WHERE processado = 1 AND ticket_id = ANY($1::bigint[]) GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [ids]);
  console.log('[amostra] causas mais frequentes:'); top.rows.forEach((x) => console.log(`   ${String(x.n).padStart(5)}  ${x.causa}`));
  process.exit(0);
})().catch((e) => { console.log('[amostra] erro fatal:', e.message); process.exit(1); });
