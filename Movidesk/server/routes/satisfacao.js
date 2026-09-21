'use strict';
/**
 * routes/satisfacao.js
 *
 * Painel de Pesquisa de Satisfação — usa a pesquisa real do Movidesk
 * (satisfactionSurveyResponses, modelo "smiley faces" 1-5), já sincronizada
 * pela rotina de Curadoria (ver server/routes/curadoria.js, seção
 * "Sincronização de satisfação do cliente").
 *
 * Fonte dos dados: banco secundário movidesk_curadoria.public.curadoria_chamados
 * (NÃO é silver.ticket — a pesquisa não é ingerida na apidatalake hoje, ver
 * comentário em curadoria.js linha ~987). Isso significa que o universo
 * coberto por este painel é o mesmo escopo de equipes já importado pra
 * Curadoria (Configurações → Curadoria Avançado → condições de equipe),
 * não necessariamente TODOS os tickets da empresa.
 *
 * GET /satisfacao — lista de chamados com pesquisa verificada (respondida ou não)
 */

const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');

// ===== GET /satisfacao =====
router.get('/', authMiddleware, requireTabAccess('satisfacao'), async (req, res) => {
  try {
    const [universoRes, rowsRes] = await Promise.all([
      db.queryDatabase('movidesk_curadoria', `SELECT COUNT(*)::int AS total FROM public.curadoria_chamados`)
        .catch(() => ({ rows: [{ total: 0 }] })),
      db.queryDatabase(
        'movidesk_curadoria',
        `SELECT
           ticket_id, organizacao, owner AS responsavel, owner_team AS equipe,
           servico, urgencia, status, aberto_em, resolvido_em,
           satisfacao_pesquisa AS nota,
           satisfacao_pesquisa_comentario AS comentario,
           satisfacao_pesquisa_respondido_em AS respondido_em
         FROM public.curadoria_chamados
         WHERE satisfacao_pesquisa_verificado_em IS NOT NULL
         ORDER BY satisfacao_pesquisa_respondido_em DESC NULLS LAST`
      ).catch(() => ({ rows: [] })),
    ]);

    res.json({
      universo: universoRes.rows?.[0]?.total || 0,
      rows: rowsRes.rows || [],
    });
  } catch (error) {
    if (error.message && (error.message.includes('does not exist') || error.message.includes('não existe'))) {
      console.warn('[satisfacao] curadoria_chamados ainda não existe — retornando vazio');
      return res.json({ universo: 0, rows: [] });
    }
    console.error('Erro ao buscar painel de satisfação:', error.message);
    res.status(500).json({ error: 'Erro ao carregar dados de satisfação: ' + error.message });
  }
});

module.exports = router;
