'use strict';
// Configurações → Tokens (somente admin): ver o estado, trocar, remover e testar os tokens/credenciais do Hub sem mexer em código.
//  GET  /tokens             — lista (nunca devolve o valor, só prévia mascarada e a origem: banco | ambiente | nenhuma)
//  PUT  /tokens/:chave      — grava (criptografado) · DELETE /tokens/:chave — remove do banco (volta a valer o .env)
//  POST /tokens/:chave/testar — confere o token na API de origem
const express = require('express');
const fetch = require('node-fetch');
const { authMiddleware, requireRole } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const seg = require('../utils/segredos');

const router = express.Router();
router.use(authMiddleware, requireRole('admin'));
const limiteTeste = rateLimit({ name: 'tokens/testar', windowMs: 10 * 60 * 1000, max: 30 });
const limiteEscrita = rateLimit({ name: 'tokens/escrever', windowMs: 10 * 60 * 1000, max: 40 });
const chaveOk = (req, res, next) => (seg.porChave[req.params.chave] ? next() : res.status(404).json({ error: 'Token desconhecido' }));

router.get('/', async (req, res) => {
  try { res.json({ tokens: await seg.status(), aviso: 'A ENCRYPTION_KEY (que protege os valores salvos) só pode ser trocada no .env do servidor; trocá-la sem regravar os tokens os deixa ilegíveis.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:chave', chaveOk, limiteEscrita, async (req, res) => {
  try {
    await seg.definir(req.params.chave, req.body && req.body.valor);
    console.log(`[tokens] "${req.params.chave}" alterado por ${req.user && req.user.email ? req.user.email : 'admin'}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:chave', chaveOk, limiteEscrita, async (req, res) => {
  try {
    await seg.remover(req.params.chave);
    console.log(`[tokens] "${req.params.chave}" removido por ${req.user && req.user.email ? req.user.email : 'admin'}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const semSegredo = (txt, valor) => String(txt || '').split(valor).join('••••').slice(0, 200);
router.post('/:chave/testar', chaveOk, limiteTeste, async (req, res) => {
  const reg = seg.porChave[req.params.chave];
  if (!reg.teste) return res.status(400).json({ error: 'Este item não tem teste automático.' });
  const valor = await seg.obter(reg.chave);
  if (!valor) return res.status(400).json({ ok: false, error: 'Nada configurado para testar.' });
  const t0 = Date.now();
  try {
    let r;
    if (reg.teste === 'movidesk') {
      const base = (process.env.MOVIDESK_API_BASE || 'https://apimovidesk.viasoftcloud.com.br').replace(/\/$/, '');
      r = await fetch(`${base}/public/v1/persons?token=${encodeURIComponent(valor)}&$top=1&$select=id`, { timeout: 20000 });
    } else if (reg.teste === 'openai') {
      r = await fetch(`${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${valor}` }, timeout: 20000 });
    } else if (reg.teste === 'datalake') {
      const url = (await seg.obter('datalake_api_url')).replace(/\/+$/, '');
      if (!url) return res.status(400).json({ ok: false, error: 'Configure também o endereço da apidatalake.' });
      r = await fetch(`${url}/legacy/tickets?limit=1`, { headers: { Authorization: `Bearer ${valor}` }, timeout: 20000 });
    }
    const ms = Date.now() - t0;
    if (r.ok) return res.json({ ok: true, mensagem: `Funcionando (${ms} ms).` });
    const corpo = semSegredo(await r.text().catch(() => ''), valor);
    const motivo = r.status === 401 || r.status === 403 ? 'recusado — o token está errado, expirou ou não tem permissão' : `a API respondeu ${r.status}`;
    res.json({ ok: false, mensagem: `Falhou: ${motivo}.${corpo ? ' ' + corpo : ''}` });
  } catch (e) { res.json({ ok: false, mensagem: `Não consegui falar com a API: ${semSegredo(e.message, valor)}` }); }
});

module.exports = router;
