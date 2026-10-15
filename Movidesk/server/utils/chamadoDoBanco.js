'use strict';
// Chamado lido do banco (silver.ticket, ticket_acao, ticket_cliente) no MESMO formato de lerTicketAoVivo (routes/ticket-workspace.js),
// para a análise do cliente por IA: leitura em milissegundos, sem depender do Movidesk (nem do proxy, nem da cota de 150 chamadas por minuto).
// Devolve null quando o banco não tem a informação (chamado ausente ou sem nenhuma ação) — aí quem chama busca ao vivo no Movidesk.
// Não traz anexos nem imagens (só existem no Movidesk), o que a análise não usa.
const db = require('../db/remote');

const norm = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Muitas ações antigas (anteriores ao ajuste do carregador de 25/09/2026) estão sem o perfil do autor (criado_por_profile_type nulo).
// O perfil é o que separa CLIENTE de EQUIPE na conversa que a IA lê, então ele é reconstruído: 1º pelo perfil que a mesma pessoa tem nas demais
// ações dos últimos 180 dias (o mais frequente); 2º pelo nome entre os clientes do próprio chamado. Guardado 30 min em memória.
let _perfis = { ate: 0, mapa: null };
async function perfisConhecidos() {
  if (_perfis.mapa && Date.now() < _perfis.ate) return _perfis.mapa;
  const r = await db.query(`
    SELECT criado_por_nome AS nome, mode() WITHIN GROUP (ORDER BY criado_por_profile_type) AS pt
      FROM silver.ticket_acao
     WHERE criado_em > NOW() - INTERVAL '180 days' AND criado_por_profile_type IS NOT NULL AND COALESCE(criado_por_nome, '') <> ''
     GROUP BY 1`);
  const mapa = new Map(r.rows.map((x) => [norm(x.nome), Number(x.pt)]));
  _perfis = { ate: Date.now() + 30 * 60 * 1000, mapa };
  return mapa;
}

async function lerChamadoDoBanco(id) {
  const t = (await db.query(`
    SELECT ticket_id::text AS id, subject, status, basestatus, justification, createddate, last_update, ownerteam, service_full, owner_id, owner_name, detalhes_em
      FROM silver.ticket WHERE ticket_id = $1::bigint`, [id])).rows[0];
  if (!t) return null;
  const [ac, cl] = await Promise.all([
    db.query(`SELECT acao_id::text AS id, tipo, origem, criado_em, criado_por_nome, criado_por_profile_type, descricao
                FROM silver.ticket_acao WHERE ticket_id = $1::bigint ORDER BY criado_em, acao_id`, [id]),
    db.query(`SELECT DISTINCT NULLIF(btrim(COALESCE(NULLIF(btrim(nome), ''), organizacao_nome)), '') AS nome FROM silver.ticket_cliente WHERE ticket_id = $1::bigint`, [id]),
  ]);
  if (!ac.rows.length) return null;   // sem nenhuma ação no banco: não há o que analisar aqui
  const clientes = cl.rows.map((x) => x.nome).filter(Boolean), nomesCliente = new Set(clientes.map(norm));
  const conhecidos = await perfisConhecidos();
  let naoResolvidos = 0;
  const perfilDe = (a) => {
    if (a.criado_por_profile_type != null) return Number(a.criado_por_profile_type);
    const n = norm(a.criado_por_nome);
    if (!n) return null;   // ação do sistema (sem autor), como no Movidesk
    if (conhecidos.has(n)) return conhecidos.get(n);   // perfil real da pessoa nas outras ações (um atendente pode abrir chamado em nome do cliente)
    if (nomesCliente.has(n)) return 2;
    if (a.tipo !== 1 && Number(a.tipo) !== 1) naoResolvidos++;   // resposta pública de alguém que não se consegue classificar
    return null;
  };
  const montado = {
    id: t.id,
    assunto: t.subject,
    status: t.status,
    baseStatus: t.basestatus,
    justificativa: t.justification || null,
    criadoEm: t.createddate,
    atualizadoEm: t.last_update,
    equipe: t.ownerteam || null,
    servico: String(t.service_full || '').split('>')[0].trim() || null,
    responsavel: t.owner_name ? { id: String(t.owner_id || ''), nome: t.owner_name } : null,
    clientes,
    acoes: ac.rows.map((a) => ({
      id: a.id,
      tipo: Number(a.tipo) === 2 ? 'publica' : 'interna',
      origem: a.origem,
      criadoEm: a.criado_em,
      autor: a.criado_por_nome || '—',
      autorPerfil: perfilDe(a),
      texto: a.descricao || '',
      anexos: [], imagens: [],
    })),
    perfisNaoResolvidos: naoResolvidos,
    fonte: 'banco',
    detalhesEm: t.detalhes_em,
  };
  // Resposta pública de alguém que não dá para classificar (cliente × equipe) = informação que falta: quem chama busca ao vivo no Movidesk.
  return naoResolvidos ? null : montado;
}

module.exports = { lerChamadoDoBanco };
