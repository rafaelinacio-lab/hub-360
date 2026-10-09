'use strict';
// Configurações → E-mail (SMTP): só admin. A senha nunca volta para a tela (só "definida ou não").
//   GET  /api/email-config          configuração atual (sem a senha)
//   PUT  /api/email-config          salva (senha em branco mantém a atual)
//   POST /api/email-config/teste    envia o e-mail de boas-vindas de exemplo para o endereço informado
const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('./auth');
const { validateEmail } = require('../utils/auth');
const { rateLimit } = require('../utils/rateLimit');
const email = require('../utils/email');
const { enviarBoasVindas } = require('../utils/emailBoasVindas');

const visao = (c) => ({ host: c.host, port: c.port, user: c.user, from: c.from, publicUrl: c.publicUrl, senhaDefinida: c.senhaDefinida, origem: c.origem, configurado: email.configurado(c) });

router.get('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try { res.json(visao(await email.carregar(true))); }
  catch (e) { console.error('GET /email-config:', e.message); res.status(500).json({ error: 'Erro ao ler a configuração de e-mail' }); }
});

router.put('/', authMiddleware, requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const porta = Number(b.port);
  if (b.port !== '' && b.port != null && (!Number.isInteger(porta) || porta < 1 || porta > 65535)) return res.status(400).json({ error: 'Porta inválida (1 a 65535).' });
  if (b.user && !validateEmail(String(b.user).trim())) return res.status(400).json({ error: 'O usuário SMTP deve ser um e-mail válido.' });
  if (b.publicUrl && !/^https?:\/\/[^\s]+$/i.test(String(b.publicUrl).trim())) return res.status(400).json({ error: 'A URL do painel deve começar com http:// ou https://.' });
  try {
    await email.salvar({ host: b.host, port: b.port, user: b.user, pass: b.pass, from: b.from, publicUrl: b.publicUrl });
    res.json(visao(await email.carregar(true)));
  } catch (e) { console.error('PUT /email-config:', e.message); res.status(500).json({ error: 'Erro ao salvar a configuração de e-mail' }); }
});

const testeLimiter = rateLimit({ name: 'email-config/teste', windowMs: 10 * 60 * 1000, max: 10, keyFn: (req) => `u:${req.user && req.user.id}` });
router.post('/teste', authMiddleware, requireRole('admin'), testeLimiter, async (req, res) => {
  const para = String((req.body || {}).para || req.user.email || '').trim().toLowerCase();
  if (!validateEmail(para)) return res.status(400).json({ error: 'Informe um e-mail de destino válido.' });
  const env = await enviarBoasVindas({ nome: req.user.name || 'Teste', email: para, perfil: 'atendente', verticais: 'Sistemas Internos' });
  if (env.ok) return res.json({ ok: true, para });
  if (env.motivo === 'nao_configurado') return res.status(400).json({ error: 'Preencha e salve o usuário e a senha antes de testar.' });
  res.status(502).json({ error: `O servidor de e-mail recusou o envio: ${String(env.detalhe || 'erro desconhecido').slice(0, 300)}` });
});

module.exports = router;
