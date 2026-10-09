'use strict';
// Envio de e-mail (SMTP do Google Workspace por padrão). Configurado só por variáveis de ambiente; sem elas o envio é
// pulado e quem chamou recebe `nao_configurado` (o cadastro de usuário nunca falha por causa do e-mail).
//   SMTP_HOST (padrão smtp.gmail.com) · SMTP_PORT (587) · SMTP_USER · SMTP_PASS (senha de app) · SMTP_FROM ("Hub 360 <hub@dominio>")
const nodemailer = require('nodemailer');

const configurado = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);
let _transp = null;
function transporte() {
  if (!_transp) {
    const porta = Number(process.env.SMTP_PORT) || 587;
    _transp = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com', port: porta, secure: porta === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    });
  }
  return _transp;
}
// { ok, motivo? } — nunca lança.
async function enviar({ para, assunto, html, texto }) {
  if (!configurado()) return { ok: false, motivo: 'nao_configurado' };
  try {
    await transporte().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: para, subject: assunto, html, text: texto });
    return { ok: true };
  } catch (e) {
    console.warn('[email] envio falhou:', e.message);
    return { ok: false, motivo: 'falhou', detalhe: e.message };
  }
}
module.exports = { configurado, enviar };
