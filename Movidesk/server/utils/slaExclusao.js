'use strict';
// Exclusão de chamados do cálculo de SLA, por chamado, com pedido do suporte e APROVAÇÃO de Sistemas Internos (ou admin).
//  - public.sla_exclusao: um registro por pedido (pendente → aprovado | recusado | cancelado | revertido); só 'aprovado' tira o chamado do SLA
//    (utils/slaRegraHub.js: sqlLateralClienteFora devolve fora_sla = true, e todo cálculo de SLA do Hub já respeita esse campo).
//  - Um chamado só pode ter UM pedido ativo (pendente ou aprovado) por vez.
const db = require('../db/remote');

const MOTIVOS = {
  cliente_interno: 'Cliente interno',
  teste: 'Chamado de teste',
  duplicado: 'Chamado duplicado',
  classificacao_errada: 'Classificação errada',
  pausa_comercial: 'Cliente pediu pausa comercial',
  outro: 'Outro (descrever)',
};

let pronto = null;
function garantirTabela() {
  if (!pronto) pronto = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS public.sla_exclusao (
      id serial PRIMARY KEY, ticket_id bigint NOT NULL, motivo text NOT NULL, obs text,
      status text NOT NULL DEFAULT 'pendente',
      solicitado_por_id integer, solicitado_por_nome text, solicitado_por_email text, solicitado_em timestamptz NOT NULL DEFAULT NOW(),
      decidido_por_nome text, decidido_em timestamptz, decisao_obs text)`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS sla_exclusao_ativo_uq ON public.sla_exclusao (ticket_id) WHERE status IN ('pendente','aprovado')`);
    await db.query(`CREATE INDEX IF NOT EXISTS sla_exclusao_status ON public.sla_exclusao (status, solicitado_em DESC)`);
  })().catch((e) => { pronto = null; throw e; });
  return pronto;
}

const norm = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
// Quem é o usuário e o que pode fazer: pedir = admin, supervisor e atendente; aprovar = admin ou vertical "Sistemas Internos" em Pessoas.
async function quemE(userId) {
  const u = (await db.query(`SELECT u.id, u.name, u.email, u.vertical, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0];
  if (!u) return null;
  const aprova = norm(u.role) === 'admin' || String(u.vertical || '').split(/[;,]/).some((v) => norm(v) === 'sistemas internos');
  const pede = ['admin', 'supervisor', 'atendente'].includes(norm(u.role)) || aprova;
  return { id: u.id, nome: u.name || u.email, email: u.email, role: u.role, aprova, pede };
}

module.exports = { MOTIVOS, garantirTabela, quemE };
