'use strict';
// Processo leitor (ver utils/leitor.js): só as rotas de leitura pesadas, na porta interna. Não roda cargas, cron nem nada de fundo
// além do que as próprias rotas já têm (aquecimento do cache do Painel Geral e do Início).
process.env.PAPEL = 'leitor';
require('dotenv').config();
const express = require('express');
const db = require('./db/remote');
const cacheResposta = require('./utils/cacheResposta');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use('/api/geral', require('./routes/geral'));
app.use('/api/inicio', require('./routes/inicio'));
app.use((err, req, res, next) => {   // mesmo tratamento de erro do principal
  console.error('[leitor] Erro:', err.type || '', err.message || err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Pedido grande demais para o servidor' });
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const porta = Number(process.env.LEITOR_PORT) || 5001;
const srv = app.listen(porta, '127.0.0.1', () => { if (process.send) process.send({ tipo: 'pronto' }); });
srv.keepAliveTimeout = 65000;

process.on('message', (m) => { if (m && m.tipo === 'invalidar') cacheResposta.marcarAlterado(); });
const sair = async () => { try { await db.close(); } catch { /* encerrando */ } process.exit(0); };
process.on('disconnect', sair);   // o principal morreu
process.on('SIGTERM', sair);
process.on('SIGINT', sair);
