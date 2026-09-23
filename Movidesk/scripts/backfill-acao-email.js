'use strict';
/**
 * backfill-acao-email.js
 *
 * Preenche silver.ticket_acao.criado_por_email e .criado_por_profile_type
 * pros tickets do escopo GCC (ownerteam = 'GCC - Gestão de Combate ao
 * Churn' E classificação = 'Gestão de Combate ao Churn') que já foram
 * sincronizados ANTES dessas colunas existirem — o loader normal só grava
 * esses campos daqui pra frente, então o histórico já salvo fica sem eles
 * até alguém reprocessar. profileType é o campo OFICIAL do Movidesk pra
 * saber se quem criou a ação é agente (1), cliente (2) ou ambos (3) — mais
 * confiável que o "type" da própria ação.
 *
 * Uso: node scripts/backfill-acao-email.js
 */
require('dotenv').config();
const fetch = require('node-fetch');
const db = require('../server/db/remote');
const { getToken } = require('../server/routes/config');

const MOVI_BASE = 'https://apimovidesk.viasoftcloud.com.br/public/v1';
const DELAY_MS = 250;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getMovideskToken() {
  return new Promise((resolve, reject) => getToken((err, tok) => (err ? reject(err) : resolve(tok))));
}

async function fetchActions(token, ticketId) {
  const url = `${MOVI_BASE}/tickets?token=${token}&id=${ticketId}&$select=id&$expand=actions`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { timeout: 60000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const t = Array.isArray(data) ? data[0] : data;
      return t?.actions || [];
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

async function main() {
  const token = await getMovideskToken();
  const { rows: tickets } = await db.query(`
    SELECT DISTINCT t.ticket_id
    FROM silver.ticket t
    JOIN silver.ticket_campo_customizado cf_class
      ON cf_class.ticket_id = t.ticket_id
      AND cf_class.custom_field_id = 23946
      AND cf_class.valor_texto = 'Gestão de Combate ao Churn'
    JOIN silver.ticket_acao ac ON ac.ticket_id = t.ticket_id AND ac.criado_por_profile_type IS NULL
    WHERE t.ownerteam = 'GCC - Gestão de Combate ao Churn'
  `);

  console.log(`[backfill-acao] ${tickets.length} ticket(s) de GCC com ações sem profileType`);
  let ok = 0, atualizados = 0, erros = 0;

  for (const [i, row] of tickets.entries()) {
    const ticketId = row.ticket_id;
    try {
      const actions = await fetchActions(token, ticketId);
      for (const a of actions) {
        if (!a.id || !a.createdBy) continue;
        const email = a.createdBy.email || null;
        const profileType = a.createdBy.profileType != null ? Number(a.createdBy.profileType) : null;
        if (email == null && profileType == null) continue;
        const r = await db.query(
          `UPDATE silver.ticket_acao
           SET criado_por_email = COALESCE($1, criado_por_email),
               criado_por_profile_type = COALESCE($2, criado_por_profile_type)
           WHERE ticket_id = $3 AND acao_id = $4`,
          [email, profileType, ticketId, String(a.id)]
        );
        atualizados += r.rowCount || 0;
      }
      ok++;
    } catch (e) {
      erros++;
      console.error(`[backfill-acao] ticket ${ticketId} falhou: ${e.message}`);
    }
    if ((i + 1) % 50 === 0 || i === tickets.length - 1) {
      console.log(`[backfill-acao] progresso: ${i + 1}/${tickets.length} tickets — ${atualizados} ações atualizadas, ${erros} erro(s)`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`[backfill-acao] concluído: ${ok} ticket(s) ok, ${erros} erro(s), ${atualizados} ações atualizadas`);
  process.exit(0);
}

main().catch(e => { console.error('[backfill-acao] erro fatal:', e.message); process.exit(1); });
