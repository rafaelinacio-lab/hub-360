const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess, getToken } = require('./config');
const fetch = require('node-fetch');
const { syncState, runSync, stopSync, backfillManifesto } = require('./ticket-sync');

// Tabela public.ouvidoria é alimentada por um processo externo (fora deste painel), que já
// grava prontos: a análise de IA (coluna `analise`), o serviço identificado da manifestação
// (servico_ouvidoria/servico_ouvidoria_nome) e os chamados de suporte do cliente que
// explicam a reincidência, com o motivo já redigido pela IA (chamados_relacionados).
// Esta rota só lê e expõe esses dados, sem cruzar com nenhuma outra base.
const OUVIDORIA_DB = 'movidesk_tickets';

const OUVIDORIA_COLUMNS = `
  ticket_id,
  organizacao,
  organizacao_id,
  assunto_ouvidoria,
  descricao_ouvidoria,
  total_chamados_anteriores,
  analise,
  chamados_organizacao_ids,
  chamados_relacionados,
  servicos_chamados,
  servico_ouvidoria,
  servico_ouvidoria_nome,
  tipo,
  criado_em,
  status_movidesk,
  base_status,
  resolvido_em,
  sincronizado_em,
  manifesto_direcionado_a
`;

// Throttle do backfill automático: no máximo 1 execução a cada 5 minutos
let _lastAutoBackfill = 0;

// ===== GET /ouvidoria =====
router.get('/', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  try {
    const result = await db.queryDatabase(
      OUVIDORIA_DB,
      `SELECT ${OUVIDORIA_COLUMNS} FROM public.ouvidoria ORDER BY criado_em DESC`
    );
    const rows = result.rows || [];
    res.json(rows);

    // Dispara backfill em background se houver tickets sem manifesto_direcionado_a
    const hasMissing = rows.some(r => !r.manifesto_direcionado_a);
    const now = Date.now();
    if (hasMissing && now - _lastAutoBackfill > 5 * 60 * 1000) {
      _lastAutoBackfill = now;
      getToken((err, token) => {
        if (!err && token) {
          backfillManifesto(token, OUVIDORIA_DB, 'public.ouvidoria')
            .catch(e => console.error('[ouvidoria] auto-backfill error:', e.message));
        }
      });
    }
  } catch (error) {
    console.error('Erro ao buscar ouvidoria:', error);
    res.status(500).json({ error: 'Erro ao carregar dados de ouvidoria' });
  }
});

// ===== GET /ouvidoria/manifesto-batch?ids=1,2,3 =====
// Busca manifesto_direcionado_a (CF 38595) na API do Movidesk para os IDs pedidos,
// salva no banco e devolve { ticketId: valor }.
const CF_MANIFESTO = 38595;
const MANIFESTO_BATCH = 10;

router.get('/manifesto-batch', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',').map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 200);
  if (!ids.length) return res.json({});

  try {
    const token = await new Promise((ok, fail) => getToken((e, t) => e ? fail(e) : ok(t)));
    const result = {};

    for (let i = 0; i < ids.length; i += MANIFESTO_BATCH) {
      const batch  = ids.slice(i, i + MANIFESTO_BATCH);
      const filter = batch.map(id => `id eq ${id}`).join(' or ');
      try {
        const resp = await fetch(
          `${MOVIDESK_TICKETS_API}?${new URLSearchParams({
            token, '$expand': 'customFieldValues', '$filter': filter, '$top': String(batch.length),
          })}`,
          { timeout: 15000 }
        );
        if (!resp.ok) continue;
        const raw  = await resp.json();
        const list = Array.isArray(raw) ? raw : (raw?.value || []);

        for (const t of list) {
          const cf = (t.customFieldValues || []).find(f => f.customFieldId === CF_MANIFESTO);
          if (!cf) continue;
          const val = (Array.isArray(cf.items) && cf.items.length
            ? cf.items.map(i => String(i.customFieldItem || i.name || i.value || '').trim()).filter(Boolean).join(', ')
            : String(cf.value || '').trim()) || null;
          if (!val) continue;
          result[String(t.id)] = val;
          db.queryDatabase(OUVIDORIA_DB,
            `UPDATE public.ouvidoria SET manifesto_direcionado_a = $2 WHERE ticket_id = $1`,
            [String(t.id), val]).catch(() => {});
        }
      } catch {}
    }
    res.json(result);
  } catch (e) {
    console.error('[manifesto-batch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== GET /ouvidoria/:ticketId =====
router.get('/:ticketId', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'ticket_id inválido' });

  try {
    const result = await db.queryDatabase(
      OUVIDORIA_DB,
      `SELECT ${OUVIDORIA_COLUMNS} FROM public.ouvidoria WHERE ticket_id = $1`,
      [ticketId]
    );
    const row = result.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Manifestação não encontrada' });
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar manifestação de ouvidoria:', error);
    res.status(500).json({ error: 'Erro ao carregar manifestação' });
  }
});

// ===== GET /ouvidoria/:ticketId/actions — ações e campos do Movidesk =====
const MOVIDESK_TICKETS_API = 'https://apimovidesk.viasoftcloud.com.br/tickets';
const MOVIDESK_FIELDS_API  = 'https://apimovidesk.viasoftcloud.com.br/customFields';

// Cache de definições de campos personalizados (válido por 1 hora)
let _cfCache = null, _cfCacheAt = 0;
async function getCustomFieldDefs(token) {
  if (_cfCache && Date.now() - _cfCacheAt < 3600000) return _cfCache;
  try {
    const resp = await fetch(`${MOVIDESK_FIELDS_API}?token=${encodeURIComponent(token)}`, { timeout: 10000 });
    if (!resp.ok) return {};
    const list = await resp.json();
    _cfCache = Object.fromEntries((Array.isArray(list) ? list : []).map(f => [String(f.id), f.name || `Campo ${f.id}`]));
    _cfCacheAt = Date.now();
    return _cfCache;
  } catch { return {}; }
}

router.get('/:ticketId/actions', authMiddleware, requireTabAccess('ouvidoria'), async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'ticket_id inválido' });
  try {
    const token = await new Promise((ok, fail) => getToken((e, t) => e ? fail(e) : ok(t)));
    const [ticketResp, fieldDefs] = await Promise.all([
      fetch(`${MOVIDESK_TICKETS_API}?${new URLSearchParams({ token, id: String(ticketId), '$expand': 'actions,customFieldValues' })}`, { timeout: 15000 }),
      getCustomFieldDefs(token),
    ]);
    if (!ticketResp.ok) return res.status(ticketResp.status).json({ error: `Movidesk devolveu ${ticketResp.status}` });
    const data = await ticketResp.json();
    res.json({
      actions: Array.isArray(data.actions) ? data.actions : [],
      customFieldValues: Array.isArray(data.customFieldValues) ? data.customFieldValues : [],
      fieldDefs,
    });
  } catch (e) {
    console.error('Erro ao buscar ações de ouvidoria:', e.message);
    res.status(500).json({ error: 'Erro ao buscar ações do chamado' });
  }
});

// ===== POST /ouvidoria/sync — inicia sincronização de andamento =====
router.post('/sync', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  const state = runSync('ouvidoria', OUVIDORIA_DB, 'public.ouvidoria');
  res.json(state);
});

// ===== POST /ouvidoria/sync/stop =====
router.post('/sync/stop', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  stopSync('ouvidoria');
  res.json(syncState.ouvidoria);
});

// ===== GET /ouvidoria/sync/status =====
router.get('/sync/status', authMiddleware, requireTabAccess('ouvidoria'), (req, res) => {
  res.json(syncState.ouvidoria);
});

router.runSync = () => runSync('ouvidoria', OUVIDORIA_DB, 'public.ouvidoria');

// Garante que as colunas de sincronização existam assim que o módulo for carregado,
// antes de qualquer SELECT que as liste.
const { ensureColumns: _ensureOuvidoria } = require('./ticket-sync');
_ensureOuvidoria(OUVIDORIA_DB, 'public.ouvidoria').catch(() => {});
db.queryDatabase(OUVIDORIA_DB,
  `ALTER TABLE public.ouvidoria ADD COLUMN IF NOT EXISTS manifesto_direcionado_a VARCHAR(200)`)
  .catch(() => {});

module.exports = router;
