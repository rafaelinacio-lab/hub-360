const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const db = require('./db/remote');
const configRoutes = require('./routes/config').router;
const ticketsRoutes = require('./routes/tickets');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const pessoasRoutes = require('./routes/pessoas');
const curadoriaRoutes = require('./routes/curadoria');
const ouvidoriaRoutes = require('./routes/ouvidoria');
const gccRoutes = require('./routes/gcc');
const jiraRoutes = require('./routes/jira');
const loaderRoutes = require('./routes/loader');
const movideskLoader = require('./scripts/movidesk-loader');
const { getCuradoriaMovideskConfig } = require('./routes/config');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  // Login com Google (GSI) abre um popup pra fazer o handshake do OAuth e
  // depois avisa a janela original via postMessage. O padrão do helmet
  // (Cross-Origin-Opener-Policy: same-origin) bloqueia essa comunicação e
  // trava o popup numa tela branca em accounts.google.com/gsi/transform.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
})); // cabeçalhos de segurança HTTP
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [`http://localhost:${process.env.PORT || 3000}`],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos — só as pastas do front-end, nunca a raiz inteira
// do repositório (antes era express.static(path.join(__dirname, '../')), que
// deixava .env, package.json, scripts de debug e a planilha de curadoria
// baixáveis via HTTP por qualquer um que alcançasse o serviço).
app.use('/css', express.static(path.join(__dirname, '../css')));
app.use('/js', express.static(path.join(__dirname, '../js')));
app.use('/pages', express.static(path.join(__dirname, '../pages')));
// admin/ só tem index.html, já servido explicitamente pela rota GET /admin
// abaixo — não precisa de mount estático (e evitamos o redirect /admin → /admin/
// que express.static faria ao servir um diretório pelo path exato do mount).

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/pessoas', pessoasRoutes);
app.use('/api/curadoria', curadoriaRoutes);
app.use('/api/ouvidoria', ouvidoriaRoutes);
app.use('/api/gcc', gccRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/config', configRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/loader', loaderRoutes);

// Rota raiz
// Também respondemos em /index.html (não só "/"): as páginas em pages/*.html
// (dashboard, pessoas, movidesk, configuracoes) embutem a view antiga num
// iframe com src="../index.html?legacyView=...", que o navegador resolve
// para "/index.html" — sem esta rota extra isso dava "Cannot GET /index.html".
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});


// Rota login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../login.html'));
});
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../login.html'));
});
// Rota para admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor funcionando' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Limpeza periódica de sessões expiradas (a cada hora)
setInterval(() => {
  db.query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {});
}, 60 * 60 * 1000);

// ===== Crons desativadas a pedido — nenhuma carga roda sozinha =====
// Curadoria (carga bruta 3x/dia), o loader full/incremental (semanal/diário)
// e a carga automática de Ouvidoria + GCC (2h em 2h) foram desligados. Toda
// carga agora só roda quando disparada manualmente em Configurações → Carga
// Datalake (botões "Full agora" / "Sincronizar tickets" nas abas Ouvidoria e
// GCC). As funções continuam no código para religar facilmente se precisar
// (basta chamar setTimeout/setInterval de novo), só não são mais agendadas aqui.
//
// async function runOuvidoriaEGccLoad() {
//   console.log(`⏱️  [${new Date().toLocaleTimeString('pt-BR')}] Carga Ouvidoria automática Movidesk → datalake`);
//   try {
//     await movideskLoader.runOuvidoria();
//   } catch (e) {
//     console.error('[loader] ouvidoria auto erro:', e.message);
//   }
//
//   console.log(`⏱️  [${new Date().toLocaleTimeString('pt-BR')}] Carga GCC automática Movidesk → datalake`);
//   try {
//     await movideskLoader.runGcc();
//   } catch (e) {
//     console.error('[loader] gcc auto erro:', e.message);
//   }
// }
//
// setTimeout(runOuvidoriaEGccLoad, 10 * 1000);
// setInterval(runOuvidoriaEGccLoad, 2 * 60 * 60 * 1000);

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`⚙️  Admin: http://localhost:${PORT}/admin`);
  console.log(`\n💡 Este servidor lê os chamados exclusivamente da apidatalake — o Postgres`);
  console.log(`   local (tabela "tickets") só entra como fallback quando a apidatalake está`);
  console.log(`   indisponível. Esse fallback é alimentado à parte por`);
  console.log(`   "node scripts/sync-movidesk.js" (agendado no Windows Task Scheduler), que`);
  console.log(`   continua sendo o único lugar que fala com a API do Movidesk.\n`);
});

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n⛔ Encerrando servidor (${signal})...`);

  try {
    await db.close();
  } catch (err) {
    console.error('Erro ao fechar conexões do banco:', err.message || err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
