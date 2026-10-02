'use strict';
// Escopo por vertical (a definida em Pessoas, coluna users.vertical) para GCC e Satisfação.
// Admin vê tudo; os demais perfis veem só a própria vertical. Sem vertical definida = não vê nada (e a tela avisa).
const db = require('../db/remote');

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
// "A; B" -> ['A','B'] (um usuário pode participar de várias verticais)
const listaVerticais = (v) => [...new Set(String(v == null ? '' : v).split(/[;|]/).map((x) => x.trim()).filter(Boolean))];
// Equivalências: vertical cadastrada em Pessoas -> outros nomes que ela tem nos dados (ex.: GCC grava "Agrotitan" para "Agronegócio").
// Editável por admin em Configurações → Acesso (chave `vertical_aliases`); isto é só o padrão inicial.
const ALIASES_PADRAO = { 'Agronegócio': ['Agrotitan'], 'Analytics - B.I': ['Analytics'] };
let _al = { ate: 0, mapa: null };
async function lerAliases() {
  if (_al.mapa && Date.now() < _al.ate) return _al.mapa;
  let mapa = ALIASES_PADRAO;
  try {
    const r = await db.query(`SELECT value FROM config WHERE key = 'vertical_aliases'`);
    if (r.rows[0] && r.rows[0].value) { const j = JSON.parse(r.rows[0].value); if (j && typeof j === 'object' && !Array.isArray(j)) mapa = j; }
  } catch { /* usa o padrão */ }
  _al = { ate: Date.now() + 30000, mapa };
  return mapa;
}
const limparAliases = () => { _al = { ate: 0, mapa: null }; };
const primeiroNivel = (s) => String(s || '').split(' > ')[0];

async function escopoVertical(userId) {
  const r = (await db.query(`SELECT r.name AS papel, u.vertical FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0] || {};
  const proprias = listaVerticais(r.vertical);
  const mapa = await lerAliases();
  const porNome = new Map(Object.entries(mapa).map(([k, v]) => [norm(k), v]));
  // para comparar com os dados, cada vertical vale também pelos nomes equivalentes
  const verticais = [...new Set(proprias.flatMap((v) => [v, ...(porNome.get(norm(v)) || [])]))];
  return { papel: r.papel || null, verticais, vertical: proprias.length ? proprias.join(', ') : null, filtrar: r.papel !== 'admin', semVertical: r.papel !== 'admin' && !proprias.length };
}

// Um item pertence à vertical se o campo "vertical" ou o 1º nível do serviço bate (sem acento/maiúsculas),
// ou — quando informada — a equipe contém o nome da vertical.
function pertence(verticais, { vertical: v, servico, equipe } = {}) {
  const lista = Array.isArray(verticais) ? verticais : listaVerticais(verticais);
  return lista.some((vert) => {
    const alvo = norm(vert);
    if (!alvo) return false;
    // o campo de vertical do GCC aceita vários valores juntos ("Agrotitan, Fisco Contábil")
    if (v && String(v).split(',').some((parte) => norm(parte) === alvo)) return true;
    if (servico && norm(primeiroNivel(servico)) === alvo) return true;
    if (equipe && norm(equipe).includes(alvo)) return true;
    return false;
  });
}

module.exports = { lerAliases, limparAliases, ALIASES_PADRAO, escopoVertical, pertence, norm, primeiroNivel, listaVerticais };
