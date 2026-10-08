'use strict';
/**
 * tickets-sem-organizacao.js — SOMENTE LEITURA (não altera nada no banco).
 *
 * Varre silver.ticket e lista os chamados cuja organização aparece como "Não informado" no Hub
 * (silver.ticket_organizacao sem nome), dizendo o MOTIVO de cada um:
 *   - sem cliente no chamado ............. o chamado não tem nenhum cliente em silver.ticket_cliente
 *   - organização ainda não calculada .... há cliente, mas silver.ticket_organizacao não tem linha (recalculada a cada 30 min)
 *   - cliente sem organização ............ há cliente, mas o cadastro dele no Movidesk não tem organização
 *
 * Resumo (por motivo e por ano de criação) vai para a tela (stderr); os chamados vão para a saída padrão (stdout).
 *
 * Uso (na VM, pasta Movidesk):
 *   docker compose exec -T painel node scripts/tickets-sem-organizacao.js > sem-organizacao.csv     # CSV ; completo
 *   docker compose exec -T painel node scripts/tickets-sem-organizacao.js --ids                      # só os ids, um por linha
 * Filtros opcionais: --ano=2026  --classificacao="Suporte Técnico"  --abertos  --motivo=cliente  (trecho do motivo)
 */
const db = require('../db/remote');

const CF_CLASSIFICACAO = 23946;
const ABERTOS = ['New', 'InAttendance', 'Stopped', 'InProgress'];

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));

async function main() {
  const where = [`(tc.organizacao_nome IS NULL OR btrim(tc.organizacao_nome) = '')`];
  const params = [];
  if (args.ano) { params.push(Number(args.ano)); where.push(`EXTRACT(YEAR FROM t.createddate) = $${params.length}`); }
  if (args.abertos) { params.push(ABERTOS); where.push(`t.basestatus = ANY($${params.length}::text[])`); }
  if (args.classificacao && args.classificacao !== true) { params.push(args.classificacao); where.push(`cf.classificacao = $${params.length}`); }

  const { rows: todos } = await db.query(`
    SELECT * FROM (
      SELECT t.ticket_id::text AS ticket_id, t.createddate, t.basestatus, t.ownerteam AS equipe, t.subject AS assunto,
             cf.classificacao,
             CASE
               WHEN NOT EXISTS (SELECT 1 FROM silver.ticket_cliente c WHERE c.ticket_id = t.ticket_id) THEN 'sem cliente no chamado'
               WHEN tc.ticket_id IS NULL THEN 'organização ainda não calculada'
               ELSE 'cliente sem organização'
             END AS motivo
      FROM silver.ticket t
      LEFT JOIN silver.ticket_organizacao tc ON tc.ticket_id = t.ticket_id
      LEFT JOIN LATERAL (
        SELECT valor_texto AS classificacao FROM silver.ticket_campo_customizado
        WHERE ticket_id = t.ticket_id AND custom_field_id = ${CF_CLASSIFICACAO} LIMIT 1
      ) cf ON true
      WHERE ${where.join(' AND ')}
    ) x ORDER BY createddate DESC NULLS LAST`, params);

  const rows = args.motivo && args.motivo !== true ? todos.filter(r => r.motivo.includes(args.motivo)) : todos;
  const cont = (campo) => rows.reduce((m, r) => { const k = campo(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const tab = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(7)}  ${k}`).join('\n');
  const total = (await db.query(`SELECT COUNT(*)::int AS n FROM silver.ticket`)).rows[0].n;

  console.error(`Chamados no banco: ${total.toLocaleString('pt-BR')} · sem organização${Object.keys(args).length ? ' (com os filtros)' : ''}: ${rows.length.toLocaleString('pt-BR')}`);
  console.error('\nPor motivo:\n' + tab(cont(r => r.motivo)));
  console.error('\nPor ano de criação:\n' + tab(cont(r => r.createddate ? new Date(r.createddate).getFullYear() : 'sem data')));
  console.error('\nPor classificação:\n' + tab(cont(r => r.classificacao || '(sem classificação)')));

  if (args.ids) { console.log(rows.map(r => r.ticket_id).join('\n')); return; }
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\s+/g, ' ').trim()}"`;
  console.log(['ticket_id', 'criado_em', 'status', 'classificacao', 'equipe', 'motivo', 'assunto'].join(';'));
  rows.forEach(r => console.log([r.ticket_id, r.createddate ? new Date(r.createddate).toISOString() : '', r.basestatus, r.classificacao, r.equipe, r.motivo, r.assunto].map(q).join(';')));
}

main().then(() => db.close().catch(() => {}), e => { console.error('Erro:', e.message); process.exitCode = 1; return db.close().catch(() => {}); });
