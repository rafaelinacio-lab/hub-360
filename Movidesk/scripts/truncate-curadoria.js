#!/usr/bin/env node
/**
 * truncate-curadoria.js
 *
 * Apaga TODOS os registros de movidesk_curadoria.public.curadoria_chamados.
 * Use com cuidado — operação irreversível.
 *
 * Uso:
 *   node scripts/truncate-curadoria.js
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'server', 'db', 'remote'));

async function main() {
  // Conta antes
  const before = await db.queryDatabase(
    'movidesk_curadoria',
    'SELECT COUNT(*) AS total FROM public.curadoria_chamados'
  );
  const total = Number(before.rows[0].total);
  console.log(`Registros encontrados: ${total}`);

  if (total === 0) {
    console.log('Tabela já está vazia. Nada a fazer.');
    return;
  }

  console.log('Executando TRUNCATE...');
  await db.queryDatabase(
    'movidesk_curadoria',
    'TRUNCATE TABLE public.curadoria_chamados RESTART IDENTITY'
  );

  // Confirma
  const after = await db.queryDatabase(
    'movidesk_curadoria',
    'SELECT COUNT(*) AS total FROM public.curadoria_chamados'
  );
  console.log(`✅ Concluído. Registros restantes: ${after.rows[0].total}`);
}

main()
  .then(async () => { await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error('❌ Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
