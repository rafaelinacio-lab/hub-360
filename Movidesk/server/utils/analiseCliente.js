'use strict';
// Análise do cliente por IA (sentimento, urgência, risco de churn, sinais e recomendações) de UM chamado.
// Usada pela Central do chamado (rota POST /:id/workspace/ia/cliente) e pelas Automações (nota interna automática).
// Lê o chamado do banco (silver.*); só busca ao vivo (função `aoVivo`, opcional) quando o banco não tem a informação.
const db = require('../db/remote');
const cfg = require('./aiSettings');
const { lerChamadoDoBanco } = require('./chamadoDoBanco');
const { chamarIA, REGRAS, dados, conversaEmTexto, limitar, dataBr } = require('./ai');

// Números do relacionamento da organização com o suporte (vêm do banco; a IA só interpreta).
async function historicoDaOrganizacao(ticketId, C) {
  const dias = Number(C.janelaDias) | 0, meses = Number(C.mesesHistorico) | 0;   // vêm de uma lista fixa validada
  const termos = C.termosGcc ? C.termosGcc.split(', ') : [];
  const h = { organizacao: null, tickets90d: null, abertosAgora: null, tickets12m: null, reabertos12m: null, tempoMedioResolucaoH: null, servicosFrequentes: [], assuntosRecentes: [], tocouGcc12m: null };
  try {
    const org = (await db.query(`SELECT organizacao_id, organizacao_nome FROM silver.ticket_organizacao WHERE ticket_id = $1`, [ticketId])).rows[0];
    if (!org || !org.organizacao_id) return h;
    h.organizacao = org.organizacao_nome;
    const base = `FROM silver.ticket t JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id::bigint WHERE o.organizacao_id = $1 AND t.ticket_id::bigint <> $2`;
    const pTermos = termos.map((x) => `%${x.replace(/[%_]/g, '')}%`);
    const r = await db.query(`
      SELECT COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${dias} days')::int AS t90,
             COUNT(*) FILTER (WHERE t.basestatus IN ('New','InAttendance','Stopped','InProgress'))::int AS abertos,
             COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${meses} months')::int AS t12,
             COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${meses} months' AND t.reopened_in IS NOT NULL)::int AS reab,
             ROUND((AVG(EXTRACT(EPOCH FROM (t.resolved_in - t.createddate)) / 3600) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${dias} days' AND t.resolved_in IS NOT NULL))::numeric, 1) AS tmr,
             COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${meses} months' AND (${termos.length ? termos.map((_, i) => `lower(COALESCE(t.ownerteam,'')) LIKE $${i + 3}`).join(' OR ') : 'FALSE'}))::int AS gcc
      ${base}`, [org.organizacao_id, ticketId, ...pTermos]);
    const x = r.rows[0] || {};
    h.tickets90d = x.t90; h.abertosAgora = x.abertos; h.tickets12m = x.t12; h.reabertos12m = x.reab;
    h.tempoMedioResolucaoH = x.tmr == null ? null : Number(x.tmr); h.tocouGcc12m = x.gcc;
    h.servicosFrequentes = (await db.query(`SELECT split_part(t.service_full, ' > ', 1) AS s, COUNT(*)::int AS n ${base} AND t.createddate >= NOW() - INTERVAL '${dias} days' AND t.service_full IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 4`, [org.organizacao_id, ticketId])).rows.map(y => `${y.s} (${y.n})`);
    h.assuntosRecentes = (await db.query(`SELECT t.subject ${base} ORDER BY t.createddate DESC LIMIT 8`, [org.organizacao_id, ticketId])).rows.map(y => limitar(y.subject, 140));
  } catch (e) { console.warn('[ia] histórico da organização indisponível:', e.message); }
  return h;
}

// Devolve null quando o chamado não existe (nem no banco nem ao vivo).
async function analisarCliente(id, { userEmail, aoVivo } = {}) {
  // A análise do cliente lê do BANCO (silver.*); só busca ao vivo no Movidesk quando o banco não tem a informação do chamado.
  let t = null;
  try { t = await lerChamadoDoBanco(id); } catch (e) { console.warn('[ia] leitura do chamado no banco falhou:', e.message); }
  if (!t && aoVivo) { t = await aoVivo(id); if (t) t.fonte = 'movidesk'; }
  if (!t) return null;
  const S = await cfg.obter(), C = S.cliente;
  const hist = await historicoDaOrganizacao(id, C);
  const system = `${REGRAS}${cfg.diretrizes(S)}
Tarefa: analisar o CLIENTE deste chamado para ajudar o atendente a conduzir o atendimento.
Considere o tom das mensagens do cliente (cordial, ansioso, irritado, ameaçando cancelar etc.), a urgência real do problema, a recorrência e o histórico de chamados da organização.
Sentimento: positivo | neutro | frustrado | irritado. Urgência percebida: baixa | media | alta. Risco de churn: baixo | medio | alto — justifique pelos sinais (reclamação repetida, menção a cancelar/concorrente, muitos chamados reabertos, passagem pelo GCC, demora). Sem sinais, não infle o risco.
Responda em JSON: {"resumo": "2 a 3 frases sobre a situação e o que o cliente precisa", "sentimento": "...", "urgencia_percebida": "...", "risco_de_churn": "...", "sinais": ["evidências curtas, citando o que o cliente disse ou os números do histórico"], "perfil_do_cliente": "1 frase (ex.: contato técnico objetivo, usuário leigo que precisa de passo a passo)", "recomendacoes": ["até 4 ações práticas para o atendente"]}${cfg.extra(C.instrucaoExtra)}`;
  const user = dados('CHAMADO', `Assunto: ${limitar(t.assunto, 300)}
Status: ${t.status} · Serviço: ${t.servico || '—'}
Cliente(s): ${t.clientes.join(', ') || '—'}
Aberto em: ${dataBr(t.criadoEm)}

Conversa:
${conversaEmTexto(t.acoes, C.contextoCaracteres)}`) + '\n\n' + dados('HISTORICO', JSON.stringify({
    organizacao: hist.organizacao, [`chamados_ultimos_${C.janelaDias}_dias`]: hist.tickets90d, chamados_abertos_agora_alem_deste: hist.abertosAgora,
    [`chamados_ultimos_${C.mesesHistorico}_meses`]: hist.tickets12m, [`reabertos_${C.mesesHistorico}_meses`]: hist.reabertos12m, tempo_medio_de_resolucao_horas: hist.tempoMedioResolucaoH,
    [`chamados_do_gcc_${C.mesesHistorico}_meses`]: hist.tocouGcc12m, servicos_mais_frequentes: hist.servicosFrequentes, assuntos_recentes: hist.assuntosRecentes,
  }, null, 1));
  const r = await chamarIA({ source: 'ticket_analise_cliente', system, user, maxTokens: 800, temperature: cfg.temperatura(C.criatividade), userEmail, meta: { ticket: id, fonte: t.fonte } });
  const pick = (v, ok, pad) => (ok.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : pad);
  return {
    resumo: limitar(r.resumo, 700),
    sentimento: pick(r.sentimento, ['positivo', 'neutro', 'frustrado', 'irritado'], 'neutro'),
    urgenciaPercebida: pick(String(r.urgencia_percebida).replace('média', 'media'), ['baixa', 'media', 'alta'], 'media'),
    riscoDeChurn: pick(String(r.risco_de_churn).replace('médio', 'medio'), ['baixo', 'medio', 'alto'], 'baixo'),
    sinais: (Array.isArray(r.sinais) ? r.sinais : []).slice(0, 6).map(x => limitar(x, 260)),
    perfil: limitar(r.perfil_do_cliente, 300),
    recomendacoes: (Array.isArray(r.recomendacoes) ? r.recomendacoes : []).slice(0, 4).map(x => limitar(x, 260)),
    historico: hist,
    fonte: t.fonte,
  };
}

module.exports = { analisarCliente, historicoDaOrganizacao };
