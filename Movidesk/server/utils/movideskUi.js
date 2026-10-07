'use strict';
// Automação da TELA do Movidesk (gatilhos) com navegador sem janela (Playwright).
// Fase 0 — MAPEAMENTO: entra, abre "novo gatilho", fotografa e lista os campos reais. Não cria nem altera nada.
// A biblioteca `playwright-core` e o Chromium precisam estar na imagem (ver docs/ARCHITECTURE.md → Gatilhos).
// Credenciais: usuário/senha do Movidesk ficam na tabela config, criptografados (chaves movidesk_ui_user / movidesk_ui_pass).
const db = require('../db/remote');
const { encryptToken, decryptToken } = require('./crypto');

const CH_USER = 'movidesk_ui_user', CH_PASS = 'movidesk_ui_pass', CH_BASE = 'movidesk_ui_base';
const BASE_PADRAO = 'https://viasoft.movidesk.com';

async function lerCfg(chave) {
  const r = await db.query(`SELECT value FROM config WHERE key = $1`, [chave]);
  return r.rows[0]?.value ?? null;
}
async function gravarCfg(chave, valor) {
  await db.query(`INSERT INTO config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [chave, valor]);
}
async function obterAcesso() {
  const [u, p, b] = await Promise.all([lerCfg(CH_USER), lerCfg(CH_PASS), lerCfg(CH_BASE)]);
  return { usuario: u ? decryptToken(u) : '', senha: p ? decryptToken(p) : '', base: (b || BASE_PADRAO).replace(/\/+$/, '') };
}
async function salvarAcesso({ usuario, senha, base }) {
  if (typeof usuario === 'string' && usuario.trim()) await gravarCfg(CH_USER, encryptToken(usuario.trim()));
  if (typeof senha === 'string' && senha) await gravarCfg(CH_PASS, encryptToken(senha));
  if (typeof base === 'string' && /^https:\/\/[^\s/]+$/i.test(base.trim().replace(/\/+$/, ''))) await gravarCfg(CH_BASE, base.trim().replace(/\/+$/, ''));
}
async function statusAcesso() {
  const a = await obterAcesso();
  return { usuario: a.usuario, temSenha: !!a.senha, base: a.base };
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

module.exports = { statusAcesso, salvarAcesso, mapear, execucao, achaChromium };
