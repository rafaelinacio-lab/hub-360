'use strict';
// Processo "leitor": as rotas de leitura mais pesadas (Painel Geral e Início) rodam num segundo processo Node, para a montagem e a
// compressão das respostas grandes não travarem o processo principal (login, Central do chamado, cargas, abas leves).
//   - O principal (server.js) escuta na porta pública e repassa /api/geral e /api/inicio ao leitor (127.0.0.1:LEITOR_PORT).
//   - Se o leitor não estiver de pé (subindo, caiu, desligado), o principal atende a rota ele mesmo: nada deixa de funcionar.
//   - Só o principal roda cargas, cron e demais rotinas; o leitor guarda o cache do Painel Geral (a invalidação por gravação do
//     principal chega por mensagem — ver cacheResposta.marcarAlterado).
// Liga com LEITOR=1 (docker-compose.yml). Sem isso tudo continua num processo só, como antes.
const { fork } = require('child_process');
const http = require('http');
const path = require('path');

const ativo = () => process.env.LEITOR === '1' && process.env.PAPEL !== 'leitor';
const PORTA = () => Number(process.env.LEITOR_PORT) || 5001;
const agente = new http.Agent({ keepAlive: true, maxSockets: 64 });

let filho = null, pronto = false, tentativas = 0;

function iniciar() {
  if (!ativo() || filho) return;
  const f = fork(path.join(__dirname, '../leitor.js'), [], { env: { ...process.env, PAPEL: 'leitor', LEITOR_PORT: String(PORTA()) } });
  filho = f;
  f.on('message', (m) => { if (m && m.tipo === 'pronto') { pronto = true; tentativas = 0; console.log(`[leitor] pronto na porta ${PORTA()} (pid ${f.pid})`); } });
  f.on('exit', (code, sinal) => {
    pronto = false; filho = null;
    const espera = Math.min(30000, 2000 * ++tentativas);
    console.warn(`[leitor] encerrou (${sinal || code}); o principal atende sozinho. Nova tentativa em ${Math.round(espera / 1000)}s`);
    setTimeout(iniciar, espera).unref();
  });
}
process.on('exit', () => { try { if (filho) filho.kill(); } catch { /* já saiu */ } });

// A carga/Central gravaram chamados: o cache do leitor precisa ser refeito.
function invalidar() { try { if (filho && pronto) filho.send({ tipo: 'invalidar' }); } catch { /* sem leitor */ } }

// Repassa o pedido (com o corpo ainda não lido) ao leitor; sem leitor ou com erro antes de qualquer resposta, segue para a rota local.
function proxy(req, res, next) {
  if (!pronto) return next();
  const headers = { ...req.headers }; delete headers.connection;
  let respondeu = false;
  const pr = http.request({ host: '127.0.0.1', port: PORTA(), method: req.method, path: req.originalUrl, headers, agent: agente }, (r) => {
    respondeu = true;
    const h = { ...r.headers }; delete h.connection; delete h['keep-alive'];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  pr.setTimeout(120000, () => pr.destroy(new Error('tempo esgotado no leitor')));
  pr.on('error', (e) => {
    if (!respondeu) { console.warn('[leitor] falha ao repassar, atendendo no principal:', e.message); return next(); }
    res.destroy();
  });
  req.pipe(pr);
}

// require só quando o primeiro pedido chega (fallback): evita subir no principal os temporizadores que vivem no leitor.
const lazy = (carregar) => { let r; return (req, res, next) => { r = r || carregar(); return r(req, res, next); }; };

module.exports = { ativo, iniciar, invalidar, proxy, lazy };
