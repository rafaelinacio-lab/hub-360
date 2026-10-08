'use strict';
// Registro central dos tokens/credenciais do Hub (Configurações → Tokens).
// Valor salvo na tabela `config` (criptografado quando secreto); se não houver nada no banco, vale o .env (fallback).
// Assim dá para trocar um token pela tela, sem mexer em código nem reiniciar o servidor.
const db = require('../db/remote');
const { encryptToken, decryptToken } = require('./crypto');

const REGISTRO = [
  { chave: 'movidesk_token', grupo: 'Movidesk', rotulo: 'Token da API do Movidesk', secreto: true, env: 'MOVIDESK_TOKEN', teste: 'movidesk',
    ajuda: 'Usado em todas as cargas, na Central do chamado, nos avisos e na conferência com o Movidesk.' },
  { chave: 'openai_api_key', grupo: 'Inteligência Artificial', rotulo: 'Chave da API da OpenAI', secreto: true, env: 'OPENAI_API_KEY', teste: 'openai',
    ajuda: 'Usada pelo assistente de IA (Central do chamado, Incidentes, Reincidências, Curadoria e Melhorias).' },
  { chave: 'datalake_api_url', grupo: 'Datalake', rotulo: 'Endereço da apidatalake', secreto: false, env: 'DATALAKE_API_URL',
    ajuda: 'Ex.: https://apidatalake.viasoftcloud.com.br (sem barra no final).' },
  { chave: 'datalake_api_token', grupo: 'Datalake', rotulo: 'Token da apidatalake', secreto: true, env: 'DATALAKE_API_TOKEN', teste: 'datalake',
    ajuda: 'Autoriza a leitura de chamados pela apidatalake (não é o token do Movidesk).' },
  { chave: 'movidesk_ui_user', grupo: 'Automação da tela do Movidesk', rotulo: 'Usuário de acesso à tela do Movidesk', secreto: true,
    ajuda: 'Login usado pelo navegador automático (gatilhos dos Avisos automáticos).' },
  { chave: 'movidesk_ui_pass', grupo: 'Automação da tela do Movidesk', rotulo: 'Senha de acesso à tela do Movidesk', secreto: true,
    ajuda: 'Senha do usuário acima.' },
  { chave: 'movidesk_ui_totp', grupo: 'Automação da tela do Movidesk', rotulo: 'Chave do autenticador (MFA)', secreto: true,
    ajuda: 'Chave secreta do app autenticador do usuário acima (aceita também o link otpauth://). Gera o código de 6 dígitos sozinho.' },
  { chave: 'jira_base_url', grupo: 'Jira', rotulo: 'Endereço do Jira', secreto: false, env: 'JIRA_BASE_URL',
    ajuda: 'Ex.: https://suaempresa.atlassian.net (sem barra no final). Lido pelo extrator do Jira (jira_extractor.py).' },
  { chave: 'jira_email', grupo: 'Jira', rotulo: 'E-mail do usuário do Jira', secreto: false, env: 'JIRA_EMAIL',
    ajuda: 'Usuário dono do token abaixo.' },
  { chave: 'jira_api_token', grupo: 'Jira', rotulo: 'Token de API do Jira', secreto: true, env: 'JIRA_API_TOKEN', teste: 'jira',
    ajuda: 'Gerado em id.atlassian.com → Segurança → Tokens de API.' },
  { chave: 'jira_extrator_chave', grupo: 'Jira', rotulo: 'Chave do extrator do Jira', secreto: true, gerar: true, rota: '/tokens/jira-extrator/chave', tipoGerar: 'extrator',
    ajuda: 'Permite que o jira_extractor.py busque as credenciais acima aqui no Hub. Coloque HUB_URL e HUB_EXTRATOR_KEY no Jira/.env uma única vez; depois é só trocar nesta tela.' },
  { chave: 'painel_tv_chave', grupo: 'Painel TV', rotulo: 'Chave do link da TV', secreto: false, mascarar: true, gerar: true,
    ajuda: 'Faz parte do link do Painel TV (?k=...). Gerar nova chave invalida o link antigo; abra o Painel TV como admin para copiar o novo link.' },
];
const porChave = Object.fromEntries(REGISTRO.map((r) => [r.chave, r]));

let cache = new Map();   // chave -> { em, valor }
const TTL = 30 * 1000;
const invalidar = () => { cache = new Map(); };

async function lerBruto(chave) {
  const r = await db.query(`SELECT value FROM config WHERE key = $1`, [chave]).catch(() => ({ rows: [] }));
  return r.rows[0]?.value || null;
}
// Valor em uso: banco primeiro, depois .env. Devolve { valor, fonte } — fonte: 'banco' | 'ambiente' | 'nenhuma'.
async function resolver(chave) {
  const reg = porChave[chave];
  if (!reg) throw new Error('Token desconhecido');
  const c = cache.get(chave);
  if (c && Date.now() - c.em < TTL) return c.v;
  let v = { valor: '', fonte: 'nenhuma' };
  const bruto = await lerBruto(chave);
  if (bruto) {
    try { v = { valor: reg.secreto ? decryptToken(bruto) : bruto, fonte: 'banco' }; }
    catch { v = { valor: '', fonte: 'ilegivel' }; }   // criptografado com outra ENCRYPTION_KEY: precisa salvar de novo
  }
  if (!v.valor && reg.env && process.env[reg.env]) v = { valor: process.env[reg.env], fonte: 'ambiente' };
  cache.set(chave, { em: Date.now(), v });
  return v;
}
const obter = async (chave) => (await resolver(chave)).valor;

async function definir(chave, valor) {
  const reg = porChave[chave];
  if (!reg) throw new Error('Token desconhecido');
  const limpo = String(valor == null ? '' : valor).trim();
  if (reg.gerar) throw new Error('Esta chave é gerada pelo sistema (use “Gerar nova”).');
  if (!limpo) throw new Error('O valor não pode ficar vazio. Para voltar ao .env, use “Remover”.');
  if (limpo.length > 2000 || /[\r\n]/.test(limpo)) throw new Error('Valor inválido (muito longo ou com quebra de linha).');
  if (chave === 'datalake_api_url' && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(limpo)) throw new Error('Informe o endereço completo, começando com https://');
  await db.query(`INSERT INTO config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [chave, reg.secreto ? encryptToken(limpo) : limpo]);
  invalidar();
}
async function remover(chave) {
  if (!porChave[chave]) throw new Error('Token desconhecido');
  if (porChave[chave].gerar) throw new Error('Esta chave é gerada pelo sistema (use “Gerar nova”).');
  await db.query(`DELETE FROM config WHERE key = $1`, [chave]);
  invalidar();
}
const mascara = (v) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);
async function status() {
  invalidar();
  const out = [];
  for (const r of REGISTRO) {
    const { valor, fonte } = await resolver(r.chave);
    out.push({ chave: r.chave, grupo: r.grupo, rotulo: r.rotulo, ajuda: r.ajuda, secreto: r.secreto, testavel: !!r.teste, gerar: !!r.gerar, rota: r.rota || (r.chave === 'painel_tv_chave' ? '/geral/tv-chave' : null), tipoGerar: r.tipoGerar || 'tv',
      fonte, configurado: !!valor, previa: valor ? (r.secreto || r.mascarar ? mascara(valor) : valor) : '' });
  }
  return out;
}
// Chave do extrator do Jira (gerada pelo sistema, guardada criptografada).
async function chaveExtrator(criar = false) {
  const reg = porChave.jira_extrator_chave;
  if (!criar) { const v = await obter(reg.chave); if (v) return v; }
  const nova = require('crypto').randomBytes(24).toString('hex');
  await db.query(`INSERT INTO config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [reg.chave, encryptToken(nova)]);
  invalidar();
  return nova;
}
module.exports = { chaveExtrator, REGISTRO, porChave, obter, resolver, definir, remover, status, invalidar };
