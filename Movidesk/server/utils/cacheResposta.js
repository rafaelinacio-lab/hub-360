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
  registrar(chave, ttlMs, produzir);
  const { json, gz } = await obter(chave, ttlMs, produzir);
  res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding', 'Cache-Control': 'no-cache', 'X-Hub-Tamanho': String(json.length) });
  if (/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip');
    return res.send(gz);
  }
  return res.send(json);
}

// ── Aquecimento: recarrega em segundo plano o que está velho (expirou ou foi invalidado por uma gravação) enquanto a chave
// foi usada nos últimos 30 min. Assim quem abre a tela quase sempre pega a resposta pronta, sem esperar a consulta pesada.
// Os dados continuam sempre corretos: a invalidação por gravação segue valendo, só passa a ser refeita antes do próximo pedido.
const USO_MS = 30 * 60 * 1000, CICLO_MS = 45 * 1000, FOLGA_MS = 20 * 1000;
const registro = new Map();   // chave -> { ttlMs, produzir, ultimoUso }
const AQUECIVEL = /^(geral:(?!todos)|pendentes)/;   // histórico completo e filtros avulsos (sla-resp…) não são refeitos sozinhos
function registrar(chave, ttlMs, produzir, usar = true) {
  if (!AQUECIVEL.test(chave)) return;
  const r = registro.get(chave);
  registro.set(chave, { ttlMs, produzir, ultimoUso: usar ? Date.now() : (r ? r.ultimoUso : Date.now()) });
}
let aquecendo = false;
async function aquecerCiclo() {
  if (aquecendo) return;
  aquecendo = true;
  try {
    for (const [chave, r] of [...registro]) {
      if (Date.now() - r.ultimoUso > USO_MS) { registro.delete(chave); continue; }
      const e = store.get(chave);
      const velho = !e || e.versao !== versao || Date.now() - e.em >= r.ttlMs - FOLGA_MS;
      if (!velho) continue;
      try { await obter(chave, r.ttlMs, r.produzir); } catch (err) { console.warn(`[cache] aquecimento de "${chave.slice(0, 60)}" falhou:`, err.message); }
    }
  } finally { aquecendo = false; }
}
setInterval(aquecerCiclo, CICLO_MS).unref();
// Aquece uma chave já no início (ex.: ~25 s depois de o servidor subir)
function aquecer(chave, ttlMs, produzir) {
  registrar(chave, ttlMs, produzir);
  return obter(chave, ttlMs, produzir).catch((err) => console.warn('[cache] aquecimento inicial falhou:', err.message));
}

module.exports = { responder, marcarAlterado, aquecer };
