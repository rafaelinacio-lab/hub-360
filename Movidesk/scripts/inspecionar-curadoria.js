#!/usr/bin/env node
/**
 * inspecionar-curadoria.js
 *
 * Mostra um resumo do que está em movidesk_curadoria.public.curadoria_chamados
 * antes de qualquer operação destrutiva.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'server', 'db', 'remote'));

async function q(sql) {
  return db.queryDatabase('movidesk_curadoria', sql);
}

async function main() {
  console.log('\n📊 Diagnóstico — movidesk_curadoria.public.curadoria_chamados\n');

  // Total geral
  const total = await q('SELECT COUNT(*) AS n FROM public.curadoria_chamados');
  console.log(`Total de registros: ${total.rows[0].n}`);

  // Por processado
  const porProcessado = await q(`
    SELECT processado, COUNT(*) AS n
    FROM public.curadoria_chamados
    GROUP BY processado
    ORDER BY processado
  `);
  console.log('\nPor status de processamento:');
  porProcessado.rows.forEach(r =>
    console.log(`  processado=${r.processado ?? 'NULL'}: ${r.n} chamado(s)`)
  );

  // Por equipe (owner_team)
  const porEquipe = await q(`
    SELECT COALESCE(NULLIF(owner_team,''), '(sem equipe)') AS equipe, COUNT(*) AS n
    FROM public.curadoria_chamados
    GROUP BY equipe
    ORDER BY n DESC
    LIMIT 20
  `);
  console.log('\nPor equipe (top 20):');
  porEquipe.rows.forEach(r => console.log(`  ${r.equipe}: ${r.n}`));

  // Por ano de abertura
  const porAno = await q(`
    SELECT
      EXTRACT(YEAR FROM aberto_em) AS ano,
      COUNT(*) AS n
    FROM public.curadoria_chamados
    WHERE aberto_em IS NOT NULL
    GROUP BY ano
    ORDER BY ano DESC
  `);
  console.log('\nPor ano de abertura:');
  porAno.rows.forEach(r => console.log(`  ${r.ano ?? 'NULL'}: ${r.n}`));

  // Com satisfação pesquisa preenchida
  const comSatisfacao = await q(`
    SELECT COUNT(*) AS n FROM public.curadoria_chamados
    WHERE satisfacao_pesquisa IS NOT NULL
  `);
  console.log(`\nCom satisfação pesquisa: ${comSatisfacao.rows[0].n}`);

  // Com análise de IA (processado=1 + analise_completa preenchida)
  const comAnalise = await q(`
    SELECT COUNT(*) AS n FROM public.curadoria_chamados
    WHERE processado = 1 AND analise_completa IS NOT NULL AND analise_completa != ''
  `);
  console.log(`Com análise de IA completa: ${comAnalise.rows[0].n}`);

  // Mais antigo e mais recente
  const datas = await q(`
    SELECT
      MIN(aberto_em) AS mais_antigo,
      MAX(aberto_em) AS mais_recente
    FROM public.curadoria_chamados
  `);
  const fmt = d => d ? new Date(d).toLocaleDateString('pt-BR') : '–';
  console.log(`\nPeríodo: ${fmt(datas.rows[0].mais_antigo)} → ${fmt(datas.rows[0].mais_recente)}`);

  console.log('');
}

main()
  .then(async () => { await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error('❌ Falhou:', err.message || err);
    await db.close().catch(() => {});
    process.exit(1);
  });
