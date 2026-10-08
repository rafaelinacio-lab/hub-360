'use strict';
// Tempo de solução líquido guardado por chamado (silver.ticket_sla_liquido), para o SLA do Painel Geral abrir junto
// com os outros cards em vez de calcular ~60 mil chamados no navegador a cada carregamento (08/10/2026: 31 lotes, ~20 s).
// Régua = política de SLA (Configurações → SLA e horas): só a janela de atendimento, sem fim de semana, sem feriados e
// sem o tempo nos status de pausa (slaPolitica.minutosLiquidos, a mesma de POST /geral/sla-liquido).
// Uma rodada a cada 2 min (e logo após subir) calcula quem falta: chamados de Suporte Técnico resolvidos desde
// DESDE sem linha, resolvidos de novo depois do cálculo (resolved_in mudou) ou calculados com outra configuração
// (cfg_hash ≠ assinatura atual de janela/feriados/pausas). Só lê o banco — nenhuma chamada ao Movidesk.
const crypto = require('crypto');
const db = require('../db/remote');
const P = require('./slaPolitica');
const { lerConfigEmCache } = require('./slaHorasCore');

const DESDE = '2025-01-01';
const LOTE = 2000;
const MAX_POR_RODADA = 20000;
const INTERVALO_MS = 2 * 60 * 1000;
const CF_CLASSIFICACAO = 23946;

const estado = { rodando: false, ultimaRodada: null, calculados: 0, segundos: 0, ultimoErro: null };
let _tabelaOk = false;

async function ensureTable() {
  if (_tabelaOk) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS silver.ticket_sla_liquido (
      ticket_id    bigint PRIMARY KEY,
      minutos      int,
      resolvido_em timestamptz,
      cfg_hash     text NOT NULL,
      calculado_em timestamptz NOT NULL DEFAULT NOW()
    )`);
  _tabelaOk = true;
}

// Assinatura do que muda o resultado (janela, feriados, pausas): mudou na tela → tudo é recalculado aos poucos.
const hashCfg = (cfg) => crypto.createHash('md5')
  .update(JSON.stringify({ janela: cfg.janela, feriados: cfg.feriados.map(f => f.data).sort(), pausas: [...cfg.pausas].sort() }))
  .digest('hex');

async function calcularLote(ids, cfg, hash) {
  const [t, a] = await Promise.all([
    db.query(`SELECT ticket_id::text AS id, createddate, resolved_in FROM silver.ticket WHERE ticket_id = ANY($1::bigint[])`, [ids]),
    db.query(`SELECT ticket_id::text AS id, criado_em, status FROM silver.ticket_acao
               WHERE ticket_id = ANY($1::bigint[]) AND status IS NOT NULL ORDER BY criado_em`, [ids]),
  ]);
  const eventos = new Map();
  for (const x of a.rows) {
    if (!eventos.has(x.id)) eventos.set(x.id, []);
    eventos.get(x.id).push({ em: x.criado_em, status: x.status });
  }
  const linhas = t.rows.filter(r => r.createddate && r.resolved_in).map(r => ({
    id: r.id, resolvido: r.resolved_in, min: P.minutosLiquidos(r.createddate, r.resolved_in, eventos.get(r.id) || [], cfg),
  }));
  if (!linhas.length) return 0;
  await db.query(`
    INSERT INTO silver.ticket_sla_liquido (ticket_id, minutos, resolvido_em, cfg_hash, calculado_em)
    SELECT u.id, u.min, u.res, $4, NOW() FROM unnest($1::bigint[], $2::int[], $3::timestamptz[]) AS u(id, min, res)
    ON CONFLICT (ticket_id) DO UPDATE SET minutos = EXCLUDED.minutos, resolvido_em = EXCLUDED.resolvido_em,
      cfg_hash = EXCLUDED.cfg_hash, calculado_em = EXCLUDED.calculado_em`,
  [linhas.map(l => l.id), linhas.map(l => l.min), linhas.map(l => l.resolvido), hash]);
  return linhas.length;
}

async function rodada() {
  if (estado.rodando) return estado;
  estado.rodando = true;
  const t0 = Date.now();
  try {
    await ensureTable();
    const cfg = await lerConfigEmCache();
    const hash = hashCfg(cfg);
    const { rows } = await db.query(`
      SELECT t.ticket_id::text AS id
        FROM silver.ticket t
        JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = ${CF_CLASSIFICACAO}
             AND cf.valor_texto = 'Suporte Técnico'
        LEFT JOIN silver.ticket_sla_liquido s ON s.ticket_id = t.ticket_id
       WHERE t.resolved_in >= $1
         AND (s.ticket_id IS NULL OR s.resolvido_em IS DISTINCT FROM t.resolved_in OR s.cfg_hash <> $2)
       ORDER BY t.resolved_in DESC
       LIMIT ${MAX_POR_RODADA}`, [DESDE, hash]);
    let feitos = 0;
    for (let i = 0; i < rows.length; i += LOTE) feitos += await calcularLote(rows.slice(i, i + LOTE).map(r => r.id), cfg, hash);
    Object.assign(estado, { ultimaRodada: new Date().toISOString(), calculados: feitos, segundos: Math.round((Date.now() - t0) / 1000), ultimoErro: null });
    if (feitos) console.log(`[sla-liquido] ${feitos} chamado(s) calculado(s) em ${estado.segundos}s`);
  } catch (e) {
    estado.ultimoErro = e.message;
    console.warn('[sla-liquido] rodada falhou:', e.message);
  } finally {
    estado.rodando = false;
  }
  return estado;
}

function iniciar() {
  ensureTable().catch(e => console.warn('[sla-liquido] não criou a tabela:', e.message));   // a consulta do Painel Geral faz JOIN nela
  setTimeout(() => rodada().catch(() => {}), 30 * 1000);
  setInterval(() => rodada().catch(() => {}), INTERVALO_MS);
}

module.exports = { iniciar, rodada, ensureTable, hashCfg, estado };
