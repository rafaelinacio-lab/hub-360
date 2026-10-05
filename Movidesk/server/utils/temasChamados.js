'use strict';
/**
 * utils/temasChamados.js
 *
 * Classifica chamados em TEMAS por palavras-chave (dicionário em
 * server/data/temas-chamados.json), olhando o assunto e o texto das primeiras
 * ações do chamado. O tema do chamado é o que tiver MAIS ocorrências; empate
 * fica com o que vem primeiro no dicionário. Sem nenhuma ocorrência = sem tema.
 *
 * Os textos são dado, nunca instrução: aqui só se conta ocorrência de palavra.
 */

const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'data', 'temas-chamados.json');

function normalizar(texto) {
  return String(texto || '')
    .replace(/<[^>]+>/g, ' ')            // tira HTML das descrições
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#\d+;/g, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Palavra curta (até 4 letras) só casa inteira; as maiores casam pelo início.
function regexDaPalavra(palavra) {
  const p = escaparRegex(normalizar(palavra).trim());
  return palavra.length <= 4 ? `\\b${p}\\b` : `\\b${p}`;
}

let _catalogo = null;
function carregarCatalogo() {
  if (_catalogo) return _catalogo;
  const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  _catalogo = (bruto.temas || []).map(t => ({
    tema: t.tema,
    cor: t.cor || '#94a3b8',
    regex: new RegExp((t.palavras || []).map(regexDaPalavra).join('|'), 'g'),
  })).filter(t => t.tema && t.regex.source);
  return _catalogo;
}

/** Lista de temas para o front (nome + cor). */
function listarTemas() {
  return carregarCatalogo().map(t => ({ tema: t.tema, cor: t.cor }));
}

/** Tema principal do texto, ou null. */
function classificarTexto(texto) {
  const alvo = normalizar(texto);
  let melhor = null;
  let max = 0;
  for (const t of carregarCatalogo()) {
    const n = (alvo.match(t.regex) || []).length;
    if (n > max) { max = n; melhor = t.tema; }
  }
  return melhor;
}

module.exports = { classificarTexto, listarTemas, normalizar };
