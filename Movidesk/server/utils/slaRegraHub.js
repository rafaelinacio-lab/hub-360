'use strict';
// Régua de SLA do Hub no servidor (Painel TV) — ESPELHA a do Painel Geral (pages/geral.html: contaNoSla,
// equipeContaNoSla, EQUIPES_SLA_EXCECAO, META_SOLUCAO_H, elegivelSla, dentroSla). Mudou lá, mude aqui (e vice-versa).
//   elegível = classificação Suporte Técnico + equipe de suporte (nome com "Suporte" ou exceção) + sem cliente excluído
//              (sla_fora_cliente) + urgência com meta;
//   tempo    = minutos úteis líquidos da política de SLA (janela, sem fim de semana/feriado/pausa — slaPolitica);
//   dentro   = tempo ≤ meta da urgência.
const P = require('./slaPolitica');

const META_H = { 'Crítica': 4, 'Alta': 8, 'Média': 16, 'Baixa': 24 };
const EQUIPES_EXCECAO = ['analytics - b.i'];   // contam mesmo sem "Suporte" no nome (pedido do usuário, 08/10/2026)

// Equipes "FRANQUIA - …" (Prodacon, MP Agrotech, GO UP, Borges e Mazete, Link) não entram no SLA do Hub (pedido do usuário, 14/10/2026).
const ehFranquia = (e) => /^franquia\b/.test(e);
const equipeContaNoSla = (nome) => {
  const e = String(nome || '').trim().toLowerCase();
  return !ehFranquia(e) && (/suporte/.test(e) || EQUIPES_EXCECAO.includes(e));
};
// Responsáveis fora do SLA da equipe Sistemas Internos (pedido do usuário, 14/10/2026): Edson Matana e Gustavo Felipe Lattmann. Só vale nos
// chamados atendidos na equipe Sistemas Internos (nas outras equipes deles o SLA conta normalmente). Chave: id do responsável (ou o nome).
const SI_FORA_IDS = ['30688RR', '31729R'];
const SI_FORA_NOMES = ['edson matana', 'gustavo felipe lattmann'];
const foraPorResponsavel = (equipe, nome, id) => /sistemas internos/i.test(String(equipe || ''))
  && (SI_FORA_IDS.includes(String(id == null ? '' : id)) || SI_FORA_NOMES.includes(P.semAcento(nome)));
const sqlSiFora = (colEquipe, colOwnerId) =>
  `(lower(COALESCE(${colEquipe}, '')) LIKE '%sistemas internos%' AND COALESCE(${colOwnerId}::text, '') IN (${SI_FORA_IDS.map((i) => `'${i}'`).join(',')}))`;
const metaDe = (urgencia) => (META_H[urgencia] != null ? META_H[urgencia] : null);
// Linha no formato do LIST_SELECT do Painel Geral (classificacao, equipe, urgencia, sla_fora_cliente).
const elegivel = (r) => String(r.classificacao || '').trim() === 'Suporte Técnico'
  && equipeContaNoSla(r.equipe) && !r.sla_fora_cliente && metaDe(r.urgencia) != null
  && !foraPorResponsavel(r.equipe, r.responsavel || r.owner_name, r.dono || r.owner_id);

// Mesma regra em SQL (para agregações no banco). col* = expressões das colunas.
const sqlEquipeConta = (col) =>
  `(lower(btrim(COALESCE(${col}, ''))) NOT LIKE 'franquia%' AND (lower(btrim(COALESCE(${col}, ''))) LIKE '%suporte%' OR lower(btrim(COALESCE(${col}, ''))) IN (${EQUIPES_EXCECAO.map(e => `'${e}'`).join(',')})))`;
const sqlMetaH = (col) =>
  `(CASE ${col} ${Object.entries(META_H).map(([u, h]) => `WHEN '${u}' THEN ${h}`).join(' ')} END)`;
// Clientes que tiram o chamado do SLA (Coronel Vivida, MP Agrotech, AD Tech, ou só a Viasoft Informática como cliente).
const sqlLateralClienteFora = (alias = 't') => `
  LEFT JOIN LATERAL (
    SELECT COALESCE(BOOL_OR(x.n ~ '(VIASOFT CORONEL VIVIDA|MP AGROTECH|TECH NEGOCIOS|(^|[^A-Z])AD ?TECH)')
        OR (BOOL_OR(x.n LIKE 'VIASOFT INFORMATICA%') AND BOOL_AND(x.n LIKE 'VIASOFT%' OR x.email ILIKE '%@viasoft.com.br')), false)
        -- chamado com pedido de exclusão APROVADO por Sistemas Internos (public.sla_exclusao, utils/slaExclusao.js)
        OR EXISTS (SELECT 1 FROM public.sla_exclusao e WHERE e.ticket_id = ${alias}.ticket_id AND e.status = 'aprovado') AS fora_sla
    FROM (
      SELECT UPPER(BTRIM(COALESCE(NULLIF(BTRIM(c.organizacao_nome), ''), c.nome, ''))) AS n, c.email
      FROM silver.ticket_cliente c
      WHERE c.ticket_id = ${alias}.ticket_id
    ) x
  ) cl ON true`;

// Pendente: 'fora' (não elegível) | 'vencido' (tempo líquido já passou da meta) | 'pausado' (parado agora num status
// de pausa, ainda dentro da meta) | 'no_prazo'.
function classificarPendente({ elegivel: ok, metaH, abertoMin, pausadoAgora }) {
  if (!ok || metaH == null) return 'fora';
  if (abertoMin != null && abertoMin / 60 > metaH) return 'vencido';
  if (pausadoAgora) return 'pausado';
  return 'no_prazo';
}

// Preenche sla_aberto_min, sla_hub e sla_meta_h em linhas de pendentes (ticket_id, criado_em, status_movidesk + campos
// de elegível). eventosPorId: Map(id -> [{em, status}]) já ordenados; cfg: configuração da política.
function marcarPendentes(rows, eventosPorId, cfg, agora = new Date()) {
  const pausas = new Set(cfg.pausas.map(P.semAcento));
  for (const r of rows) {
    const ev = eventosPorId.get(String(r.ticket_id)) || [];
    if (r.criado_em) r.sla_aberto_min = P.minutosLiquidos(r.criado_em, agora, ev, cfg);
    const ok = elegivel(r), meta = ok ? metaDe(r.urgencia) : null;
    const statusAtual = r.status_movidesk || (ev.length ? ev[ev.length - 1].status : '');
    // Visão pessoal (por responsável): mesma régua, mas sem exigir "Suporte" no nome da equipe
    const okP = String(r.classificacao || '').trim() === 'Suporte Técnico' && !r.sla_fora_cliente && metaDe(r.urgencia) != null;
    const metaP = okP ? metaDe(r.urgencia) : null;
    r.sla_hub_pessoal = classificarPendente({ elegivel: okP, metaH: metaP, abertoMin: r.sla_aberto_min, pausadoAgora: pausas.has(P.semAcento(statusAtual)) });
    r.sla_meta_h = meta;
    r.sla_meta_h_pessoal = metaP;
    r.sla_hub = classificarPendente({ elegivel: ok, metaH: meta, abertoMin: r.sla_aberto_min, pausadoAgora: pausas.has(P.semAcento(statusAtual)) });
  }
  return rows;
}

module.exports = { foraPorResponsavel, sqlSiFora, META_H, EQUIPES_EXCECAO, equipeContaNoSla, metaDe, elegivel, sqlEquipeConta, sqlMetaH, sqlLateralClienteFora, classificarPendente, marcarPendentes };
