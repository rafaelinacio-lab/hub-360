'use strict';
/**
 * aplicar-classificacao-csv.js — grava a classificação (campo 23946) e o status dos chamados conferidos no Movidesk.
 * Lê um JSON [[ticket_id, classificacao|null, status|null, base_status|null], ...] (gerado do CSV).
 * Numa transação só. Com trava: se nem todos os chamados do arquivo estiverem no banco, aborta e nada é gravado.
 * Só INSERE classificação onde o chamado não tem nenhuma; nunca troca uma existente.
 *
 * Uso (na VM, pasta Movidesk):
 *   node server/scripts/aplicar-classificacao-csv.js --arquivo=/tmp/classificacao.json            # simulação (ROLLBACK)
 *   node server/scripts/aplicar-classificacao-csv.js --arquivo=/tmp/classificacao.json --aplicar  # grava (COMMIT)
 */
const fs = require('fs');
const db = require('../db/remote');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const CF_CLASSIFICACAO = 23946;

async function main() {
  if (!args.arquivo || args.arquivo === true) throw new Error('Informe --arquivo=/caminho/classificacao.json');
  const aplicar = args.aplicar === true;
  const itens = JSON.parse(fs.readFileSync(args.arquivo, 'utf8'));
  const ids = itens.map(i => i[0]);
  const res = { lidos: itens.length, existemNoBanco: 0, classificacaoGravada: 0, jaTinhaClassificacao: 0, statusAtualizado: 0 };

  await db.withClient(async (cli) => {
    await cli.query('BEGIN');
    try {
      const existem = new Set((await cli.query(`SELECT ticket_id::bigint AS id FROM silver.ticket WHERE ticket_id::bigint = ANY($1::bigint[])`, [ids])).rows.map(r => Number(r.id)));
      res.existemNoBanco = existem.size;
      if (existem.size !== itens.length) {
        const faltam = ids.filter(id => !existem.has(Number(id)));
        throw new Error(`Trava: ${faltam.length} chamado(s) do arquivo não estão no banco (ex.: ${faltam.slice(0, 5).join(', ')}). Nada foi gravado.`);
      }
      for (const [id, cls, st, bs] of itens) {
        if (cls) {
          const r = await cli.query(
            `INSERT INTO silver.ticket_campo_customizado (ticket_id, custom_field_id, valor_texto) VALUES ($1, $2, $3)
             ON CONFLICT (ticket_id, custom_field_id) DO NOTHING`, [id, CF_CLASSIFICACAO, cls]);
          if (r.rowCount) res.classificacaoGravada++; else res.jaTinhaClassificacao++;
        }
        if (st && bs) {
          const r = await cli.query(
            `UPDATE silver.ticket SET status = $2, basestatus = $3 WHERE ticket_id::bigint = $1 AND (status IS DISTINCT FROM $2 OR basestatus IS DISTINCT FROM $3)`, [id, st, bs]);
          res.statusAtualizado += r.rowCount;
        }
      }
      const sTec = (await cli.query(`SELECT COUNT(*)::int AS n FROM silver.ticket t JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id::bigint AND cf.custom_field_id = $1 AND cf.valor_texto = 'Suporte Técnico' WHERE t.basestatus IN ('New','InAttendance','Stopped','InProgress')`, [CF_CLASSIFICACAO])).rows[0].n;
      res.suporteTecnicoAbertosDepois = sTec;
      if (aplicar) await cli.query('COMMIT'); else await cli.query('ROLLBACK');
    } catch (e) {
      await cli.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
  console.error(`${aplicar ? 'APLICADO' : 'SIMULAÇÃO (ROLLBACK)'}:`, JSON.stringify(res, null, 2));
}

main().then(() => db.close().catch(() => {}), e => { console.error('Erro:', e.message); process.exitCode = 1; return db.close().catch(() => {}); });
