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
const geralRoutes = require('./routes/geral');
const satisfacaoRoutes = require('./routes/satisfacao');
const jiraRoutes = require('./routes/jira');
const loaderRoutes = require('./routes/loader');
const cronsRoutes = require('./routes/crons');
const movideskLoader = require('./scripts/movidesk-loader');
const cronManager = require('./scripts/cron-manager');
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
app.use('/api/geral', geralRoutes);
app.use('/api/satisfacao', satisfacaoRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/config', configRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/loader', loaderRoutes);
app.use('/api/crons', cronsRoutes);

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

// ===== Cargas automáticas configuráveis =====
// As cargas (Ouvidoria/GCC/Incremental/Full) agora rodam por cron_job
// configurável no banco (silver.cron_job), gerenciadas em
// scripts/cron-manager.js e editáveis em Configurações → Cargas automáticas
// (ou via /api/crons). Nenhum setInterval fixo aqui — na primeira vez que o
// servidor sobe sem nenhum job cadastrado, semeia a cron de Ouvidoria a
// cada 2h (mesmo comportamento que já existia antes disso virar
// configurável), já habilitada; GCC/Incremental/Full ficam disponíveis pra
// quem quiser ligar pela tela, mas não são criadas automaticamente.
async function seedDefaultCronJobs() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM silver.cron_job').catch(() => ({ rows: [{ n: 1 }] }));
  if (rows[0]?.n > 0) return;
  await db.query(
    `INSERT INTO silver.cron_job (name, task, interval_minutes, enabled, params)
     VALUES ('Ouvidoria automática', 'ouvidoria', 120, true, '{}'::jsonb)`
  ).catch(e => console.error('[cron-manager] seed falhou:', e.message));
}

cronManager.ensureTable()
  .then(seedDefaultCronJobs)
  .then(() => cronManager.loadAndStartAll())
  .catch(e => console.error('[cron-manager] inicialização falhou:', e.message));

// Garante que silver.ticket (e as demais tabelas/colunas do datalake) já
// existem assim que o servidor sobe — sem isso, uma coluna nova (ex:
// sla_solution_date) só aparecia depois que alguém disparasse uma carga
// manualmente, e até lá TODAS as rotas de Ouvidoria/GCC quebravam com
// "column does not exist" e caíam silenciosamente pro fallback de "ainda
// não carregado" (dashboard inteiro zerado, sem erro visível).
movideskLoader.ensureTables().catch(e => {
  console.error('[server] ensureTables na inicialização falhou (não bloqueia o boot):', e.message);
});

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
