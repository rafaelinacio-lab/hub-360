'use strict';
// Acesso compartilhado à API do Movidesk para pessoas/agentes: achar o agente do usuário
// logado (pelo e-mail), listar agentes e descobrir a(s) equipe(s) dele.
const fetch = require('node-fetch');
const db = require('../db/remote');
const { getToken } = require('../routes/config');

const MOVIDESK_API = process.env.MOVIDESK_WRITE_API || 'https://apimovidesk.viasoftcloud.com.br/public/v1';
const TTL = 10 * 60 * 1000;

class MovideskError extends Error {
  constructor(status, detalhe) {
    super(`Movidesk respondeu ${status}${detalhe ? `: ${detalhe}` : ''}`);
    this.status = status;
    this.detalhe = detalhe;
  }
}

function tokenMovidesk() {
  return new Promise((resolve, reject) => getToken((err, t) => (err || !t ? reject(err || new Error('Token do Movidesk não configurado')) : resolve(t))));
}

async function movidesk(method, caminho, { query = {}, body } = {}) {
  const token = await tokenMovidesk();
  const qs = Object.entries({ token, ...query }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const resp = await fetch(`${MOVIDESK_API}${caminho}?${qs}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    timeout: 30000,
  });
  const raw = await resp.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
  if (!resp.ok) {
    const msg = (json && (json.message || json.Message || json.error)) || raw || '';
    throw new MovideskError(resp.status, String(msg).slice(0, 400));
  }
  return json;
}

const cacheAgente = new Map(); // email -> { agente, ate }
async function agenteDoUsuario(email) {
  const chave = String(email || '').trim().toLowerCase();
  if (!chave) return null;
  const c = cacheAgente.get(chave);
  if (c && c.ate > Date.now()) return c.agente;
  const safe = chave.replace(/'/g, "''");
  const lista = await movidesk('GET', '/persons', {
    query: { $select: 'id,businessName,userName,isActive,profileType,teams', $filter: `userName eq '${safe}' and isActive eq true`, $top: 5 },
  });
  const pessoa = (Array.isArray(lista) ? lista : []).find(p => p.profileType === 1 || p.profileType === 3) || null;
  const agente = pessoa
    ? { id: String(pessoa.id), nome: pessoa.businessName, teams: (Array.isArray(pessoa.teams) ? pessoa.teams : []).map(t => String(t).trim()).filter(Boolean) }
    : null;
  cacheAgente.set(chave, { agente, ate: Date.now() + TTL });
  return agente;
}

let cacheAgentes = { ate: 0, lista: [] };
async function listaAgentes() {
  if (cacheAgentes.ate > Date.now()) return cacheAgentes.lista;
  const lista = await movidesk('GET', '/persons', {
    query: { $select: 'id,businessName,userName', $filter: '(profileType eq 1 or profileType eq 3) and isActive eq true', $orderby: 'businessName', $top: 1000 },
  });
  cacheAgentes = {
    ate: Date.now() + TTL,
    lista: (Array.isArray(lista) ? lista : []).map(p => ({ id: String(p.id), nome: p.businessName, email: p.userName })),
  };
  return cacheAgentes.lista;
}

// Equipes em que a pessoa atua. 1) o cadastro dela no Movidesk (campo teams); 2) se estiver
// vazio, as equipes dos chamados que ela atendeu nos últimos 90 dias (as que concentram o
// trabalho dela); 3) sem nada disso, [] (a tela então não filtra e avisa).
const cacheEquipes = new Map(); // email -> { valor, ate }
async function equipesDoUsuario(email, nomeUsuario) {
  const chave = String(email || '').trim().toLowerCase();
  const c = cacheEquipes.get(chave);
  if (c && c.ate > Date.now()) return c.valor;

  let agente = null;
  try { agente = await agenteDoUsuario(email); } catch (e) { console.warn('[equipes] Movidesk indisponível:', e.message); }

  let valor = { equipes: [], origem: null };
  if (agente && agente.teams.length) {
    valor = { equipes: agente.teams, origem: 'movidesk' };
  } else {
    try {
      const r = agente
        ? await db.query(
            `SELECT ownerteam AS equipe, COUNT(*)::int AS n FROM silver.ticket
              WHERE owner_id = $1 AND createddate >= NOW() - INTERVAL '90 days' AND ownerteam IS NOT NULL AND ownerteam <> ''
              GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [agente.id])
        : await db.query(
            `SELECT ownerteam AS equipe, COUNT(*)::int AS n FROM silver.ticket
              WHERE lower(owner_name) = lower($1) AND createddate >= NOW() - INTERVAL '90 days' AND ownerteam IS NOT NULL AND ownerteam <> ''
              GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [nomeUsuario || '']);
      const total = r.rows.reduce((s, x) => s + x.n, 0);
      const fortes = r.rows.filter(x => x.n >= 5 && x.n / total >= 0.15).map(x => x.equipe);
      if (fortes.length) valor = { equipes: fortes, origem: 'historico' };
    } catch (e) {
      console.warn('[equipes] falha no histórico:', e.message);
    }
  }
  cacheEquipes.set(chave, { valor, ate: Date.now() + TTL });
  return valor;
}

const norm = (t) => String(t || '').trim().toLowerCase();
// Um chamado pertence à equipe/vertical quando a equipe dele É ou TERMINA/CONTÉM esse nome
// (ex.: vertical "Sistemas Internos" casa com a equipe "VIASOFT - Sistemas Internos") ou quando o
// serviço de primeiro nível dele é exatamente essa vertical.
function filtrarPorEquipes(linhas, equipes, campoEquipe, campoServico) {
  if (!equipes || !equipes.length) return linhas;
  const alvos = equipes.map(norm).filter(Boolean);
  return linhas.filter((l) => {
    const eq = norm(campoEquipe(l));
    const sv = campoServico ? norm(campoServico(l)) : '';
    return alvos.some((a) => eq === a || eq.includes(a) || sv === a);
  });
}

// Quais equipes o Dashboard deve mostrar para este usuário. A fonte é a VERTICAL cadastrada em
// Pessoas (é o que o admin mantém); só se ela estiver vazia cai no cadastro de equipes do
// Movidesk / histórico. Admin e supervisor podem pedir "todas"; atendente fica na própria
// equipe. Sem nada descoberto, não filtra.
async function escopoEquipe(user, queroTodas) {
  const r = await db.query(`SELECT u.name, u.vertical, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [user.id]);
  const { name, role, vertical } = r.rows[0] || {};
  const info = vertical && String(vertical).trim()
    ? { equipes: [String(vertical).trim()], origem: 'vertical' }
    : await equipesDoUsuario(user.email, name);
  const podeVerTodas = ['admin', 'supervisor'].includes(role);
  const filtrar = info.equipes.length > 0 && !(queroTodas && podeVerTodas);
  return { equipes: info.equipes, origem: info.origem, podeVerTodas, filtrar, role };
}

module.exports = { MovideskError, movidesk, agenteDoUsuario, listaAgentes, equipesDoUsuario, escopoEquipe, filtrarPorEquipes };
