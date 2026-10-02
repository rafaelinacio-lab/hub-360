'use strict';
// Escopo por vertical (a definida em Pessoas, coluna users.vertical) para GCC e Satisfação.
// Admin vê tudo; os demais perfis veem só a própria vertical. Sem vertical definida = não vê nada (e a tela avisa).
const db = require('../db/remote');

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
// "A; B" -> ['A','B'] (um usuário pode participar de várias verticais)
const listaVerticais = (v) => [...new Set(String(v == null ? '' : v).split(/[;|]/).map((x) => x.trim()).filter(Boolean))];
const primeiroNivel = (s) => String(s || '').split(' > ')[0];

async function escopoVertical(userId) {
  const r = (await db.query(`SELECT r.name AS papel, u.vertical FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0] || {};
  const verticais = listaVerticais(r.vertical);
  return { papel: r.papel || null, verticais, vertical: verticais.length ? verticais.join(', ') : null, filtrar: r.papel !== 'admin', semVertical: r.papel !== 'admin' && !verticais.length };
}

// Um item pertence à vertical se o campo "vertical" ou o 1º nível do serviço bate (sem acento/maiúsculas),
// ou — quando informada — a equipe contém o nome da vertical.
function pertence(verticais, { vertical: v, servico, equipe } = {}) {
  const lista = Array.isArray(verticais) ? verticais : listaVerticais(verticais);
  return lista.some((vert) => {
    const alvo = norm(vert);
    if (!alvo) return false;
    if (v && norm(v) === alvo) return true;
    if (servico && norm(primeiroNivel(servico)) === alvo) return true;
    if (equipe && norm(equipe).includes(alvo)) return true;
    return false;
  });
}

module.exports = { escopoVertical, pertence, norm, primeiroNivel, listaVerticais };
