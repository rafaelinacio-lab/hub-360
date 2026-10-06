'use strict';
/**
 * utils/cacheResposta.js
 *
 * Cache de respostas JSON pesadas e COMPARTILHADAS entre usuários (ex.: Painel Geral), com gzip.
 *  - A resposta é serializada e comprimida uma vez; os pedidos seguintes só devolvem os bytes prontos.
 *  - Vale por `ttlMs` ou até a próxima gravação de tickets no banco (`marcarAlterado`, chamado pela carga),
 *    o que ocorrer primeiro — então uma ação na Central do chamado ou uma carga nunca deixa o painel velho.
 *  - Pedidos simultâneos da mesma chave dividem a mesma consulta (sem estouro no banco).
 *  - Só use com rotas cujo resultado NÃO depende do usuário (a autenticação continua na rota).
 */
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);

const MAX_CHAVES = 6;
const store = new Map();   // chave -> { versao, em, promessa }
let versao = 0;

function marcarAlterado() { versao++; }

function obter(chave, ttlMs, produzir) {
  const e = store.get(chave);
  if (e && e.versao === versao && Date.now() - e.em < ttlMs) return e.promessa;

  const promessa = (async () => {
    const json = Buffer.from(JSON.stringify(await produzir()));
    return { json, gz: await gzip(json, { level: 6 }) };
  })();
  const novo = { versao, em: Date.now(), promessa };
  store.delete(chave);
  store.set(chave, novo);
  while (store.size > MAX_CHAVES) store.delete(store.keys().next().value);   // descarta a mais antiga
  promessa.catch(() => { if (store.get(chave) === novo) store.delete(chave); });
  return promessa;
}

async function responder(req, res, chave, ttlMs, produzir) {
  const { json, gz } = await obter(chave, ttlMs, produzir);
  res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding', 'Cache-Control': 'no-cache' });
  if (/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip');
    return res.send(gz);
  }
  return res.send(json);
}

module.exports = { responder, marcarAlterado };
