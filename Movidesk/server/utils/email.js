'use strict';
// Envio de e-mail (SMTP; padrão Google Workspace). A configuração vem do banco (tabela config, chaves email_*, senha
// criptografada — Configurações → E-mail) e, na falta dela, do .env (SMTP_HOST/PORT/USER/PASS/FROM, PUBLIC_URL).
// Sem usuário e senha o envio é pulado e quem chamou recebe `nao_configurado` (o cadastro nunca falha por causa do e-mail).
const nodemailer = require('nodemailer');
const db = require('../db/remote');
const { encryptToken, decryptToken } = require('./crypto');

const CHAVES = ['email_host', 'email_port', 'email_user', 'email_pass', 'email_from', 'email_public_url'];
let _cache = null;   // { em, cfg }

async function carregar(forcar = false) {
  if (!forcar && _cache && Date.now() - _cache.em < 60 * 1000) return _cache.cfg;
  const banco = {};
  try {
    const r = await db.query(`SELECT key, value FROM config WHERE key = ANY($1::text[])`, [CHAVES]);
    for (const x of r.rows) banco[x.key] = x.value;
  } catch (e) { console.warn('[email] não leu a configuração do banco:', e.message); }
  let senha = '';
  if (banco.email_pass) { try { senha = decryptToken(banco.email_pass); } catch (e) { console.warn('[email] senha do banco ilegível:', e.message); } }
  const env = process.env;
  const cfg = {
    host: banco.email_host || env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(banco.email_port || env.SMTP_PORT) || 587,
    user: banco.email_user || env.SMTP_USER || '',
    pass: senha || env.SMTP_PASS || '',
    from: banco.email_from || env.SMTP_FROM || '',
    publicUrl: (banco.email_public_url || env.PUBLIC_URL || 'https://hub-360.viasoftcloud.com.br').replace(/\/+$/, ''),
    origem: banco.email_user ? 'banco' : (env.SMTP_USER ? 'env' : null),
    senhaDefinida: !!(senha || env.SMTP_PASS),
  };
  _cache = { em: Date.now(), cfg };
  return cfg;
}
const configurado = (cfg) => !!(cfg.user && cfg.pass);

async function salvar({ host, port, user, pass, from, publicUrl }) {
  const grava = async (k, v) => db.query(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
  const apaga = async (k) => db.query(`DELETE FROM config WHERE key = $1`, [k]);
  for (const [k, v] of [['email_host', host], ['email_port', port], ['email_user', user], ['email_from', from], ['email_public_url', publicUrl]]) {
    const t = String(v == null ? '' : v).trim();
    if (t) await grava(k, t); else await apaga(k);
  }
  if (pass && String(pass).trim()) await grava('email_pass', encryptToken(String(pass).trim()));   // senha em branco = mantém a atual
  _cache = null;
}

function criarTransporte(cfg) {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
  });
}
// { ok, motivo? } — nunca lança.
async function enviar({ para, assunto, html, texto }) {
  const cfg = await carregar();
  if (!configurado(cfg)) return { ok: false, motivo: 'nao_configurado' };
  try {
    await criarTransporte(cfg).sendMail({ from: cfg.from || cfg.user, to: para, subject: assunto, html, text: texto });
    return { ok: true };
  } catch (e) {
    console.warn('[email] envio falhou:', e.message);
    return { ok: false, motivo: 'falhou', detalhe: e.message };
  }
}
module.exports = { carregar, configurado, salvar, enviar };
