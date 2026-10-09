'use strict';
// E-mail de boas-vindas ao cadastrar uma pessoa. HTML com tabelas e CSS inline (funciona em Gmail/Outlook/celular).
// Para trocar o visual: cores em COR, imagem do topo em img/email-banner.png (1200×260, servida em PUBLIC_URL/img/).
const { enviar, carregar } = require('./email');

const COR = { marca: '#ff8a2b', marcaEscura: '#e85d04', texto: '#1f2937', suave: '#6b7280', fundo: '#f4f1ec', cartao: '#ffffff', borda: '#eadfd2', botaoTexto: '#2b1500' };
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PERFIL = { admin: 'Administrador', supervisor: 'Supervisor', atendente: 'Atendente', guest: 'Convidado' };
const primeiroNome = (n) => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''; };

function montar({ nome, email, perfil, verticais, url }) {
  const dominio = (process.env.ALLOWED_DOMAIN || 'viasoft.com.br').trim().toLowerCase();
  const nomeP = primeiroNome(nome), perfilTxt = PERFIL[String(perfil || '').toLowerCase()] || perfil || '';
  const verts = String(verticais || '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
  const assunto = 'Seu acesso ao Hub 360 foi liberado';
  const passo = (n, titulo, desc) => `<tr><td valign="top" style="padding:0 14px 16px 0;width:34px"><div style="width:30px;height:30px;line-height:30px;border-radius:15px;background:${COR.marca};color:${COR.botaoTexto};font-weight:800;font-size:14px;text-align:center">${n}</div></td>
      <td valign="top" style="padding:0 0 16px 0;font-size:15px;line-height:1.5;color:${COR.texto}"><b>${titulo}</b><br><span style="color:${COR.suave}">${desc}</span></td></tr>`;
  const info = (rotulo, valor) => valor ? `<tr><td style="padding:6px 0;font-size:13px;color:${COR.suave};width:110px">${rotulo}</td><td style="padding:6px 0;font-size:14px;color:${COR.texto};font-weight:600">${esc(valor)}</td></tr>` : '';
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(assunto)}</title></head>
<body style="margin:0;padding:0;background:${COR.fundo};font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Entre com a sua conta Google corporativa e comece pelo Hub 360.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COR.fundo}"><tr><td align="center" style="padding:28px 12px">
 <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${COR.cartao};border-radius:18px;overflow:hidden;border:1px solid ${COR.borda}">
  <tr><td background="${url}/img/email-banner.png" bgcolor="${COR.marca}" style="background:${COR.marca} url('${url}/img/email-banner.png') center/cover no-repeat;padding:34px 36px 30px">
    <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#fff3e6;font-weight:700">Viasoft</div>
    <div style="font-size:34px;line-height:1.1;font-weight:800;color:#ffffff;margin-top:4px">Hub 360</div>
    <div style="font-size:15px;color:#fff3e6;margin-top:8px">Chamados, SLA e indicadores num só lugar</div></td></tr>
  <tr><td style="padding:34px 36px 8px">
    <div style="font-size:22px;font-weight:800;color:${COR.texto}">${nomeP ? `Olá, ${esc(nomeP)}!` : 'Olá!'}</div>
    <p style="font-size:15px;line-height:1.6;color:${COR.texto};margin:12px 0 0">Seu acesso ao <b>Hub 360</b> foi liberado. É só entrar com a sua conta Google corporativa — não há senha para criar ou decorar.</p></td></tr>
  <tr><td align="center" style="padding:22px 36px 10px">
    <a href="${esc(url)}" style="display:inline-block;background:${COR.marca};color:${COR.botaoTexto};text-decoration:none;font-weight:800;font-size:16px;padding:15px 34px;border-radius:12px;border-bottom:3px solid ${COR.marcaEscura}">Acessar o Hub 360</a>
    <div style="font-size:12px;color:${COR.suave};margin-top:12px">Ou copie o endereço: <a href="${esc(url)}" style="color:${COR.marcaEscura}">${esc(url)}</a></div></td></tr>
  <tr><td style="padding:24px 36px 4px"><div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${COR.suave};font-weight:700;margin-bottom:14px">Como acessar</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
     ${passo(1, 'Abra o link', 'Use o botão acima ou o endereço do Hub 360 no navegador (Chrome, Edge ou Firefox).')}
     ${passo(2, 'Clique em “Entrar com Google”', `Escolha a conta <b>${esc(email || '@' + dominio)}</b>. Só contas <b>@${esc(dominio)}</b> funcionam.`)}
     ${passo(3, 'Comece pela tela Início', 'Ela mostra o seu resumo, o da sua equipe e atalhos para as abas que você usa.')}
    </table></td></tr>
  <tr><td style="padding:6px 36px 6px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fff8f1;border:1px solid ${COR.borda};border-radius:12px"><tr><td style="padding:12px 18px">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${info('Conta', email)}${info('Perfil', perfilTxt)}${info(verts.length > 1 ? 'Verticais' : 'Vertical', verts.join(', '))}</table></td></tr></table></td></tr>
  <tr><td style="padding:20px 36px 30px"><p style="font-size:13px;line-height:1.6;color:${COR.suave};margin:0"><b style="color:${COR.texto}">Não conseguiu entrar?</b> Confira se escolheu a conta corporativa e, se a mensagem de erro continuar, fale com a administração do Hub 360 informando este e-mail.</p></td></tr>
  <tr><td style="background:#faf7f2;border-top:1px solid ${COR.borda};padding:16px 36px;font-size:12px;color:${COR.suave};text-align:center">Mensagem automática do Hub 360 · não responda este e-mail</td></tr>
 </table></td></tr></table></body></html>`;
  const texto = `${nomeP ? `Olá, ${nomeP}!` : 'Olá!'}\n\nSeu acesso ao Hub 360 foi liberado. Entre com a sua conta Google corporativa (sem senha).\n\nAcesse: ${url}\n\nComo acessar:\n1. Abra o link acima no navegador.\n2. Clique em "Entrar com Google" e escolha a conta ${email || '@' + dominio} (só contas @${dominio}).\n3. Comece pela tela Início: seu resumo, o da equipe e atalhos.\n\nPerfil: ${perfilTxt}${verts.length ? `\nVertical: ${verts.join(', ')}` : ''}\n\nNão conseguiu entrar? Fale com a administração do Hub 360.\n\nMensagem automática, não responda.`;
  return { assunto, html, texto };
}
async function enviarBoasVindas(pessoa) {
  const m = montar({ ...pessoa, url: (await carregar()).publicUrl });
  return enviar({ para: pessoa.email, assunto: m.assunto, html: m.html, texto: m.texto });
}
module.exports = { montar, enviarBoasVindas };
