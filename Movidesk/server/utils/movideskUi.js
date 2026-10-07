'use strict';
// Automação da TELA do Movidesk (gatilhos) com navegador sem janela (Playwright).
// Fase 0 — MAPEAMENTO: entra, abre "novo gatilho", fotografa e lista os campos reais. Não cria nem altera nada.
// A biblioteca `playwright-core` e o Chromium precisam estar na imagem (ver docs/ARCHITECTURE.md → Gatilhos).
// Credenciais: usuário/senha do Movidesk ficam na tabela config, criptografados (chaves movidesk_ui_user / movidesk_ui_pass).
const db = require('../db/remote');
const { encryptToken, decryptToken } = require('./crypto');

const CH_USER = 'movidesk_ui_user', CH_PASS = 'movidesk_ui_pass', CH_BASE = 'movidesk_ui_base', CH_TOTP = 'movidesk_ui_totp';
const BASE_PADRAO = 'https://viasoft.movidesk.com';

async function lerCfg(chave) {
  const r = await db.query(`SELECT value FROM config WHERE key = $1`, [chave]);
  return r.rows[0]?.value ?? null;
}
async function gravarCfg(chave, valor) {
  await db.query(`INSERT INTO config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [chave, valor]);
}
// ── Código do app autenticador (TOTP, RFC 6238: HMAC-SHA1, 30 s, 6 dígitos) ──
// A chave secreta é a que aparece junto do QR code ao configurar o autenticador (ou o link otpauth://...).
function normalizarChaveTotp(entrada) {
  let t = String(entrada || '').trim();
  const m = t.match(/[?&]secret=([^&\s]+)/i);
  if (/^otpauth:/i.test(t) && m) t = decodeURIComponent(m[1]);
  t = t.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  return /^[A-Z2-7]{16,}$/.test(t) ? t : null;
}
function base32(t) {
  const alfa = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of t) bits += alfa.indexOf(c).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function codigoTotp(chave, agoraMs = Date.now(), digitos = 6) {
  const crypto = require('crypto');
  const contador = Buffer.alloc(8); contador.writeBigUInt64BE(BigInt(Math.floor(agoraMs / 1000 / 30)));
  const h = crypto.createHmac('sha1', base32(chave)).update(contador).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digitos).padStart(digitos, '0');
}

async function obterAcesso() {
  const [u, p, b, t] = await Promise.all([lerCfg(CH_USER), lerCfg(CH_PASS), lerCfg(CH_BASE), lerCfg(CH_TOTP)]);
  return { usuario: u ? decryptToken(u) : '', senha: p ? decryptToken(p) : '', totp: t ? decryptToken(t) : '', base: (b || BASE_PADRAO).replace(/\/+$/, '') };
}
async function salvarAcesso({ usuario, senha, base, totp }) {
  if (typeof totp === 'string' && totp.trim()) {
    const chave = normalizarChaveTotp(totp);
    if (!chave) throw new Error('Chave do autenticador inválida: cole a chave secreta (letras e números, 16+ caracteres) ou o link otpauth://.');
    await gravarCfg(CH_TOTP, encryptToken(chave));
  }
  if (typeof usuario === 'string' && usuario.trim()) await gravarCfg(CH_USER, encryptToken(usuario.trim()));
  if (typeof senha === 'string' && senha) await gravarCfg(CH_PASS, encryptToken(senha));
  if (typeof base === 'string' && /^https:\/\/[^\s/]+$/i.test(base.trim().replace(/\/+$/, ''))) await gravarCfg(CH_BASE, base.trim().replace(/\/+$/, ''));
}
async function statusAcesso() {
  const a = await obterAcesso();
  return { usuario: a.usuario, temSenha: !!a.senha, temTotp: !!a.totp, base: a.base };
}

function carregarPlaywright() {
  try { return require('playwright-core'); }
  catch { throw new Error('A biblioteca playwright-core não está instalada na imagem do Hub. Veja docs/ARCHITECTURE.md → "Gatilhos no Movidesk".'); }
}
const CAMINHOS_CHROMIUM = [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
function achaChromium() {
  const fs = require('fs');
  return CAMINHOS_CHROMIUM.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Última execução (fotos e mapa), só em memória e só para admin — nunca grava a senha.
const execucao = { rodando: false, iniciadoEm: null, terminadoEm: null, passos: [], mapa: {}, erro: null };

async function foto(page, titulo) {
  try {
    const png = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
    execucao.passos.push({ titulo, imagem: `data:image/jpeg;base64,${png.toString('base64')}`, em: new Date().toISOString() });
    if (execucao.passos.length > 20) execucao.passos.shift();
  } catch { /* foto é só diagnóstico */ }
}

// Lista os elementos interativos visíveis (sem valores digitados, só estrutura) para eu calibrar os seletores.
async function mapearTela(page) {
  return page.evaluate(() => {
    const visivel = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const lista = [...document.querySelectorAll('input,select,textarea,button,a,[role],label,[contenteditable],[class*="select"],[class*="dropdown"],[class*="combo"],[class*="k-"],[data-role]')]
      .filter(visivel).slice(0, 400).map((el) => ({
        tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.getAttribute('name') || undefined, type: el.getAttribute('type') || undefined,
        role: el.getAttribute('role') || undefined, dataRole: el.getAttribute('data-role') || undefined,
        classe: (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 6).join(' ') || undefined,
        texto: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 70) || undefined,
        titulo: el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || undefined,
        para: el.getAttribute('for') || undefined, pai: el.parentElement ? (el.parentElement.id || (el.parentElement.getAttribute('class') || '').split(/\s+/)[0] || el.parentElement.tagName.toLowerCase()) : undefined,
      }));
    return { url: location.href, titulo: document.title, elementos: lista };
  });
}

async function entrar(page, acesso) {
  await page.goto(acesso.base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  const senha = page.locator('input[type="password"]:visible').first();
  if (!(await senha.count())) { await foto(page, 'Já havia sessão (sem tela de login)'); return; }
  await foto(page, 'Tela de login');
  const campo = page.locator('input[type="text"]:visible, input[type="email"]:visible, input:not([type]):visible').first();
  await campo.fill(acesso.usuario);
  await senha.fill(acesso.senha);
  const botao = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  if (await botao.count()) await botao.click(); else await senha.press('Enter');
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // segundo fator: se aparecer um campo de código, preenche com o TOTP do autenticador
  const campoCodigo = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible, input[name*="token" i]:visible, input[name*="otp" i]:visible, input[name*="verif" i]:visible, input[inputmode="numeric"]:visible, input[type="tel"]:visible, input[maxlength="6"]:visible').first();
  if (await campoCodigo.count()) {
    await foto(page, 'Pede o código do autenticador (2FA)');
    try {
      execucao.mapa.tela2fa = await page.evaluate(() => {
        const m = document.querySelector('.modal.show, [role="dialog"]:not([aria-hidden="true"]), #CreateMfa');
        return { classe: m ? (m.getAttribute('class') || '') : null, id: m ? m.id : null, texto: m ? (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500) : null };
      });
    } catch { /* diagnóstico */ }
    if (!acesso.totp) throw new Error('O Movidesk pediu o código do autenticador (2FA), mas a chave do autenticador não foi cadastrada no Hub.');
    const restante = 30 - ((Date.now() / 1000) % 30);
    if (restante < 4) await page.waitForTimeout((restante + 1) * 1000);   // não usa um código prestes a vencer
    await campoCodigo.fill(codigoTotp(acesso.totp));
    const lembrar = page.getByLabel(/lembrar|confiar|não perguntar/i).first();
    try { if (await lembrar.count()) await lembrar.check({ timeout: 2000 }); } catch { /* opcional */ }
    // O botão de confirmar precisa ser o do MESMO modal/formulário do campo de código (atrás dele pode haver o botão "Entrar" do login).
    const area = campoCodigo.locator('xpath=ancestor::*[contains(@class,"modal") or @role="dialog" or self::form][1]');
    const dentro = (await area.count()) ? area : page;
    const enviar = dentro.locator('button:visible:has-text("Ativar"), button:visible:has-text("Verificar"), button:visible:has-text("Confirmar"), button:visible:has-text("Validar"), button:visible:has-text("Enviar"), button:visible:has-text("Entrar"), button[type="submit"]:visible, input[type="submit"]:visible').first();
    if (await enviar.count()) await enviar.click({ timeout: 8000 }); else await campoCodigo.press('Enter');
    await page.waitForTimeout(3000);
    if (await page.locator('input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible, input[maxlength="6"]:visible').count()) { await foto(page, 'Código do 2FA não foi aceito'); throw new Error('O Movidesk não aceitou o código do autenticador (chave errada, ou o relógio do servidor está fora de hora).'); }
  }
  if (await page.locator('input[type="password"]:visible').count()) { await foto(page, 'Login não concluiu'); throw new Error('O login no Movidesk não concluiu (usuário/senha incorretos, ou a tela pede outra etapa — veja a foto).'); }
  await foto(page, 'Depois do login');
}

// Fase 0: abre a lista de gatilhos, clica no "+" e fotografa/mapeia o formulário e os seletores abertos.
async function mapear() {
  if (execucao.rodando) throw new Error('Já existe um mapeamento em andamento.');
  const acesso = await obterAcesso();
  if (!acesso.usuario || !acesso.senha) throw new Error('Cadastre o usuário e a senha do Movidesk primeiro.');
  const caminho = achaChromium();
  if (!caminho) throw new Error('Chromium não encontrado na imagem do Hub (defina CHROMIUM_PATH ou instale o chromium).');
  const { chromium } = carregarPlaywright();
  Object.assign(execucao, { rodando: true, iniciadoEm: new Date().toISOString(), terminadoEm: null, passos: [], mapa: {}, erro: null });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: caminho, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 }, locale: 'pt-BR' })).newPage();
    page.setDefaultTimeout(20000);
    await entrar(page, acesso);
    await page.goto(acesso.base + '/AutomationTrigger', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await foto(page, 'Lista de gatilhos');
    execucao.mapa.lista = await mapearTela(page);
    // botão "+" (verde): tenta pelo nome e, se não houver, pelo elemento antes de "OPÇÕES"
    const tentativas = [() => page.getByRole('button', { name: /novo|adicionar|criar/i }).first(), () => page.locator('a[title*="Novo" i], a[title*="Adicionar" i], button[title*="Novo" i]').first(),
      () => page.getByText('OPÇÕES', { exact: false }).first().locator('xpath=preceding::*[self::a or self::button][1]')];
    let clicou = false;
    for (const t of tentativas) { try { const el = t(); if (await el.count()) { await el.click({ timeout: 5000 }); clicou = true; break; } } catch { /* próxima */ } }
    await page.waitForTimeout(3000);
    await foto(page, clicou ? 'Novo gatilho (depois de clicar no +)' : 'Não achei o botão + (veja a lista)');
    execucao.mapa.formulario = await mapearTela(page);
    // abre o 1º seletor das Condições e o das Ações para ver as opções
    for (const [rotulo, filtro] of [['Condições', /Selecione/], ['Ações', /Adicionar ação|Selecione/]]) {
      try {
        const alvo = page.getByText(filtro).first();
        if (await alvo.count()) { await alvo.click({ timeout: 4000 }); await page.waitForTimeout(800); await foto(page, `Seletor aberto: ${rotulo}`); execucao.mapa[`aberto_${rotulo}`] = await mapearTela(page); await page.keyboard.press('Escape'); }
      } catch { /* diagnóstico: segue */ }
    }
    try { // botão de imagem do editor
      const img = page.locator('[title*="mage" i], [aria-label*="mage" i], [data-cmd*="mage" i], button:has(svg) >> nth=0').first();
      if (await img.count()) { await img.click({ timeout: 3000 }); await page.waitForTimeout(800); await foto(page, 'Botão de imagem do editor'); }
    } catch { /* idem */ }
    await foto(page, 'Fim do mapeamento (nada foi salvo)');
  } catch (e) {
    execucao.erro = e.message;
    try { const p = browser && browser.contexts()[0]?.pages()[0]; if (p) await foto(p, 'Onde parou: ' + e.message.slice(0, 80)); } catch { /* */ }
  } finally {
    try { if (browser) await browser.close(); } catch { /* */ }
    execucao.rodando = false; execucao.terminadoEm = new Date().toISOString();
  }
  return execucao;
}

module.exports = { codigoTotp, normalizarChaveTotp, statusAcesso, salvarAcesso, mapear, execucao, achaChromium };
