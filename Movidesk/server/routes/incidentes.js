'use strict';
// Gerenciamento de incidentes (ITIL): um incidente agrupa N chamados do mesmo problema de serviço.
//
//  - prioridade = matriz impacto × urgência (P1 a P4); metas de reconhecimento e resolução por prioridade;
//  - ciclo de vida: aberto → investigando → mitigado → resolvido → fechado (reabrir volta a investigando);
//  - cada chamado pertence a no máximo um incidente (mover exige confirmação);
//  - toda mudança vira um evento na linha do tempo (quem, quando, o quê);
//  - leitura: aba "incidentes"; escrita: perfis admin/supervisor/atendente.
const express = require('express');
const db = require('../db/remote');
const { requireTabAccess } = require('./config');
const { authMiddleware } = require('./auth');
const { rateLimit, rateLimitDinamico } = require('../utils/rateLimit');
const cfg = require('../utils/aiSettings');
const { chamarIA, configurada: iaConfigurada, IaError, REGRAS, dados, limitar, dataBr } = require('../utils/ai');

const router = express.Router();
router.use(authMiddleware);

const requireLeitura = requireTabAccess('incidentes');
const ROLES_ESCRITA = ['admin', 'supervisor', 'atendente'];

// impacto/urgência: 1 = alto, 2 = médio, 3 = baixo
const MATRIZ = { '1-1': 1, '1-2': 2, '1-3': 3, '2-1': 2, '2-2': 3, '2-3': 4, '3-1': 3, '3-2': 4, '3-3': 4 };
// metas em minutos, por prioridade
const METAS = {
  1: { reconhecer: 15, resolver: 4 * 60 },
  2: { reconhecer: 30, resolver: 8 * 60 },
  3: { reconhecer: 2 * 60, resolver: 24 * 60 },
  4: { reconhecer: 8 * 60, resolver: 72 * 60 },
};
const STATUS = ['aberto', 'investigando', 'mitigado', 'resolvido', 'fechado'];
const TRANSICOES = {
  aberto: ['investigando', 'mitigado', 'resolvido'],
  investigando: ['mitigado', 'resolvido'],
  mitigado: ['investigando', 'resolvido'],
  resolvido: ['investigando', 'fechado'],
  fechado: [],
};
const ROTULO_STATUS = { aberto: 'Aberto', investigando: 'Investigando', mitigado: 'Mitigado', resolvido: 'Resolvido', fechado: 'Fechado' };

function prioridadeDe(impacto, urgencia) { return MATRIZ[`${impacto}-${urgencia}`] || 3; }
const nivelValido = (v) => [1, 2, 3].includes(Number(v));
const codigoDe = (id) => `INC-${String(id).padStart(5, '0')}`;

// ── tabelas ─────────────────────────────────────────────────────────────────
let tabelasPromise = null;
function garantirTabelas() {
  if (!tabelasPromise) {
    tabelasPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.incidente (
          id              SERIAL PRIMARY KEY,
          titulo          TEXT NOT NULL,
          descricao       TEXT,
          servico         TEXT,
          impacto         SMALLINT NOT NULL DEFAULT 2,
          urgencia        SMALLINT NOT NULL DEFAULT 2,
          prioridade      SMALLINT NOT NULL DEFAULT 3,
          status          TEXT NOT NULL DEFAULT 'aberto',
          grave           BOOLEAN NOT NULL DEFAULT FALSE,
          responsavel_id  INTEGER,
          criado_por      INTEGER,
          aberto_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reconhecido_em  TIMESTAMPTZ,
          mitigado_em     TIMESTAMPTZ,
          resolvido_em    TIMESTAMPTZ,
          fechado_em      TIMESTAMPTZ,
          causa           TEXT,
          contorno        TEXT,
          resolucao       TEXT,
          problema_ref    TEXT,
          atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.incidente_ticket (
          incidente_id  INTEGER NOT NULL REFERENCES public.incidente(id) ON DELETE CASCADE,
          ticket_id     BIGINT NOT NULL UNIQUE,
          vinculado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          vinculado_por INTEGER,
          PRIMARY KEY (incidente_id, ticket_id)
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.incidente_evento (
          id            BIGSERIAL PRIMARY KEY,
          incidente_id  INTEGER NOT NULL REFERENCES public.incidente(id) ON DELETE CASCADE,
          tipo          TEXT NOT NULL,
          texto         TEXT,
          autor_id      INTEGER,
          autor_nome    TEXT,
          criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS ix_incidente_status ON public.incidente (status, prioridade, aberto_em DESC)`);
      await db.query(`CREATE INDEX IF NOT EXISTS ix_incidente_evento_inc ON public.incidente_evento (incidente_id, criado_em)`);
    })().catch((e) => { tabelasPromise = null; throw e; });
  }
  return tabelasPromise;
}
router.use(async (req, res, next) => {
  try { await garantirTabelas(); next(); } catch (e) {
    console.error('[incidentes] não consegui preparar as tabelas:', e.message);
    res.status(500).json({ error: 'Erro ao preparar as tabelas de incidentes: ' + e.message });
  }
});

// ── permissões / utilitários ────────────────────────────────────────────────
async function exigirEscrita(req, res, next) {
  try {
    const r = await db.query(`SELECT u.name, r.name AS papel FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user.id]);
    const u = r.rows[0];
    if (!u || !ROLES_ESCRITA.includes(u.papel)) return res.status(403).json({ error: 'Seu perfil pode acompanhar os incidentes, mas não alterá-los.' });
    req.userName = u.name || req.user.email;
    req.papel = u.papel;
    next();
  } catch (e) { res.status(500).json({ error: 'Erro ao verificar permissão' }); }
}
async function evento(incidenteId, req, tipo, texto) {
  await db.query(
    `INSERT INTO public.incidente_evento (incidente_id, tipo, texto, autor_id, autor_nome) VALUES ($1,$2,$3,$4,$5)`,
    [incidenteId, tipo, texto || null, req.user.id, req.userName || req.user.email]
  );
}
const idValido = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
function listaTickets(v) {
  const brutos = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return [...new Set(brutos.map((x) => Number(String(x).replace(/\D/g, ''))).filter((n) => Number.isInteger(n) && n > 0))];
}
function erro(res, e) {
  console.error('[incidentes]', e);
  return res.status(500).json({ error: e.message || 'Erro inesperado' });
}

// Estado das metas de SLA do incidente (em minutos) — usado pela lista e pelo detalhe.
function slaDoIncidente(i) {
  const meta = METAS[i.prioridade] || METAS[3];
  const abertoMs = new Date(i.aberto_em).getTime();
  const agora = Date.now();
  const estado = (alvoMin, fimEm, encerrado) => {
    const limite = abertoMs + alvoMin * 60000;
    if (fimEm) { const fim = new Date(fimEm).getTime(); return { estado: fim <= limite ? 'cumprido' : 'estourado', restanteMin: Math.round((limite - fim) / 60000), alvoMin }; }
    if (encerrado) return { estado: 'nao_aplica', restanteMin: null, alvoMin };
    return { estado: agora <= limite ? 'no_prazo' : 'estourado', restanteMin: Math.round((limite - agora) / 60000), alvoMin };
  };
  const encerrado = i.status === 'fechado';
  return {
    reconhecer: estado(meta.reconhecer, i.reconhecido_em, encerrado),
    resolver: estado(meta.resolver, i.resolvido_em, encerrado),
  };
}
function formatarIncidente(i) {
  return { ...i, codigo: codigoDe(i.id), rotuloStatus: ROTULO_STATUS[i.status] || i.status, sla: slaDoIncidente(i) };
}

// ── listas de apoio ─────────────────────────────────────────────────────────
router.get('/config', requireLeitura, async (req, res) => {
  try {
    const r = await db.query(`SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.user.id]);
    res.json({
      matriz: MATRIZ, metas: METAS, status: STATUS, transicoes: TRANSICOES, rotuloStatus: ROTULO_STATUS,
      podeEscrever: ROLES_ESCRITA.includes(r.rows[0]?.name),
    });
  } catch (e) { erro(res, e); }
});

let cacheServicos = { ate: 0, lista: [] };
router.get('/servicos', requireLeitura, async (req, res) => {
  try {
    if (cacheServicos.ate < Date.now()) {
      const r = await db.query(`
        SELECT split_part(service_full, ' > ', 1) AS s, COUNT(*)::int AS n FROM silver.ticket
         WHERE createddate >= NOW() - INTERVAL '120 days' AND service_full IS NOT NULL AND service_full <> ''
         GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY 2 DESC LIMIT 200`);
      cacheServicos = { ate: Date.now() + 10 * 60 * 1000, lista: r.rows.map((x) => x.s).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt')) };
    }
    res.json({ servicos: cacheServicos.lista });
  } catch (e) { erro(res, e); }
});

router.get('/responsaveis', requireLeitura, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = TRUE AND r.name = ANY($1::text[]) ORDER BY u.name`, [ROLES_ESCRITA]);
    res.json({ responsaveis: r.rows });
  } catch (e) { erro(res, e); }
});

// Indicadores: ativos por prioridade, graves, MTTA/MTTR e cumprimento de meta (últimos 30 dias).
router.get('/metricas', requireLeitura, async (req, res) => {
  try {
    const ativos = await db.query(`
      SELECT prioridade, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE grave)::int AS graves
        FROM public.incidente WHERE status NOT IN ('resolvido','fechado') GROUP BY 1 ORDER BY 1`);
    const lista = await db.query(`SELECT * FROM public.incidente WHERE status NOT IN ('resolvido','fechado')`);
    const estourados = lista.rows.map(slaDoIncidente).filter((s) => s.reconhecer.estado === 'estourado' || s.resolver.estado === 'estourado').length;
    const janela = await db.query(`
      SELECT prioridade, aberto_em, reconhecido_em, resolvido_em FROM public.incidente
       WHERE aberto_em >= NOW() - INTERVAL '30 days'`);
    const med = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    const mtta = [], mttr = []; let okA = 0, totA = 0, okR = 0, totR = 0;
    for (const i of janela.rows) {
      const meta = METAS[i.prioridade] || METAS[3];
      if (i.reconhecido_em) {
        const m = (new Date(i.reconhecido_em) - new Date(i.aberto_em)) / 60000; mtta.push(m); totA++; if (m <= meta.reconhecer) okA++;
      }
      if (i.resolvido_em) {
        const m = (new Date(i.resolvido_em) - new Date(i.aberto_em)) / 60000; mttr.push(m); totR++; if (m <= meta.resolver) okR++;
      }
    }
    res.json({
      ativosPorPrioridade: ativos.rows,
      totalAtivos: ativos.rows.reduce((a, b) => a + b.n, 0),
      gravesAtivos: ativos.rows.reduce((a, b) => a + b.graves, 0),
      comMetaEstourada: estourados,
      mttaMin: med(mtta), mttrMin: med(mttr),
      cumprimentoReconhecimento: totA ? Math.round((okA / totA) * 100) : null,
      cumprimentoResolucao: totR ? Math.round((okR / totR) * 100) : null,
      abertosNaJanela: janela.rows.length,
    });
  } catch (e) { erro(res, e); }
});

// Incidente ao qual um chamado está ligado (usado pela Central do chamado).
router.get('/por-ticket/:ticketId', requireLeitura, async (req, res) => {
  const tid = idValido(req.params.ticketId);
  if (!tid) return res.status(400).json({ error: 'Número de chamado inválido' });
  try {
    const r = await db.query(`
      SELECT i.* FROM public.incidente_ticket it JOIN public.incidente i ON i.id = it.incidente_id WHERE it.ticket_id = $1`, [tid]);
    res.json({ incidente: r.rows[0] ? formatarIncidente(r.rows[0]) : null });
  } catch (e) { erro(res, e); }
});

// ── lista ───────────────────────────────────────────────────────────────────
router.get('/', requireLeitura, async (req, res) => {
  try {
    const where = [];
    const params = [];
    const escopo = String(req.query.escopo || 'abertos');
    if (escopo === 'abertos') where.push(`i.status NOT IN ('resolvido','fechado')`);
    else if (escopo === 'encerrados') where.push(`i.status IN ('resolvido','fechado')`);
    if (req.query.grave === '1') where.push('i.grave = TRUE');
    if (req.query.servico) { params.push(String(req.query.servico)); where.push(`i.servico = $${params.length}`); }
    const q = String(req.query.q || '').trim();
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const n = /^\d+$/.test(q.replace(/^inc-?0*/i, '')) ? Number(q.replace(/^inc-?0*/i, '')) : null;
      where.push(`(lower(i.titulo) LIKE $${params.length} OR lower(COALESCE(i.servico,'')) LIKE $${params.length}${n ? ` OR i.id = ${n}` : ''}
                   OR EXISTS (SELECT 1 FROM public.incidente_ticket t WHERE t.incidente_id = i.id AND t.ticket_id::text LIKE $${params.length}))`);
    }
    const r = await db.query(`
      SELECT i.*, u.name AS responsavel_nome,
             (SELECT COUNT(*) FROM public.incidente_ticket t WHERE t.incidente_id = i.id)::int AS n_tickets
        FROM public.incidente i LEFT JOIN users u ON u.id = i.responsavel_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY (i.status IN ('resolvido','fechado')), i.prioridade ASC, i.aberto_em DESC
       LIMIT 500`, params);
    res.json({ incidentes: r.rows.map(formatarIncidente) });
  } catch (e) { erro(res, e); }
});

// ── detalhe ─────────────────────────────────────────────────────────────────
router.get('/:id', requireLeitura, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  try {
    const r = await db.query(`
      SELECT i.*, u.name AS responsavel_nome FROM public.incidente i LEFT JOIN users u ON u.id = i.responsavel_id WHERE i.id = $1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Incidente não encontrado' });
    const tickets = await db.query(`
      SELECT it.ticket_id, it.vinculado_em, t.subject AS assunto, t.status, t.basestatus, t.owner_name AS responsavel,
             COALESCE(org.organizacao_nome, t.clientorganization) AS cliente, t.createddate AS criado_em
        FROM public.incidente_ticket it
        LEFT JOIN silver.ticket t ON t.ticket_id::bigint = it.ticket_id
        LEFT JOIN silver.ticket_organizacao org ON org.ticket_id = it.ticket_id
       WHERE it.incidente_id = $1 ORDER BY it.vinculado_em`, [id]);
    const eventos = await db.query(`SELECT id, tipo, texto, autor_nome, criado_em FROM public.incidente_evento WHERE incidente_id = $1 ORDER BY criado_em DESC, id DESC`, [id]);
    res.json({ incidente: formatarIncidente(r.rows[0]), tickets: tickets.rows, eventos: eventos.rows });
  } catch (e) { erro(res, e); }
});

// ── criar ───────────────────────────────────────────────────────────────────
router.post('/', requireLeitura, exigirEscrita, async (req, res) => {
  const b = req.body || {};
  const titulo = String(b.titulo || '').trim();
  if (titulo.length < 5) return res.status(400).json({ error: 'Dê um título ao incidente (mínimo 5 caracteres).' });
  const impacto = nivelValido(b.impacto) ? Number(b.impacto) : 2;
  const urgencia = nivelValido(b.urgencia) ? Number(b.urgencia) : 2;
  const prioridade = prioridadeDe(impacto, urgencia);
  const tickets = listaTickets(b.ticketIds);
  try {
    const conflitos = tickets.length
      ? (await db.query(`SELECT it.ticket_id, i.id FROM public.incidente_ticket it JOIN public.incidente i ON i.id = it.incidente_id WHERE it.ticket_id = ANY($1::bigint[])`, [tickets])).rows
      : [];
    if (conflitos.length) {
      return res.status(409).json({ error: `Chamado(s) já ligado(s) a outro incidente: ${conflitos.map((c) => `#${c.ticket_id} (${codigoDe(c.id)})`).join(', ')}.`, conflitos });
    }
    const ins = await db.query(`
      INSERT INTO public.incidente (titulo, descricao, servico, impacto, urgencia, prioridade, grave, responsavel_id, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [titulo, String(b.descricao || '').trim() || null, String(b.servico || '').trim() || null, impacto, urgencia, prioridade,
       !!b.grave, idValido(b.responsavelId), req.user.id]);
    const inc = ins.rows[0];
    await evento(inc.id, req, 'criado', `Incidente aberto com prioridade P${prioridade} (impacto ${impacto}, urgência ${urgencia})${b.grave ? ' — marcado como GRAVE' : ''}.`);
    for (const tid of tickets) {
      await db.query(`INSERT INTO public.incidente_ticket (incidente_id, ticket_id, vinculado_por) VALUES ($1,$2,$3)`, [inc.id, tid, req.user.id]);
    }
    if (tickets.length) await evento(inc.id, req, 'ticket_vinculado', `Chamado(s) vinculado(s): ${tickets.map((t) => '#' + t).join(', ')}.`);
    res.status(201).json({ incidente: formatarIncidente(inc) });
  } catch (e) { erro(res, e); }
});

// ── editar dados (não o status) ─────────────────────────────────────────────
router.patch('/:id', requireLeitura, exigirEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  const b = req.body || {};
  try {
    const atual = (await db.query(`SELECT * FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Incidente não encontrado' });
    if (atual.status === 'fechado') return res.status(409).json({ error: 'Incidente fechado não pode ser alterado.' });

    const sets = []; const vals = []; const mudancas = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const txt = (campo, col, rotulo) => {
      if (b[campo] === undefined) return;
      const v = String(b[campo] || '').trim() || null;
      if (v !== (atual[col] || null)) { set(col, v); mudancas.push(rotulo); }
    };
    txt('titulo', 'titulo', 'título'); txt('descricao', 'descricao', 'descrição'); txt('servico', 'servico', 'serviço');
    txt('causa', 'causa', 'causa'); txt('contorno', 'contorno', 'contorno'); txt('resolucao', 'resolucao', 'resolução'); txt('problemaRef', 'problema_ref', 'problema relacionado');
    if (b.titulo !== undefined && String(b.titulo).trim().length < 5) return res.status(400).json({ error: 'O título precisa ter pelo menos 5 caracteres.' });

    const impacto = b.impacto !== undefined && nivelValido(b.impacto) ? Number(b.impacto) : atual.impacto;
    const urgencia = b.urgencia !== undefined && nivelValido(b.urgencia) ? Number(b.urgencia) : atual.urgencia;
    if (impacto !== atual.impacto || urgencia !== atual.urgencia) {
      const p = prioridadeDe(impacto, urgencia);
      set('impacto', impacto); set('urgencia', urgencia); set('prioridade', p);
      await evento(id, req, 'prioridade', `Prioridade alterada de P${atual.prioridade} para P${p} (impacto ${impacto}, urgência ${urgencia}).`);
    }
    if (b.grave !== undefined && !!b.grave !== atual.grave) {
      set('grave', !!b.grave);
      await evento(id, req, 'prioridade', b.grave ? 'Incidente marcado como GRAVE.' : 'Incidente deixou de ser marcado como grave.');
    }
    if (b.responsavelId !== undefined) {
      const novo = idValido(b.responsavelId);
      if (novo !== (atual.responsavel_id || null)) {
        set('responsavel_id', novo);
        const nome = novo ? (await db.query(`SELECT name FROM users WHERE id = $1`, [novo])).rows[0]?.name : null;
        await evento(id, req, 'responsavel', nome ? `Responsável: ${nome}.` : 'Responsável removido.');
      }
    }
    if (mudancas.length) await evento(id, req, 'edicao', `Atualizou: ${mudancas.join(', ')}.`);
    if (sets.length) {
      vals.push(id);
      await db.query(`UPDATE public.incidente SET ${sets.join(', ')}, atualizado_em = NOW() WHERE id = $${vals.length}`, vals);
    }
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

// ── mudar status ────────────────────────────────────────────────────────────
router.post('/:id/status', requireLeitura, exigirEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const novo = String(req.body?.status || '');
  const texto = String(req.body?.texto || '').trim();
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  if (!STATUS.includes(novo)) return res.status(400).json({ error: 'Status inválido' });
  try {
    const atual = (await db.query(`SELECT * FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Incidente não encontrado' });
    if (!TRANSICOES[atual.status].includes(novo)) {
      return res.status(409).json({ error: `Não dá para ir de "${ROTULO_STATUS[atual.status]}" para "${ROTULO_STATUS[novo]}".` });
    }
    if (novo === 'resolvido' && !(texto || atual.resolucao)) return res.status(400).json({ error: 'Descreva como o incidente foi resolvido.' });
    if (novo === 'fechado' && !atual.causa && !String(req.body?.causa || '').trim()) return res.status(400).json({ error: 'Informe a causa antes de fechar o incidente.' });

    const sets = ['status = $1', 'atualizado_em = NOW()']; const vals = [novo];
    const push = (frag, v) => { vals.push(v); sets.push(frag.replace('?', `$${vals.length}`)); };
    if (!atual.reconhecido_em && novo !== 'aberto') sets.push('reconhecido_em = NOW()');
    if (novo === 'mitigado' && !atual.mitigado_em) sets.push('mitigado_em = NOW()');
    if (novo === 'resolvido') { sets.push('resolvido_em = NOW()'); if (texto) push('resolucao = ?', texto); }
    if (novo === 'investigando' && atual.status === 'resolvido') sets.push('resolvido_em = NULL');
    if (novo === 'fechado') { sets.push('fechado_em = NOW()'); if (req.body?.causa) push('causa = ?', String(req.body.causa).trim()); }
    if (novo === 'investigando' && !atual.responsavel_id) push('responsavel_id = ?', req.user.id);
    vals.push(id);
    await db.query(`UPDATE public.incidente SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await evento(id, req, 'status', `${ROTULO_STATUS[atual.status]} → ${ROTULO_STATUS[novo]}${texto ? ` — ${texto}` : ''}`);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

// ── IA embutida: resumo com próximos passos e rascunho de comunicado ───────────────────────────
// Só devolvem RASCUNHOS; nada é enviado a clientes nem gravado sem a pessoa decidir (utils/ai.js).
const limiteIA = rateLimitDinamico({ name: 'incidentes/ia', windowMs: 10 * 60 * 1000, getMax: async () => (await cfg.obter()).geral.limiteIncidentesPor10min });
const recursoLigado = (chave) => async (req, res, next) => {
  try { if (!(await cfg.obter())[chave].ativo) return res.status(403).json({ error: 'Este recurso de IA foi desativado nas Configurações.' }); } catch { /* segue */ }
  next();
};
const erroIA = (res, e) => (e instanceof IaError ? res.status(e.status).json({ error: e.message }) : erro(res, e));

router.get('/ia/status', requireLeitura, async (req, res) => {
  const S = await cfg.obter();
  res.json({ configurada: await iaConfigurada().catch(() => false), recursos: { resumo: S.incidenteResumo.ativo, comunicado: S.incidenteComunicado.ativo, posmortem: S.incidentePosmortem.ativo }, padroes: { publico: S.incidenteComunicado.publicoPadrao, tipo: S.incidenteComunicado.tipoPadrao } });
});

// Monta o contexto do incidente em texto para a IA.
async function contextoDoIncidente(id, maxChamados = 60, maxEventos = 40) {
  const inc = (await db.query(`SELECT i.*, u.name AS responsavel_nome FROM public.incidente i LEFT JOIN users u ON u.id = i.responsavel_id WHERE i.id = $1`, [id])).rows[0];
  if (!inc) return null;
  const tickets = (await db.query(`
    SELECT it.ticket_id, t.subject, t.status, COALESCE(org.organizacao_nome, t.clientorganization) AS cliente
      FROM public.incidente_ticket it
      LEFT JOIN silver.ticket t ON t.ticket_id::bigint = it.ticket_id
      LEFT JOIN silver.ticket_organizacao org ON org.ticket_id = it.ticket_id
     WHERE it.incidente_id = $1 ORDER BY it.vinculado_em LIMIT ${Number(maxChamados) | 0}`, [id])).rows;
  const total = (await db.query(`SELECT COUNT(*)::int AS n FROM public.incidente_ticket WHERE incidente_id = $1`, [id])).rows[0].n;
  const eventos = (await db.query(`SELECT tipo, texto, autor_nome, criado_em FROM public.incidente_evento WHERE incidente_id = $1 ORDER BY criado_em DESC, id DESC LIMIT ${Number(maxEventos) | 0}`, [id])).rows.reverse();
  const clientes = [...new Set(tickets.map((t) => t.cliente).filter(Boolean))];
  const texto = `Código: ${codigoDe(inc.id)}
Título: ${limitar(inc.titulo, 300)}
Serviço: ${inc.servico || '—'}
Prioridade: P${inc.prioridade} (impacto ${inc.impacto}, urgência ${inc.urgencia})${inc.grave ? ' · INCIDENTE GRAVE' : ''}
Status: ${ROTULO_STATUS[inc.status]} · Responsável: ${inc.responsavel_nome || '—'}
Aberto em: ${dataBr(inc.aberto_em)} · Reconhecido: ${inc.reconhecido_em ? dataBr(inc.reconhecido_em) : 'ainda não'} · Mitigado: ${inc.mitigado_em ? dataBr(inc.mitigado_em) : '—'} · Resolvido: ${inc.resolvido_em ? dataBr(inc.resolvido_em) : '—'}
Descrição: ${limitar(inc.descricao, 1500) || '—'}
Causa registrada: ${limitar(inc.causa, 800) || '—'}
Contorno registrado: ${limitar(inc.contorno, 800) || '—'}
Solução registrada: ${limitar(inc.resolucao, 800) || '—'}

Chamados vinculados: ${total} (clientes distintos nos primeiros ${tickets.length}: ${clientes.length})
${tickets.map((t) => `- #${t.ticket_id} ${limitar(t.subject, 120) || '(ainda não carregado)'} — ${t.cliente || 'cliente?'}`).join('\n')}

Linha do tempo (mais antiga → mais recente):
${eventos.map((e) => `[${dataBr(e.criado_em)}] ${e.tipo} · ${e.autor_nome || 'Sistema'}: ${limitar(e.texto, 500)}`).join('\n')}`;
  return { inc, texto };
}

router.post('/:id/ia/resumo', requireLeitura, exigirEscrita, recursoLigado('incidenteResumo'), limiteIA, async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  try {
    const S = await cfg.obter(), C = S.incidenteResumo;
    const ctx = await contextoDoIncidente(id, C.chamadosNoContexto, C.eventosNoContexto);
    if (!ctx) return res.status(404).json({ error: 'Incidente não encontrado' });
    const system = `${REGRAS}${cfg.diretrizes(S)}
Tarefa: apoiar a gestão deste INCIDENTE de serviço (modelo ITIL): vários chamados de clientes sobre a mesma falha.
Faça uma leitura objetiva para quem assume o incidente agora:
- resumo: 2 a 4 frases (o que quebrou, quem é afetado, desde quando, em que ponto está);
- hipoteses: ${C.maxHipoteses > 0 ? `no máximo ${C.maxHipoteses} hipóteses` : 'NÃO apresente hipóteses de causa (devolva lista vazia);'} de causa, cada uma com as evidências que a sustentam NOS DADOS (assuntos dos chamados, horários, serviço, mensagens). Se não há base, devolva lista vazia — não chute;
- proximos_passos: até ${C.maxPassos} ações práticas e priorizadas (diagnóstico, mitigação, comunicação, vínculo de chamados novos);
- riscos: ${C.maxRiscos > 0 ? `até ${C.maxRiscos} riscos` : 'não liste riscos (devolva lista vazia);'} (estouro de meta, cliente crítico, falta de responsável, falta de comunicado);
- lacunas: o que falta registrar (causa, contorno, responsável, comunicado...).
${C.usarMetas ? 'Compare os tempos com as metas: P1 reconhecer 15 min / resolver 4 h; P2 30 min / 8 h; P3 2 h / 24 h; P4 8 h / 72 h.' : 'Não avalie metas de tempo.'}
Responda em JSON: {"resumo": "", "hipoteses": [{"hipotese": "", "evidencias": ""}], "proximos_passos": [""], "riscos": [""], "lacunas": [""]}${cfg.extra(C.instrucaoExtra)}`;
    const r = await chamarIA({ source: 'incidente_resumo', system, user: dados('INCIDENTE', ctx.texto), maxTokens: 1100, temperature: cfg.temperatura(C.criatividade), userEmail: req.user.email, meta: { incidente: id } });
    const lista = (v, n, t) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => limitar(typeof x === 'string' ? x : JSON.stringify(x), t));
    res.json({
      resumo: limitar(r.resumo, 900),
      hipoteses: (Array.isArray(r.hipoteses) ? r.hipoteses : []).slice(0, C.maxHipoteses).map((h) => ({ hipotese: limitar(h && h.hipotese, 300), evidencias: limitar(h && h.evidencias, 400) })),
      proximosPassos: lista(r.proximos_passos, C.maxPassos, 300), riscos: lista(r.riscos, C.maxRiscos, 300), lacunas: lista(r.lacunas, 5, 200),
    });
  } catch (e) { erroIA(res, e); }
});

router.post('/:id/ia/comunicado', requireLeitura, exigirEscrita, recursoLigado('incidenteComunicado'), limiteIA, async (req, res) => {
  const id = idValido(req.params.id);
  const S = await cfg.obter(), C = S.incidenteComunicado;
  const publico = ['interno', 'clientes'].includes(req.body?.publico) ? req.body.publico : C.publicoPadrao;
  const tipo = ['inicial', 'atualizacao', 'resolucao'].includes(req.body?.tipo) ? req.body.tipo : C.tipoPadrao;
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  try {
    const ctx = await contextoDoIncidente(id, S.incidenteResumo.chamadosNoContexto, S.incidenteResumo.eventosNoContexto);
    if (!ctx) return res.status(404).json({ error: 'Incidente não encontrado' });
    const descTipo = { inicial: 'primeiro aviso: reconhece o problema, diz quem/o que é afetado e que a equipe está trabalhando', atualizacao: 'atualização de andamento: o que já foi feito, situação atual e o que vem a seguir', resolucao: 'encerramento: o serviço foi restabelecido, o que foi feito (em linguagem simples) e como falar com o suporte se persistir' }[tipo];
    const system = `${REGRAS}${cfg.diretrizes(S)}
Tarefa: redigir um COMUNICADO de incidente — ${descTipo}.
Público: ${publico === 'clientes' ? `CLIENTES. ${C.estilo === 'formal' ? 'Linguagem formal, respeitosa e institucional, sem jargão técnico;' : 'Linguagem simples, empática e sem jargão;'} sem culpar terceiros; nada de detalhes técnicos internos, nomes de pessoas da equipe, causas não confirmadas ou prazos que não estejam nos dados.` : 'EQUIPE INTERNA. Pode ser técnico e direto; inclua o estado, o responsável, as metas e os próximos passos.'}
- Use apenas fatos dos dados. Se a causa ou o horário previsto não estão confirmados, diga que será informado.
- Curto: no máximo ~${publico === 'clientes' ? C.palavrasClientes : C.palavrasEquipe} palavras. Sem placeholders entre colchetes.
Responda em JSON: {"assunto": "linha de assunto curta", "texto": "corpo do comunicado"}${cfg.extra(C.instrucaoExtra)}`;
    const r = await chamarIA({ source: 'incidente_comunicado', system, user: dados('INCIDENTE', ctx.texto), maxTokens: 900, temperature: cfg.temperatura(C.criatividade), userEmail: req.user.email, meta: { incidente: id, publico, tipo } });
    res.json({ assunto: limitar(r.assunto, 200), texto: limitar(r.texto, 3000) });
  } catch (e) { erroIA(res, e); }
});

// ── notas e comunicados na linha do tempo ───────────────────────────────────
router.post('/:id/notas', requireLeitura, exigirEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const texto = String(req.body?.texto || '').trim();
  const tipo = req.body?.tipo === 'comunicado' ? 'comunicado' : 'nota';
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  if (!texto) return res.status(400).json({ error: 'Escreva o texto antes de enviar.' });
  if (texto.length > 5000) return res.status(400).json({ error: 'Texto grande demais (máx. 5.000 caracteres).' });
  try {
    const ok = await db.query(`SELECT 1 FROM public.incidente WHERE id = $1`, [id]);
    if (!ok.rows[0]) return res.status(404).json({ error: 'Incidente não encontrado' });
    await evento(id, req, tipo, texto);
    await db.query(`UPDATE public.incidente SET atualizado_em = NOW() WHERE id = $1`, [id]);
    res.status(201).json({ ok: true });
  } catch (e) { erro(res, e); }
});

// ── vincular / desvincular chamados ─────────────────────────────────────────
router.post('/:id/tickets', requireLeitura, exigirEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const tickets = listaTickets(req.body?.ticketIds);
  const mover = req.body?.mover === true;
  if (!id) return res.status(400).json({ error: 'Número de incidente inválido' });
  if (!tickets.length) return res.status(400).json({ error: 'Informe o número de pelo menos um chamado.' });
  try {
    const inc = (await db.query(`SELECT status FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!inc) return res.status(404).json({ error: 'Incidente não encontrado' });
    if (inc.status === 'fechado') return res.status(409).json({ error: 'Incidente fechado não aceita novos chamados.' });
    const outros = (await db.query(
      `SELECT ticket_id, incidente_id FROM public.incidente_ticket WHERE ticket_id = ANY($1::bigint[]) AND incidente_id <> $2`, [tickets, id])).rows;
    if (outros.length && !mover) {
      return res.status(409).json({ error: `Chamado(s) já ligado(s) a outro incidente: ${outros.map((o) => `#${o.ticket_id} (${codigoDe(o.incidente_id)})`).join(', ')}.`, conflitos: outros, podeMover: true });
    }
    for (const o of outros) {
      await db.query(`DELETE FROM public.incidente_ticket WHERE ticket_id = $1`, [o.ticket_id]);
      await evento(o.incidente_id, req, 'ticket_removido', `Chamado #${o.ticket_id} movido para ${codigoDe(id)}.`);
    }
    const novos = [];
    for (const tid of tickets) {
      const r = await db.query(`INSERT INTO public.incidente_ticket (incidente_id, ticket_id, vinculado_por) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING ticket_id`, [id, tid, req.user.id]);
      if (r.rows[0]) novos.push(tid);
    }
    if (novos.length) {
      await evento(id, req, 'ticket_vinculado', `Chamado(s) vinculado(s): ${novos.map((t) => '#' + t).join(', ')}.`);
      await db.query(`UPDATE public.incidente SET atualizado_em = NOW() WHERE id = $1`, [id]);
    }
    res.json({ ok: true, vinculados: novos });
  } catch (e) { erro(res, e); }
});

router.delete('/:id/tickets/:ticketId', requireLeitura, exigirEscrita, async (req, res) => {
  const id = idValido(req.params.id);
  const tid = idValido(req.params.ticketId);
  if (!id || !tid) return res.status(400).json({ error: 'Número inválido' });
  try {
    const inc = (await db.query(`SELECT status FROM public.incidente WHERE id = $1`, [id])).rows[0];
    if (!inc) return res.status(404).json({ error: 'Incidente não encontrado' });
    if (inc.status === 'fechado') return res.status(409).json({ error: 'Incidente fechado não pode ser alterado.' });
    const r = await db.query(`DELETE FROM public.incidente_ticket WHERE incidente_id = $1 AND ticket_id = $2 RETURNING ticket_id`, [id, tid]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Esse chamado não está neste incidente.' });
    await evento(id, req, 'ticket_removido', `Chamado #${tid} desvinculado.`);
    res.json({ ok: true });
  } catch (e) { erro(res, e); }
});

router.helpers = { requireLeitura, exigirEscrita, evento, idValido, erro, codigoDe, formatarIncidente, contextoDoIncidente, garantirTabelas, listaTickets, IaError, erroIA, recursoLigado, limiteIA };

module.exports = router;
module.exports.prioridadeDe = prioridadeDe;
module.exports.METAS = METAS;
