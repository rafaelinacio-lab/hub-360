'use strict';
// E-mail de boas-vindas ao cadastrar uma pessoa. HTML com tabelas e CSS inline (funciona em Gmail/Outlook/celular).
// Para trocar o visual: cores em COR, imagem do topo em img/email-banner.png (1200×260, servida em PUBLIC_URL/img/).
const { enviar, carregar } = require('./email');

const COR = { laranja: '#ff8a2b', coral: '#e8491d', verde: '#10b981', azul: '#378add', marinho: '#0f172a', texto: '#1f2937', suave: '#64748b', fundo: '#fdeee0', cartao: '#ffffff', borda: '#f3dcc6' };
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const primeiroNome = (n) => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''; };

// Dados usados: nome, e-mail da conta e URL do painel. (Perfil e vertical não vão no e-mail.)
function montar({ nome, email, url }) {
  const dominio = (process.env.ALLOWED_DOMAIN || 'viasoft.com.br').trim().toLowerCase();
  const nomeP = primeiroNome(nome);
  const assunto = 'Seu acesso ao Hub 360 foi liberado';
  const passo = (n, cor, titulo, desc) => `<tr><td valign="top" style="padding:0 16px 20px 0;width:44px"><div style="width:40px;height:40px;line-height:40px;border-radius:20px;background:${cor};color:#ffffff;font-weight:800;font-size:18px;text-align:center">${n}</div></td>
      <td valign="top" style="padding:0 0 20px 0;font-size:15px;line-height:1.55;color:${COR.texto}"><b style="font-size:16px">${titulo}</b><br><span style="color:${COR.suave}">${desc}</span></td></tr>`;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(assunto)}</title></head>
<body style="margin:0;padding:0;background:${COR.fundo};font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Entre com a sua conta Google corporativa e comece pelo Hub 360.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COR.fundo}"><tr><td align="center" style="padding:30px 12px">
 <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${COR.cartao};border-radius:22px;overflow:hidden;box-shadow:0 10px 30px rgba(232,73,29,.18)">
  <tr><td background="${url}/img/email-banner.png" bgcolor="${COR.coral}" style="background:${COR.coral} url('${url}/img/email-banner.png') center/cover no-repeat;padding:34px 36px 38px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle" style="padding-right:16px"><img src="${url}/img/hub360-logo.png" width="64" height="64" alt="Hub 360" style="display:block;border:0;border-radius:16px"></td>
      <td valign="middle"><div style="font-size:30px;line-height:1.1;font-weight:800;color:#ffffff;letter-spacing:-.5px">Hub 360</div>
        <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#ffe9d6;font-weight:700;margin-top:4px">Viasoft</div></td></tr></table>
    <div style="font-size:26px;line-height:1.25;font-weight:800;color:#ffffff;margin-top:26px;max-width:380px">Seu acesso foi liberado!</div>
    <div style="font-size:15px;color:#fff1e3;margin-top:8px;max-width:380px">Chamados, SLA e indicadores num só lugar.</div></td></tr>
  <tr><td style="padding:34px 36px 6px">
    <div style="font-size:22px;font-weight:800;color:${COR.texto}">${nomeP ? `Olá, ${esc(nomeP)}!` : 'Olá!'} <span style="color:${COR.coral}">&#9679;</span></div>
    <p style="font-size:15px;line-height:1.65;color:${COR.texto};margin:12px 0 0">Você já pode usar o <b>Hub 360</b>. É só entrar com a sua conta Google corporativa — <b style="color:${COR.verde}">não há senha</b> para criar ou decorar.</p></td></tr>
  <tr><td align="center" style="padding:26px 36px 8px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${COR.coral}" style="border-radius:14px;background:linear-gradient(135deg,${COR.laranja},${COR.coral});border-bottom:4px solid #b8350f">
      <a href="${esc(url)}" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:800;font-size:17px;padding:16px 42px;border-radius:14px">Acessar o Hub 360 &rarr;</a></td></tr></table>
    <div style="font-size:12px;color:${COR.suave};margin-top:14px">Ou copie o endereço: <a href="${esc(url)}" style="color:${COR.coral};font-weight:700">${esc(url)}</a></div></td></tr>
  <tr><td style="padding:28px 36px 6px"><div style="font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:${COR.coral};font-weight:800;margin-bottom:16px">Como acessar</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
     ${passo(1, COR.laranja, 'Abra o link', 'Use o botão acima ou o endereço do Hub 360 no navegador (Chrome, Edge ou Firefox).')}
     ${passo(2, COR.verde, 'Clique em “Entrar com Google”', `Escolha a conta <b style="color:${COR.texto}">${esc(email || '@' + dominio)}</b>. Só contas <b style="color:${COR.texto}">@${esc(dominio)}</b> funcionam.`)}
     ${passo(3, COR.azul, 'Comece pela tela Início', 'Ela mostra o seu resumo, o da sua equipe e atalhos para as abas que você usa.')}
    </table></td></tr>
  <tr><td style="padding:4px 36px 8px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ecfdf5;border-left:5px solid ${COR.verde};border-radius:10px"><tr><td style="padding:14px 18px;font-size:14px;line-height:1.55;color:#065f46"><b>Sua conta de acesso</b><br><span style="font-size:15px;color:${COR.texto};font-weight:700">${esc(email)}</span></td></tr></table></td></tr>
  <tr><td style="padding:14px 36px 32px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#eff6ff;border-left:5px solid ${COR.azul};border-radius:10px"><tr><td style="padding:14px 18px;font-size:13.5px;line-height:1.6;color:#1e3a8a"><b>Não conseguiu entrar?</b> Confira se escolheu a conta corporativa. Se o erro continuar, fale com a administração do Hub 360 informando este e-mail.</td></tr></table></td></tr>
  <tr><td bgcolor="${COR.marinho}" style="background:${COR.marinho};padding:22px 36px;text-align:center">
    <img src="${url}/img/hub360-logo.png" width="34" height="34" alt="" style="border:0;border-radius:9px;vertical-align:middle"> <span style="font-size:15px;font-weight:800;color:#ffffff;vertical-align:middle;margin-left:6px">Hub 360</span>
    <div style="font-size:12px;color:#94a3b8;margin-top:10px">Mensagem automática · não responda este e-mail</div></td></tr>
 </table></td></tr></table></body></html>`;
  const texto = `${nomeP ? `Olá, ${nomeP}!` : 'Olá!'}\n\nSeu acesso ao Hub 360 foi liberado. Entre com a sua conta Google corporativa (sem senha).\n\nAcesse: ${url}\n\nComo acessar:\n1. Abra o link acima no navegador.\n2. Clique em "Entrar com Google" e escolha a conta ${email || '@' + dominio} (só contas @${dominio}).\n3. Comece pela tela Início: seu resumo, o da equipe e atalhos.\n\nNão conseguiu entrar? Fale com a administração do Hub 360.\n\nMensagem automática, não responda.`;
  return { assunto, html, texto };
}
async function enviarBoasVindas(pessoa) {
  const m = montar({ ...pessoa, url: (await carregar()).publicUrl });
  return enviar({ para: pessoa.email, assunto: m.assunto, html: m.html, texto: m.texto });
}
module.exports = { montar, enviarBoasVindas };
