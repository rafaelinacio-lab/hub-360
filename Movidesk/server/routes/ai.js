const express = require('express');
const fetch = require('node-fetch');
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');
const { decryptToken } = require('../utils/crypto');
const { rateLimit } = require('../utils/rateLimit');
const router = express.Router();
router.use(authMiddleware, requireTabAccess('chamados'), rateLimit({ limit: 30 }));
const active = new Set();

router.post('/chat', async (req, res) => {
  const { kind, messages } = req.body || {};
  if (!['competencias', 'narrativa'].includes(kind) || !Array.isArray(messages) ||
      messages.length !== 2 || messages[0]?.role !== 'system' || messages[1]?.role !== 'user' ||
      messages.some(m => typeof m.content !== 'string' || !m.content.trim() || m.content.length > 24000)) {
    return res.status(400).json({ error: 'Solicitação de análise inválida' });
  }
  if (active.has(req.user.id)) return res.status(429).json({ error: 'Aguarde sua análise em andamento' });
  active.add(req.user.id);
  try {
    const config = await db.query('SELECT value FROM config WHERE key = $1', ['openai_api_key']);
    if (!config.rows[0]) return res.status(503).json({ error: 'Configure a chave da IA' });
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decryptToken(config.rows[0].value)}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages,
        temperature: kind === 'competencias' ? 0 : 0.3,
        max_tokens: kind === 'competencias' ? 1600 : 700,
        ...(kind === 'competencias' ? { response_format: { type: 'json_object' } } : {}) })
    });
    if (!response.ok) return res.status(502).json({ error: 'O provedor de IA não concluiu a análise' });
    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) return res.status(502).json({ error: 'Resposta da IA vazia' });
    const input = Number(data.usage?.prompt_tokens) || 0;
    const output = Number(data.usage?.completion_tokens) || 0;
    await db.query(`INSERT INTO ai_usage_log (source, model, input_tokens, output_tokens, total_tokens, estimated_cost_usd, user_email)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [kind === 'competencias' ? 'competencias_curadoria' : 'team_narrative_curadoria', 'gpt-4o-mini', input, output, input + output,
      (input * 0.15 + output * 0.6) / 1000000, req.user.email]);
    res.json({ choices: data.choices });
  } catch (error) {
    console.error('Análise IA falhou:', error.type || error.code || 'erro interno');
    res.status(502).json({ error: 'Não foi possível concluir a análise; tente novamente' });
  } finally { active.delete(req.user.id); }
});
module.exports = router;
