'use strict';
/**
 * aplicar-organizacao-csv.js — preenche a organização de chamados que estão "Não informado" no Hub e atualiza o status deles,
 * a partir de um CSV conferido no Movidesk (colunas: ticket_id, status, base_status, cliente, cliente_email, cliente_id, organizacao, organizacao_id …).
 *
 * SEGURO POR PADRÃO: sem --aplicar só SIMULA e mostra o que mudaria. Com --aplicar grava tudo numa única transação.
 * Regras:
 *   - só mexe em chamado que existe em silver.ticket e cuja organização está VAZIA hoje (nunca sobrescreve organização preenchida);
 *   - linhas do CSV sem organização não mexem na organização (o status delas, se vier no CSV, é atualizado do mesmo jeito);
 *   - STATUS: grava status e basestatus do CSV em silver.ticket só quando diferem do banco (o CSV vem do Movidesk, que é a fonte). Datas de
 *     resolução/fechamento NÃO vêm no CSV: chamados que passam a Resolvido/Fechado sem essas datas aparecem no resumo — rode a carga/"Conferir com o Movidesk" para completá-las;
 *   - grava em silver.ticket_cliente (a fonte que a rotina de 30 min usa para recalcular silver.ticket_organizacao) e em
 *     silver.ticket_organizacao (efeito imediato). Assim a correção não é desfeita pela recalculação.
 *
 * Uso (na VM, pasta Movidesk):
 *   docker compose cp chamados_clientes_status.csv painel:/tmp/chamados.csv
 *   docker compose exec -T painel node scripts/aplicar-organizacao-csv.js --arquivo=/tmp/chamados.csv            # simulação
 *   docker compose exec -T painel node scripts/aplicar-organizacao-csv.js --arquivo=/tmp/chamados.csv --aplicar  # grava
 */
const fs = require('fs');
const db = require('../db/remote');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const LOTE = 500;

// CSV mínimo (aspas, vírgulas e quebras de linha dentro de campo entre aspas), sem dependências
function lerCsv(texto) {
  const linhas = []; let campo = '', linha = [], aspas = false;
  const t = texto.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) { if (c === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += c; }
    else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; linha.push(campo); campo = ''; if (linha.some(x => x !== '')) linhas.push(linha); linha = []; }
    else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); if (linha.some(x => x !== '')) linhas.push(linha); }
  const [cab, ...resto] = linhas;
  return resto.map(l => Object.fromEntries(cab.map((h, i) => [h.trim(), (l[i] ?? '').trim()])));
}

async function main() {
  if (!args.arquivo || args.arquivo === true) throw new Error('Informe --arquivo=/caminho/do.csv');
  const aplicar = args.aplicar === true;
  const todas = lerCsv(fs.readFileSync(args.arquivo, 'utf8'));
  const itens = new Map(), statusDe = new Map();
  let semOrg = 0, idsRuins = 0;
  const BASES = ['New', 'InAttendance', 'Stopped', 'InProgress', 'Resolved', 'Closed', 'Canceled'];
  for (const r of todas) {
    if (!/^\d{1,18}$/.test(r.ticket_id || '')) { idsRuins++; continue; }
    if (r.status && BASES.includes(r.base_status)) statusDe.set(r.ticket_id, { status: r.status, base: r.base_status });
    if (!r.organizacao || !r.organizacao_id) { semOrg++; continue; }
    itens.set(r.ticket_id, { id: r.ticket_id, org: r.organizacao, orgId: r.organizacao_id, cliente: r.cliente || null, email: r.cliente_email || null, clienteId: r.cliente_id || null });
  }
  const ids = [...new Set([...itens.keys(), ...statusDe.keys()])];
  console.error(`CSV: ${todas.length} linhas · ${itens.size} com organização · ${semOrg} sem organização (ignoradas) · ${idsRuins} com id inválido`);

  const st = { naoExiste: 0, jaTemOrg: 0, aCorrigir: 0, clienteInserido: 0, clienteAtualizado: 0, orgGravada: 0, statusMudou: 0, statusIgual: 0, fechadoSemData: 0 };
  const mudancas = {};
  const exemplos = [];
  await db.withClient(async (cli) => {
    await cli.query('BEGIN');
    try {
      for (let i = 0; i < ids.length; i += LOTE) {
        const lote = ids.slice(i, i + LOTE);
        const existe = new Set((await cli.query(`SELECT ticket_id::text AS id FROM silver.ticket WHERE ticket_id = ANY($1::bigint[])`, [lote])).rows.map(x => x.id));
        const comOrg = new Set((await cli.query(
          `SELECT ticket_id::text AS id FROM silver.ticket_organizacao WHERE ticket_id = ANY($1::bigint[]) AND NULLIF(btrim(organizacao_nome), '') IS NOT NULL`, [lote])).rows.map(x => x.id));
        const atual = new Map((await cli.query(
          `SELECT ticket_id::text AS id, status, basestatus, resolved_in, closed_in FROM silver.ticket WHERE ticket_id = ANY($1::bigint[])`, [lote])).rows.map(x => [x.id, x]));
        for (const id of lote) {
          const it = itens.get(id);
          if (!existe.has(id)) { st.naoExiste++; continue; }
          // STATUS: só grava quando difere do banco
          const novo = statusDe.get(id), at = atual.get(id);
          if (novo && at) {
            if (at.status !== novo.status || at.basestatus !== novo.base) {
              await cli.query(`UPDATE silver.ticket SET status = $2, basestatus = $3 WHERE ticket_id = $1`, [id, novo.status, novo.base]);
              st.statusMudou++;
              const k = `${at.basestatus || '(vazio)'} → ${novo.base}`; mudancas[k] = (mudancas[k] || 0) + 1;
              if (['Resolved', 'Closed'].includes(novo.base) && !at.resolved_in && !at.closed_in) st.fechadoSemData++;
            } else st.statusIgual++;
          }
          if (!it) continue;
          if (comOrg.has(id)) { st.jaTemOrg++; continue; }
          st.aCorrigir++;
          if (exemplos.length < 5) exemplos.push(`#${id} → ${it.org} (${it.orgId})`);
          // 1) silver.ticket_cliente: completa a organização do cliente do chamado (ou cria a linha, se ele não estiver lá)
          const upd = await cli.query(
            `UPDATE silver.ticket_cliente SET organizacao_id = $2, organizacao_nome = $3
             WHERE ticket_id = $1 AND NULLIF(btrim(organizacao_nome), '') IS NULL
               AND (cliente_id = $4 OR (email IS NOT NULL AND lower(email) = lower($5)) OR $4 IS NULL)`,
            [id, it.orgId, it.org, it.clienteId, it.email || '']);
          st.clienteAtualizado += upd.rowCount;
          if (!upd.rowCount) {
            const ja = await cli.query(`SELECT 1 FROM silver.ticket_cliente WHERE ticket_id = $1 AND cliente_id IS NOT DISTINCT FROM $2 LIMIT 1`, [id, it.clienteId]);
            if (!ja.rowCount) {
              await cli.query(`INSERT INTO silver.ticket_cliente (ticket_id, cliente_id, nome, email, organizacao_id, organizacao_nome) VALUES ($1,$2,$3,$4,$5,$6)`,
                [id, it.clienteId, it.cliente, it.email, it.orgId, it.org]);
              st.clienteInserido++;
            }
          }
          // 2) silver.ticket_organizacao: efeito imediato nos painéis
          await cli.query(
            `INSERT INTO silver.ticket_organizacao (ticket_id, organizacao_id, organizacao_nome, atualizado_em) VALUES ($1,$2,$3,NOW())
             ON CONFLICT (ticket_id) DO UPDATE SET organizacao_id = EXCLUDED.organizacao_id, organizacao_nome = EXCLUDED.organizacao_nome, atualizado_em = NOW()
             WHERE NULLIF(btrim(silver.ticket_organizacao.organizacao_nome), '') IS NULL`, [id, it.orgId, it.org]);
          st.orgGravada++;
        }
      }
      if (aplicar) await cli.query('COMMIT'); else await cli.query('ROLLBACK');
    } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; }
  });

  console.error(`\n${aplicar ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; use --aplicar)'}:`);
  console.error(`  chamados do CSV que não existem no banco ......... ${st.naoExiste}`);
  console.error(`  já tinham organização (não mexe) ................. ${st.jaTemOrg}`);
  console.error(`  a corrigir ....................................... ${st.aCorrigir}`);
  console.error(`    · organização gravada em silver.ticket_organizacao: ${st.orgGravada}`);
  console.error(`    · clientes completados em silver.ticket_cliente ... ${st.clienteAtualizado}`);
  console.error(`    · clientes inseridos em silver.ticket_cliente ..... ${st.clienteInserido}`);
  if (exemplos.length) console.error('  exemplos: ' + exemplos.join(' · '));
  console.error(`\nSTATUS: ${st.statusMudou} atualizados · ${st.statusIgual} já estavam iguais`);
  Object.entries(mudancas).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.error(`  ${String(v).padStart(6)}  ${k}`));
  if (st.fechadoSemData) console.error(`  atenção: ${st.fechadoSemData} passaram a Resolvido/Fechado sem data de resolução no banco — rode "Conferir com o Movidesk" / uma carga para completar as datas.`);
}

main().then(() => db.close().catch(() => {}), e => { console.error('Erro:', e.message); process.exitCode = 1; return db.close().catch(() => {}); });
