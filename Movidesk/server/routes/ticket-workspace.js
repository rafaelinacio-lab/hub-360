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
const { MovideskError, movidesk, agenteDoUsuario, listaAgentes, escopoEquipe } = require('../utils/movideskPeople');
const { authMiddleware } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');

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
function paraHtml(texto) {
  const esc = String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\r?\n/g, '<br>');
}
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
  return { type: ACAO_TIPO.interna, origin: ACAO_ORIGEM, description: texto, htmlDescription: paraHtml(texto), createdBy: { id: agente.id } };
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

// Chamado + conversa, lidos ao vivo do Movidesk.
router.get('/:id/workspace', requireLeitura, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  try {
    const t = await movidesk('GET', '/tickets', {
      query: {
        id,
        $select: 'id,subject,status,baseStatus,justification,createdDate,lastUpdate,ownerTeam,serviceFirstLevel',
        $expand: 'owner($select=id,businessName,userName),clients($select=id,businessName),actions($select=id,type,origin,createdDate,description,htmlDescription;$expand=createdBy($select=id,businessName,profileType))',
      },
    });
    if (!t || !t.id) return res.status(404).json({ error: 'Chamado não encontrado no Movidesk' });
    const papel = await papelDoUsuario(req.user.id);
    const acoes = (Array.isArray(t.actions) ? t.actions : [])
      .map(a => ({
        id: a.id,
        tipo: a.type === 2 ? 'publica' : 'interna',
        origem: a.origin,
        criadoEm: a.createdDate,
        autor: a.createdBy?.businessName || '—',
        autorPerfil: a.createdBy?.profileType ?? null,
        texto: a.description || '',
      }))
      .sort((x, y) => new Date(x.criadoEm) - new Date(y.criadoEm));
    res.json({
      id: t.id,
      assunto: t.subject,
      status: t.status,
      baseStatus: t.baseStatus,
      justificativa: t.justification || null,
      criadoEm: t.createdDate,
      atualizadoEm: t.lastUpdate,
      equipe: t.ownerTeam || null,
      servico: t.serviceFirstLevel || null,
      responsavel: t.owner ? { id: String(t.owner.id), nome: t.owner.businessName } : null,
      clientes: (Array.isArray(t.clients) ? t.clients : []).map(c => c.businessName).filter(Boolean),
      acoes,
      podeInteragir: ROLES_ESCRITA.includes(papel),
    });
  } catch (e) { erroParaResposta(res, e); }
});

// Nota interna ou resposta ao cliente.
router.post('/:id/workspace/acao', requireLeitura, exigirEscrita, limiteEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const tipo = req.body?.tipo;
  const texto = String(req.body?.texto || '').trim();
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  if (!ACAO_TIPO[tipo]) return res.status(400).json({ error: 'Tipo deve ser "interna" ou "publica"' });
  if (!texto) return res.status(400).json({ error: 'Escreva a mensagem antes de enviar' });
  if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `Mensagem grande demais (máx. ${MAX_TEXTO} caracteres)` });
  try {
    const agente = await exigirAgente(req, res);
    if (!agente) return;
    await movidesk('PATCH', '/tickets', {
      query: { id },
      body: { actions: [{ type: ACAO_TIPO[tipo], origin: ACAO_ORIGEM, description: texto, htmlDescription: paraHtml(texto), createdBy: { id: agente.id } }] },
    });
    await auditar(req, id, `acao_${tipo}`, { tamanho: texto.length, agente: agente.nome });
    res.json({ ok: true });
  } catch (e) {
    await auditar(req, id, `acao_${tipo}`, { tamanho: texto.length }, e.message);
    erroParaResposta(res, e);
  }
});

// Mudança de status (somente valores que existem nos chamados).
router.post('/:id/workspace/status', requireLeitura, exigirEscrita, limiteEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const status = String(req.body?.status || '').trim();
  const justificativa = String(req.body?.justificativa || '').trim();
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  try {
    const conhecidos = await listaStatus();
    const escolhido = conhecidos.find(s => s.status === status);
    if (!escolhido) return res.status(400).json({ error: 'Status desconhecido. Escolha um da lista.' });
    const exigeJustificativa = ['Stopped', 'Canceled'].includes(escolhido.baseStatus);
    if (exigeJustificativa && !justificativa) return res.status(400).json({ error: `O status "${status}" exige uma justificativa.` });
    const agente = await exigirAgente(req, res);
    if (!agente) return;
    const body = { status, actions: [notaDeRastro(agente, `Status alterado para "${status}" pelo Hub 360${justificativa ? ` — ${justificativa}` : ''}.`)] };
    if (justificativa) body.justification = justificativa;
    await movidesk('PATCH', '/tickets', { query: { id }, body });
    await auditar(req, id, 'status', { para: status, justificativa: justificativa || null, agente: agente.nome });
    res.json({ ok: true });
  } catch (e) {
    await auditar(req, id, 'status', { para: status }, e.message);
    erroParaResposta(res, e);
  }
});

// Troca de responsável.
router.post('/:id/workspace/responsavel', requireLeitura, exigirEscrita, limiteEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const novoId = String(req.body?.responsavelId || '').trim();
  if (!id) return res.status(400).json({ error: 'Número de chamado inválido' });
  if (!novoId) return res.status(400).json({ error: 'Escolha o novo responsável' });
  try {
    const novo = (await listaAgentes()).find(a => a.id === novoId);
    if (!novo) return res.status(400).json({ error: 'Responsável desconhecido. Escolha um da lista.' });
    const agente = await exigirAgente(req, res);
    if (!agente) return;
    await movidesk('PATCH', '/tickets', {
      query: { id },
      body: { owner: { id: novo.id }, actions: [notaDeRastro(agente, `Responsável alterado para ${novo.nome} pelo Hub 360.`)] },
    });
    await auditar(req, id, 'responsavel', { para: novo.nome, agente: agente.nome });
    res.json({ ok: true });
  } catch (e) {
    await auditar(req, id, 'responsavel', { para: novoId }, e.message);
    erroParaResposta(res, e);
  }
});

module.exports = router;
