'use strict';
// "Central do chamado": deixa o usuário do Dashboard ver a conversa de um chamado e
// interagir com ele (responder, nota interna, mudar status, trocar responsável) sem
// abrir o Movidesk. Lê e escreve direto na API do Movidesk.
//
// Regras de segurança:
//  - escrever exige perfil admin/supervisor/atendente + acesso à aba (guest só lê);
//  - a ação é gravada no Movidesk em nome do PRÓPRIO usuário (agente achado pelo e-mail
//    do login); sem cadastro de agente no Movidesk, não escreve;
//  - status só aceita valores que já existem nos chamados (nada digitado à mão);
//  - toda escrita fica em public.hub_ticket_interacoes (quem, quando, o quê, resultado).
const express = require('express');
const db = require('../db/remote');
const { requireTabAccess } = require('./config');
const fetchNode = require('node-fetch');
const { tokenMovidesk, MovideskError, movidesk, agenteDoUsuario, listaAgentes, escopoEquipe } = require('../utils/movideskPeople');
const { authMiddleware } = require('./auth');
const { escopoVertical, pertence } = require('../utils/verticalScope');
const { rateLimit, rateLimitDinamico } = require('../utils/rateLimit');
const cfg = require('../utils/aiSettings');
const { chamarIA, configurada: iaConfigurada, IaError, REGRAS, dados, conversaEmTexto, limitar, dataBr } = require('../utils/ai');

const router = express.Router();
router.use(authMiddleware);

const ROLES_ESCRITA = ['admin', 'supervisor', 'atendente'];
// type: 1 = nota interna, 2 = resposta pública (visível ao cliente). origin 9 = API.
const ACAO_TIPO = { interna: 1, publica: 2 };
const ACAO_ORIGEM = Number(process.env.MOVIDESK_ACTION_ORIGIN || 9);
const MAX_TEXTO = 20000;

const requireLeitura = requireTabAccess(['dashboard', 'movidesk', 'chamados']);
const limiteEscrita = rateLimit({ name: 'tickets/workspace-write', windowMs: 10 * 60 * 1000, max: 60 });

async function papelDoUsuario(userId) {
  const r = await db.query(`SELECT r.name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`, [userId]);
  return r.rows[0]?.name || null;
}

// Regra única de vertical: quem tem vertical atribuída em Pessoas (e não é admin) só abre ou age em chamado da própria
// vertical — vale para a leitura E para as ações de escrita no Movidesk (responder, nota, status, responsável, IA).
// Vertical do chamado = 1º nível do serviço (equipe só sem serviço), lida de silver.ticket ANTES de qualquer chamada ao
// Movidesk. Sem a linha no banco não dá para provar o escopo, então também recusa. Admin e perfil SEM vertical: sem
// nenhuma consulta extra. Leitura = 404 (não revela que existe); escrita = 403.
async function exigirChamadoNoEscopo(req, res, next) {
  try {
    const esc = await escopoVertical(req.user.id);
    if (!esc.filtrar) return next();
    const id = idValido(req.params.id);
    let linha = null;
    if (id) linha = (await db.query(`SELECT service_full, ownerteam FROM silver.ticket WHERE ticket_id = $1::bigint`, [id])).rows[0];
    if (linha && pertence(esc.verticais, { servico: linha.service_full, equipe: linha.service_full ? null : linha.ownerteam })) return next();
    return res.status(req.method === 'GET' ? 404 : 403).json({ error: 'Chamado fora da sua vertical' });
  } catch (e) {
    console.error('[workspace] checagem de vertical falhou:', e.message);
    return res.status(500).json({ error: 'Erro ao verificar a vertical do chamado' });
  }
}

async function exigirEscrita(req, res, next) {
  try {
    const papel = await papelDoUsuario(req.user.id);
    if (!ROLES_ESCRITA.includes(papel)) {
      return res.status(403).json({ error: 'Seu perfil pode ver o chamado, mas não interagir com ele.' });
    }
    req.papel = papel;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Erro ao verificar permissão' });
  }
}

// Status que existem de verdade no Movidesk da empresa (nome + status base), tirados dos
// chamados recentes — evita chumbar nomes e impede digitar um status inexistente.
let cacheStatus = { ate: 0, lista: [] };
async function listaStatus() {
  if (cacheStatus.ate > Date.now()) return cacheStatus.lista;
  const r = await db.query(
    `SELECT status, basestatus, COUNT(*)::int AS n FROM silver.ticket
      WHERE createddate >= NOW() - INTERVAL '180 days' AND status IS NOT NULL AND status <> ''
      GROUP BY 1, 2 HAVING COUNT(*) >= 3 ORDER BY 3 DESC`
  );
  cacheStatus = { ate: Date.now() + 10 * 60 * 1000, lista: r.rows.map(x => ({ status: x.status, baseStatus: x.basestatus })) };
  return cacheStatus.lista;
}

// Justificativas cadastradas no Movidesk (exportação em server/data/justificativas-movidesk.json).
// Só as ativas entram, filtradas pelo tipo do chamado (interno/público) e indexadas pelo status
// (minúsculas). Para atualizar a lista, substitua o JSON pela nova exportação.
const fs = require('fs');
const path = require('path');
const ARQ_JUSTIFICATIVAS = path.join(__dirname, '..', 'data', 'justificativas-movidesk.json');
const normStatus = (v) => String(v || '').trim().toLowerCase();
let cacheJust = { mtime: 0, lista: [] };
function justificativasCadastradas() {
  try {
    const m = fs.statSync(ARQ_JUSTIFICATIVAS).mtimeMs;
    if (m !== cacheJust.mtime) {
      const j = JSON.parse(fs.readFileSync(ARQ_JUSTIFICATIVAS, 'utf8'));
      cacheJust = { mtime: m, lista: (j.justificativas || []).filter((x) => x.ativa) };
    }
  } catch (e) {
    console.error('[workspace] não consegui ler as justificativas:', e.message);
  }
  return cacheJust.lista;
}
// tipo: 'interno' | 'publico' (qualquer outro valor não filtra por tipo).
function justificativasPorStatus(tipo) {
  const mapa = {};
  for (const x of justificativasCadastradas()) {
    if (x.tickets !== 'ambos' && (tipo === 'interno' || tipo === 'publico') && x.tickets !== tipo) continue;
    for (const st of x.status) {
      const k = normStatus(st);
      (mapa[k] = mapa[k] || []).push(x.nome);
    }
  }
  for (const k of Object.keys(mapa)) mapa[k].sort((p, q) => p.localeCompare(q, 'pt'));
  return mapa;
}
const tipoDoTicket = (t) => (t === 1 ? 'interno' : t === 2 ? 'publico' : null);

// ── auditoria ───────────────────────────────────────────────────────────────
let tabelaPronta = null;
function garantirTabela() {
  if (!tabelaPronta) {
    tabelaPronta = db.query(`
      CREATE TABLE IF NOT EXISTS public.hub_ticket_interacoes (
        id          BIGSERIAL PRIMARY KEY,
        ticket_id   BIGINT NOT NULL,
        user_id     INTEGER,
        user_email  TEXT,
        tipo        TEXT NOT NULL,
        detalhes    JSONB,
        sucesso     BOOLEAN NOT NULL,
        erro        TEXT,
        criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`).then(() => db.query(`CREATE INDEX IF NOT EXISTS ix_hub_ticket_interacoes_ticket ON public.hub_ticket_interacoes (ticket_id, criado_em DESC)`))
      .catch(e => { tabelaPronta = null; throw e; });
  }
  return tabelaPronta;
}
async function auditar(req, ticketId, tipo, detalhes, erro) {
  try {
    await garantirTabela();
    await db.query(
      `INSERT INTO public.hub_ticket_interacoes (ticket_id, user_id, user_email, tipo, detalhes, sucesso, erro) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ticketId, req.user.id, req.user.email || null, tipo, JSON.stringify(detalhes || {}), !erro, erro ? String(erro).slice(0, 500) : null]
    );
  } catch (e) {
    console.error('[workspace] falha ao gravar auditoria:', e.message);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function idValido(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function erroParaResposta(res, e) {
  if (e instanceof MovideskError) {
    const status = e.status === 404 ? 404 : (e.status >= 400 && e.status < 500 ? 422 : 502);
    return res.status(status).json({ error: e.message });
  }
  console.error('[workspace]', e);
  return res.status(500).json({ error: e.message || 'Erro inesperado' });
}
async function exigirAgente(req, res) {
  const agente = await agenteDoUsuario(req.user.email);
  if (!agente) {
    res.status(403).json({ error: `Não achei um agente ativo no Movidesk com o e-mail ${req.user.email}. A interação é feita em nome de quem está logado, então o cadastro precisa existir lá.` });
    return null;
  }
  return agente;
}
// Nota interna automática que deixa registrado no chamado que a mudança veio do Hub.
function notaDeRastro(agente, texto) {
  return { type: ACAO_TIPO.interna, origin: ACAO_ORIGEM, description: texto, createdBy: { id: agente.id } };
}

// ── rotas ───────────────────────────────────────────────────────────────────
// Equipe(s) do usuário logado e se ele pode alternar para "todas" (usado pelo Dashboard).
router.get('/minha-equipe', requireLeitura, async (req, res) => {
  try {
    const e = await escopoEquipe(req.user, req.query.equipe === 'todas');
    res.json({ equipes: e.equipes, origem: e.origem, podeVerTodas: e.podeVerTodas, filtrando: e.filtrar });
  } catch (err) { erroParaResposta(res, err); }
});

// Opções para os seletores (status existentes + agentes).
router.get('/workspace/opcoes', requireLeitura, async (req, res) => {
  try {
    const [status, agentes] = await Promise.all([listaStatus(), listaAgentes().catch(() => [])]);
    res.json({ status, agentes });
  } catch (e) { erroParaResposta(res, e); }
});

// Justificativas ativas por status (as cadastradas no Movidesk), para o tipo de chamado informado.
router.get('/workspace/justificativas', requireLeitura, (req, res) => {
  res.json({ justificativas: justificativasPorStatus(req.query.tipo) });
});

// Chamado + conversa, lidos ao vivo do Movidesk (usado pela tela e pela IA).
// Imagens coladas no texto da ação (<img src="...">). As que exigem login do Movidesk são servidas pelo proxy abaixo.
function imagensDoHtml(html) {
  const out = [];
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < 12) {
    const src = m[1].replace(/&amp;/g, '&').trim();
    if (src && !/^data:/i.test(src) && !out.includes(src)) out.push(src);
  }
  return out;
}

async function lerTicketAoVivo(id) {
  const t = await movidesk('GET', '/tickets', {
    query: {
      id,
      $select: 'id,subject,status,baseStatus,justification,createdDate,lastUpdate,ownerTeam,serviceFirstLevel,type',
      $expand: 'owner($select=id,businessName,userName),clients($select=id,businessName),actions($select=id,type,origin,createdDate,description,htmlDescription;$expand=createdBy($select=id,businessName,profileType),attachments($select=fileName,path,createdDate))',
    },
  });
  if (!t || !t.id) return null;
  const acoes = (Array.isArray(t.actions) ? t.actions : [])
    .map(a => ({
      id: a.id,
      tipo: a.type === 2 ? 'publica' : 'interna',
      origem: a.origin,
      criadoEm: a.createdDate,
      autor: a.createdBy?.businessName || '—',
      autorPerfil: a.createdBy?.profileType ?? null,
      texto: a.description || '',
      anexos: (Array.isArray(a.attachments) ? a.attachments : []).filter(x => x && (x.path || x.fileName)).slice(0, 30).map(x => ({ nome: x.fileName || 'arquivo', path: x.path || '' })),
      imagens: imagensDoHtml(a.htmlDescription),
    }))
    .sort((x, y) => new Date(x.criadoEm) - new Date(y.criadoEm));
  return {
    id: t.id,
    assunto: t.subject,
    status: t.status,
    baseStatus: t.baseStatus,
    justificativa: t.justification || null,
    criadoEm: t.createdDate,
    atualizadoEm: t.lastUpdate,
    tipoTicket: tipoDoTicket(t.type),
    equipe: t.ownerTeam || null,
    servico: t.serviceFirstLevel || null,
    responsavel: t.owner ? { id: String(t.owner.id), nome: t.owner.businessName } : null,
    clientes: (Array.isArray(t.clients) ? t.clients : []).map(c => c.businessName).filter(Boolean),
    acoes,
  };
}

// Proxy de anexos e imagens do Movidesk (o navegador não tem o login do Movidesk, o servidor tem o token).
// Só aceita endereços do próprio Movidesk, para não virar um proxy aberto.
const HOST_ARQUIVOS = process.env.MOVIDESK_FILE_HOST || 'https://viasoft.movidesk.com';
const hostPermitido = (h) => /(^|\.)movidesk\.com$/i.test(h) || h === new URL(HOST_ARQUIVOS).hostname || h === new URL(process.env.MOVIDESK_WRITE_API || 'https://apimovidesk.viasoftcloud.com.br').hostname;
router.get('/:id/workspace/arquivo', requireLeitura, exigirChamadoNoEscopo, async (req, res) => {
  const id = idValido(req.params.id);
  const bruto = String(req.query.u || '').trim();
  if (!id || !bruto) return res.status(400).json({ error: 'Arquivo inválido' });
  try {
    // só serve arquivos que realmente aparecem nesse chamado
    const t = await lerTicketAoVivo(id);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado' });
    const conhecido = t.acoes.some(a => a.anexos.some(x => x.path === bruto) || a.imagens.includes(bruto));
    if (!conhecido) return res.status(403).json({ error: 'Esse arquivo não pertence ao chamado.' });
    const token = await tokenMovidesk();
    const api = new URL(process.env.MOVIDESK_WRITE_API || 'https://apimovidesk.viasoftcloud.com.br/public/v1');
    // Não sabemos em qual servidor/rota o Movidesk serve o arquivo desse caminho: tenta os candidatos em ordem.
    const idArquivo = /^[0-9a-f]{16,64}$/i.test(bruto);
    // O "path" do anexo é só um identificador e a API pública não tem rota de download por ele (28 rotas testadas, todas 404).
    // Se a empresa descobrir o endereço real, basta definir MOVIDESK_FILE_URL com {id} (ex.: https://servidor/rota?fileId={id}).
    if (idArquivo && !process.env.MOVIDESK_FILE_URL) return res.status(501).json({ error: 'Este anexo só pode ser baixado dentro do Movidesk.' });
    const candidatos = idArquivo ? [process.env.MOVIDESK_FILE_URL.replace('{id}', encodeURIComponent(bruto))] : /^https?:\/\//i.test(bruto) ? [bruto] : [      new URL(bruto, HOST_ARQUIVOS).toString(),
      new URL(bruto, api.origin).toString(),
      `${api.origin}${api.pathname.replace(/\/$/, '')}${bruto.startsWith('/') ? '' : '/'}${bruto}`,
      new URL(bruto, 'https://api.movidesk.com').toString(),
    ];
    let r = null; const tentativas = [];
    for (const c of [...new Set(candidatos)]) {
      const url = new URL(c);
      if (url.protocol !== 'https:' || !hostPermitido(url.hostname)) { tentativas.push(`${url.hostname}: bloqueado`); continue; }
      url.searchParams.set('token', token);
      const resp = await fetchNode(url.toString(), { redirect: 'follow', timeout: 30000 }).catch((e) => ({ ok: false, status: e.message }));
      tentativas.push(`${url.hostname === api.hostname ? '' : url.hostname}${url.pathname.replace(/^\/public\/v1/, '')}${url.search.startsWith('?fileId') ? '?fileId' : (url.search.startsWith('?id') ? '?id' : '')}: ${resp.status}`);
      const tipoResp = resp.headers && resp.headers.get ? (resp.headers.get('content-type') || '') : '';
      if (resp.ok && !/text\/html/i.test(tipoResp)) { r = resp; break; }   // HTML = página de login, não o arquivo
    }
    if (!r) {
      console.warn(`[workspace] anexo do chamado ${id} não encontrado. caminho="${bruto}" tentativas: ${tentativas.join(' | ')}`);
      return res.status(502).json({ error: `O Movidesk não entregou o arquivo. Caminho informado: ${bruto.slice(0, 160)} — tentativas: ${tentativas.join('; ')}`.slice(0, 1500) });
    }
    const tipo = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', tipo);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!/^image\/(png|jpe?g|gif|webp|bmp)/i.test(tipo)) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(String(req.query.n || 'arquivo').slice(0, 120))}`);
    r.body.pipe(res);
  } catch (e) { erroParaResposta(res, e); }
});

router.get('/:id/workspace', requireLeitura, exigirChamadoNoEscopo, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  try {
    const t = await lerTicketAoVivo(id);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado no Movidesk' });
    const papel = await papelDoUsuario(req.user.id);
    res.json({ ...t, podeInteragir: ROLES_ESCRITA.includes(papel) });
  } catch (e) { erroParaResposta(res, e); }
});

// ── IA embutida: sugestão de resposta, correção de texto e análise do cliente ─────────────────
// Só devolvem RASCUNHOS (nada é enviado ao cliente nem gravado no Movidesk); chave, modelo e prompts
// ficam no servidor (utils/ai.js).
const limiteIA = rateLimitDinamico({ name: 'tickets/ia', windowMs: 10 * 60 * 1000, getMax: async () => (await cfg.obter()).geral.limiteChamadosPor10min });
// Recurso desligado em Configurações → Assistente de IA: responde 403 antes de gastar tokens.
const recursoLigado = (chave) => async (req, res, next) => {
  try { if (!(await cfg.obter())[chave].ativo) return res.status(403).json({ error: 'Este recurso de IA foi desativado nas Configurações.' }); } catch { /* segue */ }
  next();
};
function erroIA(res, e) {
  if (e instanceof IaError) return res.status(e.status).json({ error: e.message });
  return erroParaResposta(res, e);
}
const TONS = {
  padrao: 'cordial e profissional',
  empatico: 'acolhedor: reconheça a dificuldade do cliente em uma frase antes de orientar, sem exagerar',
  objetivo: 'direto e curto: vá ao ponto em poucas linhas',
};

router.get('/workspace/ia/status', requireLeitura, async (req, res) => {
  const S = await cfg.obter();
  res.json({ configurada: await iaConfigurada().catch(() => false), recursos: { resposta: S.resposta.ativo, corrigir: S.corrigir.ativo, cliente: S.cliente.ativo }, tomPadrao: S.resposta.tomPadrao });
});

router.post('/:id/workspace/ia/resposta', requireLeitura, exigirChamadoNoEscopo, exigirEscrita, recursoLigado('resposta'), limiteIA, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  const S = await cfg.obter(), C = S.resposta;
  const tom = TONS[req.body?.tom] ? req.body.tom : C.tomPadrao;
  const instrucao = limitar(String(req.body?.instrucao || '').trim(), 600);
  try {
    const t = await lerTicketAoVivo(id);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado no Movidesk' });
    const ultimoCliente = [...t.acoes].reverse().find(a => a.tipo === 'publica' && a.autorPerfil === 2);
    const system = `${REGRAS}${cfg.diretrizes(S)}
Tarefa: redija a PRÓXIMA resposta pública da equipe de suporte ao cliente, neste chamado.
Tom: ${TONS[tom]}.
Regras da resposta:
- Comece cumprimentando pelo nome do solicitante quando ele aparecer nos dados; responda ao pedido MAIS RECENTE do cliente.
- Se houver orientação a seguir, use passos numerados curtos. Não prometa prazos nem retornos que não estejam nos dados.
- ${C.maxPerguntas > 0 ? `Se faltar informação para resolver, peça no máximo ${C.maxPerguntas} itens, de forma específica (ex.: print da tela, versão, horário do erro).` : 'Não peça informações adicionais ao cliente; trabalhe com o que há nos dados e liste o que falta apenas em informacoes_faltantes.'}
- Notas internas servem só de contexto: NUNCA cite, copie nem insinue o conteúdo delas para o cliente.
- Sem assinatura e sem placeholders entre colchetes.
Responda em JSON: {"resposta": "texto pronto para enviar", "pontos_de_atencao": ["o que o atendente deve conferir antes de enviar"], "informacoes_faltantes": ["dados que não estavam no chamado"]}${cfg.extra(C.instrucaoExtra)}`;
    const user = `${instrucao ? `Instrução do atendente (confiável): ${instrucao}

` : ''}${dados('CHAMADO', `Assunto: ${limitar(t.assunto, 300)}
Status: ${t.status} · Serviço: ${t.servico || '—'} · Equipe: ${t.equipe || '—'}
Cliente(s): ${t.clientes.join(', ') || '—'}
Último autor do cliente: ${ultimoCliente ? ultimoCliente.autor : 'não identificado'}

Conversa (da mais antiga para a mais recente):
${conversaEmTexto(t.acoes, C.contextoCaracteres)}`)}`;
    const r = await chamarIA({ source: 'ticket_sugestao_resposta', system, user, maxTokens: cfg.TAMANHO_RESPOSTA[C.tamanho], temperature: cfg.temperatura(C.criatividade), userEmail: req.user.email, meta: { ticket: id, tom } });
    res.json({
      resposta: limitar(r.resposta, 6000),
      pontosDeAtencao: (Array.isArray(r.pontos_de_atencao) ? r.pontos_de_atencao : []).slice(0, 6).map(x => limitar(x, 300)),
      informacoesFaltantes: (Array.isArray(r.informacoes_faltantes) ? r.informacoes_faltantes : []).slice(0, 6).map(x => limitar(x, 300)),
    });
  } catch (e) { erroIA(res, e); }
});

router.post('/:id/workspace/ia/corrigir', requireLeitura, exigirChamadoNoEscopo, exigirEscrita, recursoLigado('corrigir'), limiteIA, async (req, res) => {
  const texto = String(req.body?.texto || '');
  if (!texto.trim()) return res.status(400).json({ error: 'Escreva o texto antes de corrigir.' });
  const S = await cfg.obter(), C = S.corrigir;
  if (texto.length > C.maxCaracteres) return res.status(400).json({ error: `Texto grande demais para corrigir de uma vez (máx. ${C.maxCaracteres.toLocaleString('pt-BR')} caracteres).` });
  try {
    const system = `${REGRAS}${cfg.diretrizes(S)}
Tarefa: revisar ortografia, acentuação, concordância, pontuação e digitação do texto abaixo.
Regras:
- Corrija SOMENTE erros. Preserve o sentido, o tom, os nomes, números, códigos, links, termos técnicos e as quebras de linha.
- Não acrescente, remova nem reescreva ideias; não deixe o texto mais formal do que está.
- Se não houver nada a corrigir, devolva o texto idêntico e a lista de alterações vazia.
Responda em JSON: {"texto_corrigido": "texto completo corrigido", "alteracoes": [{"de": "trecho original", "para": "trecho corrigido", "motivo": "ortografia | acentuação | concordância | pontuação | digitação"}]} (no máximo 15 alterações, as mais relevantes).${cfg.extra(C.instrucaoExtra)}`;
    const r = await chamarIA({ source: 'ticket_correcao_texto', system, user: dados('TEXTO', texto), maxTokens: Math.min(4000, Math.max(1000, Math.ceil(texto.length / 2) + 600)), temperature: 0, userEmail: req.user.email, meta: { ticket: req.params.id } });
    const corrigido = typeof r.texto_corrigido === 'string' && r.texto_corrigido.trim() ? r.texto_corrigido : texto;
    res.json({
      textoCorrigido: corrigido,
      mudou: corrigido.trim() !== texto.trim(),
      alteracoes: (Array.isArray(r.alteracoes) ? r.alteracoes : []).slice(0, 15).map(a => ({ de: limitar(a.de, 160), para: limitar(a.para, 160), motivo: limitar(a.motivo, 40) })),
    });
  } catch (e) { erroIA(res, e); }
});

// Números do relacionamento da organização com o suporte (vêm do banco; a IA só interpreta).
async function historicoDaOrganizacao(ticketId, C) {
  const dias = Number(C.janelaDias) | 0, meses = Number(C.mesesHistorico) | 0;   // vêm de uma lista fixa validada
  const termos = C.termosGcc ? C.termosGcc.split(', ') : [];
  const h = { organizacao: null, tickets90d: null, abertosAgora: null, tickets12m: null, reabertos12m: null, tempoMedioResolucaoH: null, servicosFrequentes: [], assuntosRecentes: [], tocouGcc12m: null };
  try {
    const org = (await db.query(`SELECT organizacao_id, organizacao_nome FROM silver.ticket_organizacao WHERE ticket_id = $1`, [ticketId])).rows[0];
    if (!org || !org.organizacao_id) return h;
    h.organizacao = org.organizacao_nome;
    const base = `FROM silver.ticket t JOIN silver.ticket_organizacao o ON o.ticket_id = t.ticket_id::bigint WHERE o.organizacao_id = $1 AND t.ticket_id::bigint <> $2`;
    const pTermos = termos.map((x) => `%${x.replace(/[%_]/g, '')}%`);
    const r = await db.query(`
      SELECT COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${dias} days')::int AS t90,
             COUNT(*) FILTER (WHERE t.basestatus IN ('New','InAttendance','Stopped','InProgress'))::int AS abertos,
             COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${meses} months')::int AS t12,
             COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${meses} months' AND t.reopened_in IS NOT NULL)::int AS reab,
             ROUND((AVG(EXTRACT(EPOCH FROM (t.resolved_in - t.createddate)) / 3600) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${dias} days' AND t.resolved_in IS NOT NULL))::numeric, 1) AS tmr,
             COUNT(*) FILTER (WHERE t.createddate >= NOW() - INTERVAL '${meses} months' AND (${termos.length ? termos.map((_, i) => `lower(COALESCE(t.ownerteam,'')) LIKE $${i + 3}`).join(' OR ') : 'FALSE'}))::int AS gcc
      ${base}`, [org.organizacao_id, ticketId, ...pTermos]);
    const x = r.rows[0] || {};
    h.tickets90d = x.t90; h.abertosAgora = x.abertos; h.tickets12m = x.t12; h.reabertos12m = x.reab;
    h.tempoMedioResolucaoH = x.tmr == null ? null : Number(x.tmr); h.tocouGcc12m = x.gcc;
    h.servicosFrequentes = (await db.query(`SELECT split_part(t.service_full, ' > ', 1) AS s, COUNT(*)::int AS n ${base} AND t.createddate >= NOW() - INTERVAL '${dias} days' AND t.service_full IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 4`, [org.organizacao_id, ticketId])).rows.map(y => `${y.s} (${y.n})`);
    h.assuntosRecentes = (await db.query(`SELECT t.subject ${base} ORDER BY t.createddate DESC LIMIT 8`, [org.organizacao_id, ticketId])).rows.map(y => limitar(y.subject, 140));
  } catch (e) { console.warn('[ia] histórico da organização indisponível:', e.message); }
  return h;
}

router.post('/:id/workspace/ia/cliente', requireLeitura, exigirChamadoNoEscopo, exigirEscrita, recursoLigado('cliente'), limiteIA, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  try {
    const t = await lerTicketAoVivo(id);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado no Movidesk' });
    const S = await cfg.obter(), C = S.cliente;
    const hist = await historicoDaOrganizacao(id, C);
    const system = `${REGRAS}${cfg.diretrizes(S)}
Tarefa: analisar o CLIENTE deste chamado para ajudar o atendente a conduzir o atendimento.
Considere o tom das mensagens do cliente (cordial, ansioso, irritado, ameaçando cancelar etc.), a urgência real do problema, a recorrência e o histórico de chamados da organização.
Sentimento: positivo | neutro | frustrado | irritado. Urgência percebida: baixa | media | alta. Risco de churn: baixo | medio | alto — justifique pelos sinais (reclamação repetida, menção a cancelar/concorrente, muitos chamados reabertos, passagem pelo GCC, demora). Sem sinais, não infle o risco.
Responda em JSON: {"resumo": "2 a 3 frases sobre a situação e o que o cliente precisa", "sentimento": "...", "urgencia_percebida": "...", "risco_de_churn": "...", "sinais": ["evidências curtas, citando o que o cliente disse ou os números do histórico"], "perfil_do_cliente": "1 frase (ex.: contato técnico objetivo, usuário leigo que precisa de passo a passo)", "recomendacoes": ["até 4 ações práticas para o atendente"]}${cfg.extra(C.instrucaoExtra)}`;
    const user = dados('CHAMADO', `Assunto: ${limitar(t.assunto, 300)}
Status: ${t.status} · Serviço: ${t.servico || '—'}
Cliente(s): ${t.clientes.join(', ') || '—'}
Aberto em: ${dataBr(t.criadoEm)}

Conversa:
${conversaEmTexto(t.acoes, C.contextoCaracteres)}`) + '\n\n' + dados('HISTORICO', JSON.stringify({
      organizacao: hist.organizacao, [`chamados_ultimos_${C.janelaDias}_dias`]: hist.tickets90d, chamados_abertos_agora_alem_deste: hist.abertosAgora,
      [`chamados_ultimos_${C.mesesHistorico}_meses`]: hist.tickets12m, [`reabertos_${C.mesesHistorico}_meses`]: hist.reabertos12m, tempo_medio_de_resolucao_horas: hist.tempoMedioResolucaoH,
      [`chamados_do_gcc_${C.mesesHistorico}_meses`]: hist.tocouGcc12m, servicos_mais_frequentes: hist.servicosFrequentes, assuntos_recentes: hist.assuntosRecentes,
    }, null, 1));
    const r = await chamarIA({ source: 'ticket_analise_cliente', system, user, maxTokens: 800, temperature: cfg.temperatura(C.criatividade), userEmail: req.user.email, meta: { ticket: id } });
    const pick = (v, ok, pad) => (ok.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : pad);
    res.json({
      resumo: limitar(r.resumo, 700),
      sentimento: pick(r.sentimento, ['positivo', 'neutro', 'frustrado', 'irritado'], 'neutro'),
      urgenciaPercebida: pick(String(r.urgencia_percebida).replace('média', 'media'), ['baixa', 'media', 'alta'], 'media'),
      riscoDeChurn: pick(String(r.risco_de_churn).replace('médio', 'medio'), ['baixo', 'medio', 'alto'], 'baixo'),
      sinais: (Array.isArray(r.sinais) ? r.sinais : []).slice(0, 6).map(x => limitar(x, 260)),
      perfil: limitar(r.perfil_do_cliente, 300),
      recomendacoes: (Array.isArray(r.recomendacoes) ? r.recomendacoes : []).slice(0, 4).map(x => limitar(x, 260)),
      historico: hist,
    });
  } catch (e) { erroIA(res, e); }
});

// Nota interna ou resposta ao cliente.
router.post('/:id/workspace/acao', requireLeitura, exigirChamadoNoEscopo, exigirEscrita, limiteEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const tipo = req.body?.tipo;
  const texto = String(req.body?.texto || '').trim();
  const status = String(req.body?.status || '').trim();          // opcional: mudar o status junto com a ação, como no Movidesk
  const justificativa = String(req.body?.justificativa || '').trim();
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  if (!ACAO_TIPO[tipo]) return res.status(400).json({ error: 'Tipo deve ser "interna" ou "publica"' });
  if (!texto) return res.status(400).json({ error: 'Escreva a mensagem antes de enviar' });
  if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `Mensagem grande demais (máx. ${MAX_TEXTO} caracteres)` });
  try {
    let extra = {};
    if (status) {
      const prep = await prepararStatus(id, status, justificativa);
      if (prep.erro) { await auditar(req, id, `acao_${tipo}`, { tamanho: texto.length, status }, prep.erro); return res.status(400).json({ error: prep.erro }); }
      extra = prep.body;
    }
    const agente = await exigirAgente(req, res);
    if (!agente) return;
    await movidesk('PATCH', '/tickets', {
      query: { id },
      body: { ...extra, actions: [{ type: ACAO_TIPO[tipo], origin: ACAO_ORIGEM, description: texto, createdBy: { id: agente.id } }] },
    });
    const naoMudou = status ? await statusNaoMudou(id, status) : null;
    await sincronizarNoBanco(id);
    await auditar(req, id, `acao_${tipo}`, { tamanho: texto.length, agente: agente.nome, ...(status ? { status, justificativa: justificativa || null } : {}) }, naoMudou);
    if (naoMudou) return res.status(409).json({ error: naoMudou });
    res.json({ ok: true });
  } catch (e) {
    await auditar(req, id, `acao_${tipo}`, { tamanho: texto.length, ...(status ? { status } : {}) }, e.message);
    erroParaResposta(res, e);
  }
});

// Mudança de status (somente valores que existem nos chamados).
// Depois de mexer no chamado pelo Hub, relê o estado real no Movidesk e grava no banco na hora (com o mesmo gravador da carga),
// para o Dashboard (que lê do banco) refletir sem esperar a próxima carga da cron. Nunca derruba a resposta.
async function sincronizarNoBanco(id) {
  try {
    await require('../scripts/movidesk-loader').sincronizarTicket(id);   // mesmo gravador da carga: padrão único no banco
    require('./tickets').limparCache();
  } catch (e) { console.warn('[workspace] não consegui atualizar o banco após a alteração:', e.message); }
}

// Valida uma mudança de status pedida pela tela (existe? exige justificativa? a justificativa é conhecida?).
// Devolve { body } com os campos do PATCH, ou { erro } com a mensagem para o usuário.
async function prepararStatus(id, status, justificativa) {
  const conhecidos = await listaStatus();
  const escolhido = conhecidos.find(x => x.status === status);
  if (!escolhido) return { erro: 'Status desconhecido. Escolha um da lista.' };
  // Justificativas cadastradas no Movidesk da empresa para esse status (por tipo de chamado).
  const tipoT = tipoDoTicket((await movidesk('GET', '/tickets', { query: { id, $select: 'id,type' } }).catch(() => null))?.type);
  const conhecidas = justificativasPorStatus(tipoT)[normStatus(status)] || [];
  // Só é obrigatória quando o status é Parado/Cancelado E existe lista de justificativas para escolher. Um status sem
  // nenhuma justificativa cadastrada (ex.: "Cancelado") o próprio Movidesk aceita sem — não exigimos mais que ele.
  if (['Stopped', 'Canceled'].includes(escolhido.baseStatus) && conhecidas.length && !justificativa) return { erro: `O status "${status}" exige uma justificativa.` };
  // Com justificativas cadastradas para o status, só vale uma delas (nada digitado à mão).
  if (justificativa && conhecidas.length && !conhecidas.includes(justificativa)) return { erro: 'Justificativa desconhecida para esse status. Escolha uma da lista.' };
  const body = { status };
  if (justificativa) body.justification = justificativa;
  return { body };
}
// O Movidesk pode aceitar o PATCH (e gravar a nota) e mesmo assim não aplicar o status — por regra de negócio,
// campo obrigatório ou transição bloqueada. Só damos sucesso se o status realmente mudou.
async function statusNaoMudou(id, status) {
  const depois = await movidesk('GET', '/tickets', { query: { id, $select: 'id,status,justification' } }).catch(() => null);
  if (depois && depois.status && String(depois.status).trim().toLowerCase() !== status.toLowerCase()) {
    return `O Movidesk registrou a nota, mas o status continua "${depois.status}". Isso costuma ser regra do Movidesk (campo obrigatório ou transição bloqueada para "${status}"): confira o chamado lá.`;
  }
  return null;
}

router.post('/:id/workspace/status', requireLeitura, exigirChamadoNoEscopo, exigirEscrita, limiteEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const status = String(req.body?.status || '').trim();
  const justificativa = String(req.body?.justificativa || '').trim();
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  try {
    const prep = await prepararStatus(id, status, justificativa);
    if (prep.erro) { await auditar(req, id, 'status', { para: status }, prep.erro); return res.status(400).json({ error: prep.erro }); }
    const agente = await exigirAgente(req, res);
    if (!agente) return;
    const body = { ...prep.body, actions: [notaDeRastro(agente, `Status alterado para "${status}" pelo Hub 360${justificativa ? ` — ${justificativa}` : ''}.`)] };
    await movidesk('PATCH', '/tickets', { query: { id }, body });
    const naoMudou = await statusNaoMudou(id, status);
    await sincronizarNoBanco(id);
    await auditar(req, id, 'status', { para: status, justificativa: justificativa || null, agente: agente.nome }, naoMudou);
    if (naoMudou) return res.status(409).json({ error: naoMudou });
    res.json({ ok: true });
  } catch (e) {
    await auditar(req, id, 'status', { para: status }, e.message);
    erroParaResposta(res, e);
  }
});

// Troca de responsável.
router.post('/:id/workspace/responsavel', requireLeitura, exigirChamadoNoEscopo, exigirEscrita, limiteEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const paraMim = req.body?.paraMim === true;
  let novoId = String(req.body?.responsavelId || '').trim();
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  if (!paraMim && !novoId) return res.status(400).json({ error: 'Escolha o novo responsável' });
  try {
    const agente = await exigirAgente(req, res);          // quem está logado (agente do Movidesk)
    if (!agente) return;
    if (paraMim) novoId = String(agente.id);
    const novo = (await listaAgentes()).find(a => a.id === novoId) || (paraMim ? { id: String(agente.id), nome: agente.nome, equipes: agente.teams || [] } : null);
    if (!novo) return res.status(400).json({ error: 'Responsável desconhecido. Escolha um da lista.' });
    if (paraMim) {
      const atual = await movidesk('GET', '/tickets', { query: { id, $select: 'id', $expand: 'owner($select=id)' } }).catch(() => null);
      if (atual && atual.owner && String(atual.owner.id) === String(agente.id)) return res.status(409).json({ error: 'Este chamado já está atribuído a você.' });
    }
    // O Movidesk exige trocar responsável E equipe juntos. Mantém a equipe atual do chamado se o
    // novo responsável faz parte dela; senão usa a única equipe dele; com várias, o usuário escolhe.
    const atual = await movidesk('GET', '/tickets', { query: { id, $select: 'id,ownerTeam' } });
    const equipeAtual = String(atual?.ownerTeam || '').trim();
    const pedida = String(req.body?.equipe || '').trim();
    let equipe;
    if (pedida) {
      if (novo.equipes.length && !novo.equipes.includes(pedida)) return res.status(400).json({ error: `${novo.nome} não faz parte da equipe "${pedida}".` });
      equipe = pedida;
    } else if (novo.equipes.includes(equipeAtual)) equipe = equipeAtual;
    else if (novo.equipes.length === 1) equipe = novo.equipes[0];
    else if (novo.equipes.length === 0) equipe = equipeAtual;
    else return res.status(409).json({ error: `${novo.nome} está em mais de uma equipe. Escolha a equipe do chamado.`, equipes: novo.equipes });
    const body = { owner: { id: novo.id }, actions: [notaDeRastro(agente, `Responsável alterado para ${novo.nome}${equipe ? ` (equipe ${equipe})` : ''} pelo Hub 360.`)] };
    if (equipe) body.ownerTeam = equipe;
    await movidesk('PATCH', '/tickets', { query: { id }, body });
    await sincronizarNoBanco(id);
    await auditar(req, id, 'responsavel', { para: novo.nome, equipe, agente: agente.nome });
    res.json({ ok: true });
  } catch (e) {
    await auditar(req, id, 'responsavel', { para: novoId }, e.message);
    erroParaResposta(res, e);
  }
});

module.exports = router;
