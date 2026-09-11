'use strict';
const db = require('./server/db/remote');
const { runSync, syncState } = require('./server/routes/ticket-sync');

// Mostra o conteúdo da query que o runSync usa
const fs = require('fs');
const src = fs.readFileSync(require.resolve('./server/routes/ticket-sync'), 'utf8');
const match = src.match(/SELECT ticket_id[\s\S]*?ORDER BY criado_em DESC/);
console.log('=== Query em ticket-sync.js ===');
console.log(match ? match[0] : '(não encontrada — arquivo diferente do esperado)');
console.log('');

// Testa a query diretamente
db.queryDatabase('movidesk_tickets',
  `SELECT ticket_id FROM public.ouvidoria
   WHERE sincronizado_em IS NULL
      OR base_status IS NULL
      OR base_status NOT IN ('Closed','Resolved','Cancelled','Cancelado','Fechado','Resolvido')
   ORDER BY criado_em DESC`
).then(r => {
  console.log('=== Resultado da query manual ===');
  console.log('Linhas encontradas:', r.rows.length);
  if (r.rows.length) console.table(r.rows.slice(0, 5));

  // Inicia o sync
  return runSync('ouvidoria', 'movidesk_tickets', 'public.ouvidoria');
}).then(state => {
  console.log('\nSync state inicial:', JSON.stringify(state));
  return new Promise(resolve => setTimeout(resolve, 8000));
}).then(() => {
  const s = syncState.ouvidoria;
  console.log('=== Sync após 8s ===');
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}).catch(e => {
  console.error('ERRO:', e.message, e.stack);
  process.exit(1);
});
