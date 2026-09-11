'use strict';
const db = require('./server/db/remote');
const { runSync, syncState } = require('./server/routes/ticket-sync');

db.queryDatabase('movidesk_tickets',
  `SELECT
     COUNT(*)                                        AS total,
     COUNT(*) FILTER (WHERE sincronizado_em IS NULL) AS nunca_sync,
     COUNT(*) FILTER (WHERE base_status IS NULL)     AS sem_status,
     COUNT(*) FILTER (WHERE base_status IS NOT NULL) AS com_status
   FROM public.ouvidoria`
).then(r => {
  console.log('=== Estado da tabela ouvidoria ===');
  console.table(r.rows);

  return runSync('ouvidoria', 'movidesk_tickets', 'public.ouvidoria');
}).then(state => {
  console.log('Sync iniciado:', JSON.stringify(state));

  return new Promise(resolve => setTimeout(resolve, 8000));
}).then(() => {
  const s = syncState.ouvidoria;
  console.log('=== Sync (8s depois) ===');
  console.log(JSON.stringify(s, null, 2));
  if (!s.running) { process.exit(0); }

  return new Promise(resolve => setTimeout(resolve, 30000));
}).then(() => {
  console.log('=== Sync (38s depois) ===');
  console.log(JSON.stringify(syncState.ouvidoria, null, 2));
  process.exit(0);
}).catch(e => {
  console.error('ERRO:', e.message, e.stack);
  process.exit(1);
});
