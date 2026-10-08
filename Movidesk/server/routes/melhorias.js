'use strict';
// Sugestões de melhoria do próprio Hub 360. Qualquer usuário logado cadastra, apoia (voto) e comenta;
// só o admin avalia, prioriza, acompanha o desenvolvimento e marca como implantada (e vê notas internas).
//  fluxo: nova → em avaliação → aprovada → em desenvolvimento → implantada   (ou recusada)
const express = require('express');
const db = require('../db/remote');
const { authMiddleware } = require('./auth');
const { rateLimit } = require('../utils/rateLimit');
const ia = require('../utils/ai');

const router = express.Router();
router.use(authMiddleware);

const STATUS = { nova: 'Nova', avaliacao: 'Em avaliação', aprovada: 'Aprovada', desenvolvimento: 'Em desenvolvimento', implantada: 'Implantada', recusada: 'Recusada' };
const TIPOS = { melhoria: 'Melhoria', bug: 'Problema / erro', ideia: 'Nova ideia' };
const AREAS = ['Dashboard', 'Central do chamado', 'Incidentes', 'Reincidências', 'Curadoria', 'Ouvidoria', 'GCC', 'Satisfação', 'Jira', 'Painel Geral', 'Configurações', 'Acesso / login', 'Outro'];
const ESFORCOS = ['P', 'M', 'G', 'GG'];
const limiteCriar = rateLimit({ name: 'melhorias/criar', windowMs: 60 * 60 * 1000, max: 15 });
const limiteComentar = rateLimit({ name: 'melhorias/comentar', windowMs: 10 * 60 * 1000, max: 30 });

let prontas = null;
router.use(async (req, res, next) => {
  try {
    if (!prontas) prontas = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS public.melhoria (
        id SERIAL PRIMARY KEY, titulo TEXT NOT NULL, descricao TEXT NOT NULL, beneficio TEXT, tipo TEXT NOT NULL DEFAULT 'melhoria', area TEXT,
        status TEXT NOT NULL DEFAULT 'nova', prioridade SMALLINT, esforco TEXT, resposta TEXT, previsao DATE, responsavel TEXT,
        nota_implantacao TEXT, implantada_em TIMESTAMPTZ, duplicada_de INTEGER,
        criado_por INTEGER NOT NULL, criado_por_nome TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.query(`CREATE TABLE IF NOT EXISTS public.melhoria_voto (melhoria_id INTEGER NOT NULL REFERENCES public.melhoria(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (melhoria_id, user_id))`);
      await db.query(`CREATE TABLE IF NOT EXISTS public.melhoria_comentario (id BIGSERIAL PRIMARY KEY, melhoria_id INTEGER NOT NULL REFERENCES public.melhoria(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, autor_nome TEXT, admin BOOLEAN NOT NULL DEFAULT FALSE, interno BOOLEAN NOT NULL DEFAULT FALSE, texto TEXT NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.query(`CREATE TABLE IF NOT EXISTS public.melhoria_evento (id BIGSERIAL PRIMARY KEY, melhoria_id INTEGER NOT NULL REFERENCES public.melhoria(id) ON DELETE CASCADE, tipo TEXT NOT NULL, texto TEXT, autor_nome TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.query(`ALTER TABLE public.melhoria ADD COLUMN IF NOT EXISTS analise_ia JSONB, ADD COLUMN IF NOT EXISTS analise_ia_em TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS analise_aprovada_por TEXT, ADD COLUMN IF NOT EXISTS analise_aprovada_em TIMESTAMPTZ`);
      await db.query(`CREATE INDEX IF NOT EXISTS ix_melhoria_status ON public.melhoria (status, criado_em DESC)`);
    })().catch((e) => { prontas = null; throw e; });
    await prontas;
    const u = (await db.query(`SELECT u.id, u.name, u.email, r.name AS papel FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user.id])).rows[0];
    if (!u) return res.status(401).json({ error: 'Usuário não encontrado' });
    req.eu = { id: u.id, email: u.email, nome: u.name || u.email, papel: u.papel, admin: u.papel === 'admin' };
    next();
  } catch (e) { res.status(500).json({ error: 'Erro ao preparar as sugestões: ' + e.message }); }
});

const erro = (res, e) => (console.error('[melhorias]', e), res.status(500).json({ error: e.message || 'Erro inesperado' }));
const idv = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const txt = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
const soAdmin = (req, res, next) => (req.eu.admin ? next() : res.status(403).json({ error: 'Somente administradores podem avaliar e acompanhar sugestões.' }));
async function evento(id, req, tipo, texto) {
  await db.query(`INSERT INTO public.melhoria_evento (melhoria_id, tipo, texto, autor_nome) VALUES ($1,$2,$3,$4)`, [id, tipo, texto || null, req.eu.nome]);
}
const codigo = (id) => `MEL-${String(id).padStart(4, '0')}`;
// a análise da IA é só do admin: nunca sai nas listas/detalhes comuns
const fmt = (m, euId) => { const { analise_ia, analise_ia_em, analise_aprovada_por, analise_aprovada_em, ...resto } = m; return { ...resto, codigo: codigo(m.id), rotuloStatus: STATUS[m.status] || m.status, minha: m.criado_por === euId }; };

router.get('/config', async (req, res) => {
  res.json({ eu: { nome: req.eu.nome, admin: req.eu.admin }, status: STATUS, tipos: TIPOS, areas: AREAS, esforcos: ESFORCOS });
});

router.get('/', async (req, res) => {
  try {
    const where = [], params = [req.eu.id];
    if (STATUS[req.query.status]) { params.push(req.query.status); where.push(`m.status = $${params.length}`); }
    if (req.query.area) { params.push(String(req.query.area)); where.push(`m.area = $${params.length}`); }
    if (TIPOS[req.query.tipo]) { params.push(req.query.tipo); where.push(`m.tipo = $${params.length}`); }
    if (req.query.meus === '1') where.push('m.criado_por = $1');
    const q = txt(req.query.q, 80).toLowerCase();
    if (q) { params.push(`%${q}%`); where.push(`(lower(m.titulo) LIKE $${params.length} OR lower(m.descricao) LIKE $${params.length} OR lower(COALESCE(m.criado_por_nome,'')) LIKE $${params.length})`); }
    const ordem = req.query.ordem === 'recentes' ? 'm.criado_em DESC' : 'votos DESC, m.criado_em DESC';
    const r = await db.query(`
      SELECT m.*, (SELECT COUNT(*) FROM public.melhoria_voto v WHERE v.melhoria_id = m.id)::int AS votos,
             EXISTS (SELECT 1 FROM public.melhoria_voto v WHERE v.melhoria_id = m.id AND v.user_id = $1) AS eu_votei,
             (SELECT COUNT(*) FROM public.melhoria_comentario c WHERE c.melhoria_id = m.id AND (NOT c.interno OR ${req.eu.admin ? 'TRUE' : 'FALSE'}))::int AS n_comentarios
        FROM public.melhoria m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${ordem} LIMIT 500`, params);
    const cont = (await db.query(`SELECT status, COUNT(*)::int AS n FROM public.melhoria GROUP BY 1`)).rows;
    res.json({ melhorias: r.rows.map((m) => fmt(m, req.eu.id)), contagem: Object.fromEntries(cont.map((c) => [c.status, c.n])) });
  } catch (e) { erro(res, e); }
});

router.get('/:id(\\d+)', async (req, res) => {
  const id = idv(req.params.id);
  try {
    const m = (await db.query(`SELECT m.*, (SELECT COUNT(*) FROM public.melhoria_voto v WHERE v.melhoria_id = m.id)::int AS votos,
        EXISTS (SELECT 1 FROM public.melhoria_voto v WHERE v.melhoria_id = m.id AND v.user_id = $2) AS eu_votei FROM public.melhoria m WHERE m.id = $1`, [id, req.eu.id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Sugestão não encontrada' });
    const com = (await db.query(`SELECT id, autor_nome, admin, interno, texto, criado_em FROM public.melhoria_comentario WHERE melhoria_id = $1 AND (NOT interno OR $2) ORDER BY id`, [id, req.eu.admin])).rows;
    const ev = (await db.query(`SELECT tipo, texto, autor_nome, criado_em FROM public.melhoria_evento WHERE melhoria_id = $1 ORDER BY id DESC`, [id])).rows;
    // notas internas nos eventos só aparecem para o admin
    const out = { melhoria: fmt(m, req.eu.id), comentarios: com, eventos: ev.filter((e) => req.eu.admin || e.tipo !== 'interno') };
    if (req.eu.admin) out.analise = m.analise_ia ? { ...m.analise_ia, geradaEm: m.analise_ia_em, aprovadaPor: m.analise_aprovada_por, aprovadaEm: m.analise_aprovada_em } : null;
    res.json(out);
  } catch (e) { erro(res, e); }
});

router.post('/', limiteCriar, async (req, res) => {
  const b = req.body || {};
  const titulo = txt(b.titulo, 140), descricao = txt(b.descricao, 4000);
  if (titulo.length < 8) return res.status(400).json({ error: 'Dê um título para a sugestão (mínimo 8 caracteres).' });
  if (descricao.length < 20) return res.status(400).json({ error: 'Descreva a sugestão com um pouco mais de detalhe (mínimo 20 caracteres).' });
  const tipo = TIPOS[b.tipo] ? b.tipo : 'melhoria', area = AREAS.includes(b.area) ? b.area : 'Outro';
  try {
    const dup = (await db.query(`SELECT id, titulo FROM public.melhoria WHERE criado_por = $1 AND lower(titulo) = lower($2) AND criado_em > NOW() - INTERVAL '1 day'`, [req.eu.id, titulo])).rows[0];
    if (dup) return res.status(409).json({ error: `Você já cadastrou esta sugestão (${codigo(dup.id)}).` });
    const r = await db.query(`INSERT INTO public.melhoria (titulo, descricao, beneficio, tipo, area, criado_por, criado_por_nome) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [titulo, descricao, txt(b.beneficio, 1000) || null, tipo, area, req.eu.id, req.eu.nome]);
    await evento(r.rows[0].id, req, 'criada', `Sugestão cadastrada por ${req.eu.nome}.`);
    await db.query(`INSERT INTO public.melhoria_voto (melhoria_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.rows[0].id, req.eu.id]);
    res.status(201).json({ melhoria: fmt(r.rows[0], req.eu.id) });
    // já deixa a estrutura pronta para o admin aprovar (segundo plano; se a IA não estiver configurada ou falhar, nada acontece)
    analisarComIa(r.rows[0].id, req.eu.email).catch((e) => console.warn('[melhorias] análise automática da IA ignorada:', e.message));
  } catch (e) { erro(res, e); }
});

// o autor edita enquanto ainda está "Nova"; o admin edita sempre
router.patch('/:id(\\d+)', async (req, res) => {
  const id = idv(req.params.id), b = req.body || {};
  try {
    const m = (await db.query(`SELECT * FROM public.melhoria WHERE id = $1`, [id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Sugestão não encontrada' });
    if (!req.eu.admin && (m.criado_por !== req.eu.id || m.status !== 'nova')) return res.status(403).json({ error: 'Só o autor pode editar, e apenas enquanto a sugestão está “Nova”.' });
    const titulo = b.titulo !== undefined ? txt(b.titulo, 140) : m.titulo, descricao = b.descricao !== undefined ? txt(b.descricao, 4000) : m.descricao;
    if (titulo.length < 8 || descricao.length < 20) return res.status(400).json({ error: 'Título (mín. 8) e descrição (mín. 20 caracteres) são obrigatórios.' });
    await db.query(`UPDATE public.melhoria SET titulo=$2, descricao=$3, beneficio=$4, tipo=$5, area=$6, atualizado_em=NOW() WHERE id=$1`,
      [id, titulo, descricao, b.beneficio !== undefined ? (txt(b.beneficio, 1000) || null) : m.beneficio, TIPOS[b.tipo] ? b.tipo : m.tipo, AREAS.includes(b.area) ? b.area : m.area]);
    await evento(id, req, 'editada', `Sugestão editada por ${req.eu.nome}.`);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

router.delete('/:id(\\d+)', async (req, res) => {
  const id = idv(req.params.id);
  try {
    const m = (await db.query(`SELECT criado_por, status FROM public.melhoria WHERE id = $1`, [id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Sugestão não encontrada' });
    if (!req.eu.admin && (m.criado_por !== req.eu.id || m.status !== 'nova')) return res.status(403).json({ error: 'Só o autor pode excluir, e apenas enquanto a sugestão está “Nova”.' });
    await db.query(`DELETE FROM public.melhoria WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

router.post('/:id(\\d+)/voto', async (req, res) => {
  const id = idv(req.params.id);
  try {
    const m = (await db.query(`SELECT status FROM public.melhoria WHERE id = $1`, [id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Sugestão não encontrada' });
    if (['implantada', 'recusada'].includes(m.status)) return res.status(409).json({ error: 'Esta sugestão já foi encerrada.' });
    const del = await db.query(`DELETE FROM public.melhoria_voto WHERE melhoria_id = $1 AND user_id = $2 RETURNING 1`, [id, req.eu.id]);
    if (!del.rows[0]) await db.query(`INSERT INTO public.melhoria_voto (melhoria_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, req.eu.id]);
    const n = (await db.query(`SELECT COUNT(*)::int AS n FROM public.melhoria_voto WHERE melhoria_id = $1`, [id])).rows[0].n;
    res.json({ eu_votei: !del.rows[0], votos: n });
  } catch (e) { erro(res, e); }
});

router.post('/:id(\\d+)/comentarios', limiteComentar, async (req, res) => {
  const id = idv(req.params.id), texto = txt(req.body?.texto, 2000);
  const interno = req.eu.admin && req.body?.interno === true;
  if (texto.length < 2) return res.status(400).json({ error: 'Escreva o comentário.' });
  try {
    if (!(await db.query(`SELECT 1 FROM public.melhoria WHERE id = $1`, [id])).rows[0]) return res.status(404).json({ error: 'Sugestão não encontrada' });
    await db.query(`INSERT INTO public.melhoria_comentario (melhoria_id, user_id, autor_nome, admin, interno, texto) VALUES ($1,$2,$3,$4,$5,$6)`, [id, req.eu.id, req.eu.nome, req.eu.admin, interno, texto]);
    await db.query(`UPDATE public.melhoria SET atualizado_em = NOW() WHERE id = $1`, [id]);
    res.status(201).json({ ok: true });
  } catch (e) { erro(res, e); }
});

// ── administração: avaliar, priorizar, acompanhar desenvolvimento e implantar ──
router.patch('/:id(\\d+)/avaliacao', soAdmin, async (req, res) => {
  const id = idv(req.params.id), b = req.body || {};
  try {
    const m = (await db.query(`SELECT * FROM public.melhoria WHERE id = $1`, [id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Sugestão não encontrada' });
    const status = b.status === undefined ? m.status : (STATUS[b.status] ? b.status : null);
    if (!status) return res.status(400).json({ error: 'Status inválido.' });
    const resposta = b.resposta !== undefined ? txt(b.resposta, 2000) : (m.resposta || '');
    const nota = b.nota_implantacao !== undefined ? txt(b.nota_implantacao, 2000) : (m.nota_implantacao || '');
    if (status === 'recusada' && !resposta) return res.status(400).json({ error: 'Explique ao autor por que a sugestão foi recusada (campo “Resposta ao autor”).' });
    if (status === 'implantada' && !nota) return res.status(400).json({ error: 'Descreva o que foi implantado (campo “Nota de implantação”) para o autor saber o que mudou.' });
    const prioridade = b.prioridade === undefined ? m.prioridade : ([1, 2, 3, 4].includes(Number(b.prioridade)) ? Number(b.prioridade) : null);
    const esforco = b.esforco === undefined ? m.esforco : (ESFORCOS.includes(b.esforco) ? b.esforco : null);
    const previsao = b.previsao === undefined ? m.previsao : (/^\d{4}-\d{2}-\d{2}$/.test(String(b.previsao)) ? b.previsao : null);
    const responsavel = b.responsavel !== undefined ? (txt(b.responsavel, 80) || null) : m.responsavel;
    const dup = b.duplicada_de === undefined ? m.duplicada_de : (idv(b.duplicada_de) && idv(b.duplicada_de) !== id ? idv(b.duplicada_de) : null);
    await db.query(`UPDATE public.melhoria SET status=$2, prioridade=$3, esforco=$4, previsao=$5, responsavel=$6, resposta=$7, nota_implantacao=$8, duplicada_de=$9, atualizado_em=NOW(),
        implantada_em = CASE WHEN $2 = 'implantada' THEN COALESCE(implantada_em, NOW()) ELSE NULL END WHERE id=$1`,
      [id, status, prioridade, esforco, previsao, responsavel, resposta || null, nota || null, dup]);
    if (status !== m.status) await evento(id, req, 'status', `${STATUS[m.status]} → ${STATUS[status]} (${req.eu.nome})${status === 'recusada' ? ` — ${resposta}` : ''}${status === 'implantada' ? ` — ${nota}` : ''}`);
    else await evento(id, req, 'avaliacao', `Avaliação atualizada por ${req.eu.nome}.`);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});


// ── IA: entende a solicitação e monta a estrutura (Rotina, Motivo, Especificação, Plano de testes) para o admin aprovar ──
// A IA só propõe um RASCUNHO; nada muda de status sozinho. O texto da sugestão e dos comentários é dado, nunca instrução.
const limiteIa = rateLimit({ name: 'melhorias/ia', windowMs: 10 * 60 * 1000, max: 20 });
const SISTEMA_IA = [ia.REGRAS,
  'Você analisa sugestões de melhoria do Hub 360, o painel interno da Viasoft para o Movidesk (Dashboard de chamados, Central do chamado, Incidentes, Reincidências, Curadoria, Ouvidoria, GCC, Satisfação, Jira, Painel Geral, Painel TV, Configurações).',
  'Seu trabalho: entender o que a pessoa precisa, separar o problema da solução proposta e montar uma tarefa padronizada para a equipe de desenvolvimento aprovar.',
  'Responda SOMENTE um JSON com as chaves: entendimento (2 a 4 frases: o que foi pedido e por que importa), tipo (melhoria|bug|ideia), area (uma das áreas informadas), prioridade (1 urgente a 4 baixa), esforco (P, M, G ou GG), justificativa (1 frase explicando prioridade e esforço),',
  'rotina (nome curto da funcionalidade, no infinitivo ou substantivo), motivo (3 a 6 linhas em linguagem de negócio: "O usuário precisa de X porque Y, de forma que Z"; sem detalhe técnico), especificacao (lista de itens curtos e atômicos, cada um com verbo no infinitivo: Permitir, Exibir, Validar...; o que o sistema deve fazer, sem ditar como implementar),',
  'planoTestes (lista de cenários no formato "Dado ..., quando ..., então ...", com ao menos um de sucesso, um de erro e um de validação de regra), perguntas (lista do que falta saber para desenvolver sem chute; vazia se estiver claro), riscos (lista curta de riscos ou impactos em outras áreas; pode ser vazia), duplicadas (lista de {codigo, motivo} só com códigos que existam na lista de sugestões existentes e tratem do MESMO assunto; vazia se não houver).',
  'Seja realista no esforço: P = ajuste pequeno de tela ou texto; M = funcionalidade nova simples; G = funcionalidade com banco, rota e tela; GG = mudança grande ou integração externa.',
  'Se a sugestão estiver vaga, faça a melhor interpretação razoável, deixe claro no entendimento e liste as dúvidas em perguntas.'].join(' ');

const lista = (v, max, tam) => (Array.isArray(v) ? v : []).map((x) => txt(typeof x === 'string' ? x : (x && (x.texto || x.item)) || '', tam)).filter(Boolean).slice(0, max);
async function analisarComIa(id, userEmail) {
  const m = (await db.query(`SELECT m.*, (SELECT COUNT(*) FROM public.melhoria_voto v WHERE v.melhoria_id = m.id)::int AS votos FROM public.melhoria m WHERE m.id = $1`, [id])).rows[0];
  if (!m) throw Object.assign(new Error('Sugestão não encontrada'), { status: 404 });
  const coms = (await db.query(`SELECT autor_nome, admin, texto FROM public.melhoria_comentario WHERE melhoria_id = $1 ORDER BY id LIMIT 20`, [id])).rows;
  const outras = (await db.query(`SELECT id, titulo, status, area FROM public.melhoria WHERE id <> $1 ORDER BY criado_em DESC LIMIT 60`, [id])).rows;
  const codigos = new Set(outras.map((o) => codigo(o.id)));
  const usuario = [
    `Áreas válidas: ${AREAS.join(', ')}`,
    ia.dados('SUGESTAO', `Título: ${m.titulo}\nTipo informado: ${TIPOS[m.tipo] || m.tipo}\nÁrea informada: ${m.area || '—'}\nApoios: ${m.votos}\n\nDescrição:\n${ia.limitar(m.descricao, 4000)}\n\nBenefício informado:\n${ia.limitar(m.beneficio || '(não informado)', 1000)}`),
    coms.length ? ia.dados('COMENTARIOS', coms.map((c) => `${c.autor_nome}${c.admin ? ' (administração)' : ''}: ${ia.limitar(c.texto, 600)}`).join('\n')) : '',
    ia.dados('SUGESTOES_EXISTENTES', outras.map((o) => `${codigo(o.id)} [${STATUS[o.status] || o.status}] ${o.titulo}`).join('\n') || '(nenhuma)'),
  ].filter(Boolean).join('\n\n');
  const r = await ia.chamarIA({ source: 'melhorias', system: SISTEMA_IA, user: usuario, maxTokens: 1800, temperature: 0.3, userEmail, meta: { melhoria: id } });
  const analise = {
    entendimento: txt(r.entendimento, 900),
    tipo: TIPOS[r.tipo] ? r.tipo : m.tipo,
    area: AREAS.includes(r.area) ? r.area : (m.area || 'Outro'),
    prioridade: [1, 2, 3, 4].includes(Number(r.prioridade)) ? Number(r.prioridade) : null,
    esforco: ESFORCOS.includes(String(r.esforco).toUpperCase()) ? String(r.esforco).toUpperCase() : null,
    justificativa: txt(r.justificativa, 400),
    rotina: txt(r.rotina, 120), motivo: txt(r.motivo, 1500),
    especificacao: lista(r.especificacao, 20, 300), planoTestes: lista(r.planoTestes, 15, 400),
    perguntas: lista(r.perguntas, 8, 300), riscos: lista(r.riscos, 6, 300),
    duplicadas: (Array.isArray(r.duplicadas) ? r.duplicadas : []).map((d) => ({ codigo: txt(d && d.codigo, 12), motivo: txt(d && d.motivo, 200) })).filter((d) => codigos.has(d.codigo)).slice(0, 5),
  };
  if (!analise.rotina || !analise.especificacao.length) throw Object.assign(new Error('A IA não conseguiu montar a estrutura desta sugestão. Complemente a descrição e tente de novo.'), { status: 502 });
  await db.query(`UPDATE public.melhoria SET analise_ia = $2, analise_ia_em = NOW(), analise_aprovada_por = NULL, analise_aprovada_em = NULL WHERE id = $1`, [id, JSON.stringify(analise)]);
  return analise;
}
const erroIa = (res, e) => (e && e.status ? res.status(e.status).json({ error: e.message }) : erro(res, e));

router.post('/:id(\\d+)/analise-ia', soAdmin, limiteIa, async (req, res) => {
  const id = idv(req.params.id);
  try {
    const analise = await analisarComIa(id, req.eu.email);
    await evento(id, req, 'ia', `Estrutura gerada pela IA (por ${req.eu.nome}) — aguardando aprovação.`);
    res.json({ analise });
  } catch (e) { erroIa(res, e); }
});

// salva a estrutura editada pelo admin (campos livres, validados)
router.put('/:id(\\d+)/analise', soAdmin, async (req, res) => {
  const id = idv(req.params.id), b = req.body || {};
  try {
    const m = (await db.query(`SELECT analise_ia FROM public.melhoria WHERE id = $1`, [id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Sugestão não encontrada' });
    const a = m.analise_ia || {};
    const novo = { ...a,
      rotina: txt(b.rotina, 120) || a.rotina || '', motivo: txt(b.motivo, 1500),
      especificacao: lista(b.especificacao, 30, 400), planoTestes: lista(b.planoTestes, 20, 500),
      prioridade: [1, 2, 3, 4].includes(Number(b.prioridade)) ? Number(b.prioridade) : null,
      esforco: ESFORCOS.includes(b.esforco) ? b.esforco : null, editadaPor: req.eu.nome };
    if (!novo.rotina || !novo.especificacao.length) return res.status(400).json({ error: 'A rotina e ao menos um item da especificação são obrigatórios.' });
    await db.query(`UPDATE public.melhoria SET analise_ia = $2, analise_aprovada_por = NULL, analise_aprovada_em = NULL WHERE id = $1`, [id, JSON.stringify(novo)]);
    res.json({ analise: novo });
  } catch (e) { erro(res, e); }
});

// aprova a estrutura: grava prioridade/esforço, passa para "Aprovada" e deixa registrado quem aprovou
router.post('/:id(\\d+)/analise/aprovar', soAdmin, async (req, res) => {
  const id = idv(req.params.id);
  try {
    const m = (await db.query(`SELECT status, analise_ia FROM public.melhoria WHERE id = $1`, [id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Sugestão não encontrada' });
    if (!m.analise_ia) return res.status(400).json({ error: 'Gere a análise da IA antes de aprovar.' });
    if (['implantada', 'recusada'].includes(m.status)) return res.status(409).json({ error: 'Esta sugestão já foi encerrada.' });
    const a = m.analise_ia;
    await db.query(`UPDATE public.melhoria SET status = CASE WHEN status IN ('nova','avaliacao') THEN 'aprovada' ELSE status END,
        prioridade = COALESCE($2, prioridade), esforco = COALESCE($3, esforco), tipo = $4, area = $5,
        analise_aprovada_por = $6, analise_aprovada_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
      [id, a.prioridade || null, a.esforco || null, TIPOS[a.tipo] ? a.tipo : 'melhoria', AREAS.includes(a.area) ? a.area : 'Outro', req.eu.nome]);
    await evento(id, req, 'status', `Estrutura aprovada por ${req.eu.nome}${m.status === 'nova' || m.status === 'avaliacao' ? ` — ${STATUS[m.status]} → Aprovada` : ''}.`);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

module.exports = router;
