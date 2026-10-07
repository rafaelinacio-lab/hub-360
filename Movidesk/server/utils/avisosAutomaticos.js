'use strict';
// Avisos automáticos: mensagens disparadas quando chega chamado novo no Movidesk de um serviço configurado.
//
// Como funciona (ver também docs/ARCHITECTURE.md):
//  - A cada `intervaloSeg` o motor consulta a API do Movidesk (só $select + $filter por data de criação, sem $expand,
//    por causa do bug de $filter+$expand documentado no loader) pelos chamados criados desde a "vigia" (marca d'água).
//  - Para cada chamado, acha a PRIMEIRA regra ativa (por ordem) cujo serviço casa; no máximo uma mensagem por chamado.
//  - Antes de enviar grava a reserva em public.aviso_envio (UNIQUE regra+chamado): reinício do servidor, dois ciclos
//    sobrepostos ou a mesma regra duas vezes nunca duplicam o aviso.
//  - Chave geral desligada por padrão; regras novas nascem em modo "simulação" (só registra no histórico, não escreve no Movidesk).
//  - O aviso sai em nome de um agente do Movidesk escolhido na regra (nota interna ou resposta pública, origem API).
const db = require('../db/remote');
const { movidesk, listaAgentes } = require('./movideskPeople');

const ACAO_TIPO = { interna: 1, publica: 2 };
const ACAO_ORIGEM = Number(process.env.MOVIDESK_ACTION_ORIGIN || 9);
const ABERTOS = ['New', 'InAttendance', 'InProgress', 'Stopped'];
const MAX_TENTATIVAS = 3;
const POR_CICLO = 50;
const JANELA_RETRY_MIN = 60;

const PADRAO_ESTADO = { ligado: false, intervaloSeg: 120, vigia: null, ultimoCiclo: null, ultimoErro: null };

let pronto = null;
function garantirTabelas() {
  if (pronto) return pronto;
  pronto = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS public.aviso_estado (chave text PRIMARY KEY, valor jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    await db.query(`CREATE TABLE IF NOT EXISTS public.aviso_regra (
      id serial PRIMARY KEY,
      nome text NOT NULL,
      ativo boolean NOT NULL DEFAULT false,
      modo text NOT NULL DEFAULT 'simulacao',
      servicos jsonb NOT NULL DEFAULT '[]'::jsonb,
      tipo_acao text NOT NULL DEFAULT 'publica',
      mensagem text NOT NULL DEFAULT '',
      agente_id text,
      agente_nome text,
      somente_novos boolean NOT NULL DEFAULT true,
      criado_por text,
      criado_em timestamptz NOT NULL DEFAULT NOW(),
      atualizado_em timestamptz NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS public.aviso_envio (
      id bigserial PRIMARY KEY,
      regra_id int NOT NULL,
      regra_nome text,
      ticket_id text NOT NULL,
      assunto text,
      servico text,
      status text NOT NULL,
      modo text,
      tentativas int NOT NULL DEFAULT 0,
      mensagem text,
      erro text,
      criado_em timestamptz NOT NULL DEFAULT NOW(),
      atualizado_em timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (regra_id, ticket_id)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS ix_aviso_envio_criado ON public.aviso_envio (criado_em DESC)`);
  })().catch((e) => { pronto = null; throw e; });
  return pronto;
}

async function lerEstado() {
  await garantirTabelas();
  const r = await db.query(`SELECT valor FROM public.aviso_estado WHERE chave = 'geral'`);
  return { ...PADRAO_ESTADO, ...(r.rows[0]?.valor || {}) };
}
async function gravarEstado(parcial) {
  const novo = { ...(await lerEstado()), ...parcial };
  await db.query(
    `INSERT INTO public.aviso_estado (chave, valor) VALUES ('geral', $1::jsonb) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
    [JSON.stringify(novo)]
  );
  return novo;
}

// ── Casamento de serviço ───────────────────────────────────────────────
const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ').trim();
// "Agronegócio" casa com tudo abaixo dele ("Agronegócio > Agrotitan > …"); "Agronegócio > Agrotitan" só com esse ramo.
function servicoCasa(servicoDoChamado, servicosDaRegra) {
  const s = norm(servicoDoChamado);
  if (!s) return false;
  return (servicosDaRegra || []).some((x) => {
    const a = norm(x);
    return a && (s === a || s.startsWith(a + ' > '));
  });
}

// ── Mensagem ───────────────────────────────────────────────────────────
function saudacao(data = new Date()) {
  const h = (data.getUTCHours() + 24 - 3) % 24;   // Brasília
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}
function montarMensagem(modelo, t) {
  const v = {
    ticket: t.id, assunto: t.subject || '', servico: t.servico || '', urgencia: t.urgency || '',
    equipe: t.ownerTeam || '', saudacao: saudacao(),
  };
  return String(modelo || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in v ? String(v[k]) : m));
}
const VARIAVEIS = ['saudacao', 'ticket', 'assunto', 'servico', 'urgencia', 'equipe'];

// ── Ciclo ──────────────────────────────────────────────────────────────
let rodando = false;
let timer = null;

async function regrasAtivas() {
  const r = await db.query(`SELECT * FROM public.aviso_regra WHERE ativo = TRUE ORDER BY id`);
  return r.rows;
}

async function enviarAcao(regra, t, texto) {
  await movidesk('PATCH', '/tickets', {
    query: { id: t.id },
    body: { actions: [{ type: ACAO_TIPO[regra.tipo_acao] || ACAO_TIPO.interna, origin: ACAO_ORIGEM, description: texto, createdBy: { id: regra.agente_id } }] },
  });
}

async function processarChamado(regras, t, resumo) {
  if (!ABERTOS.includes(t.baseStatus)) { resumo.fechados++; return 0; }
  const regra = regras.find((r) => servicoCasa(t.servico, r.servicos));
  if (!regra) { resumo.semRegra++; if (resumo.servicosSemRegra.length < 5 && !resumo.servicosSemRegra.includes(t.servico)) resumo.servicosSemRegra.push(t.servico); return 0; }
  resumo.casaram++;
  const texto = montarMensagem(regra.mensagem, t);
  const simulando = regra.modo !== 'ativo' || !regra.agente_id;
  const ins = await db.query(
    `INSERT INTO public.aviso_envio (regra_id, regra_nome, ticket_id, assunto, servico, status, modo, mensagem)
     VALUES ($1,$2,$3,$4,$5,'processando',$6,$7) ON CONFLICT (regra_id, ticket_id) DO NOTHING RETURNING id`,
    [regra.id, regra.nome, t.id, String(t.subject || '').slice(0, 300), t.servico, simulando ? 'simulacao' : 'ativo', texto]
  );
  if (!ins.rows.length) { resumo.jaTratados++; return 0; }   // já tratado antes
  resumo.registrados++;
  const id = ins.rows[0].id;
  if (simulando) {
    await db.query(`UPDATE public.aviso_envio SET status = 'simulado', atualizado_em = NOW() WHERE id = $1`, [id]);
    return 1;
  }
  try {
    await db.query(`UPDATE public.aviso_envio SET tentativas = 1 WHERE id = $1`, [id]);
    await enviarAcao(regra, t, texto);
    await db.query(`UPDATE public.aviso_envio SET status = 'enviado', erro = NULL, atualizado_em = NOW() WHERE id = $1`, [id]);
  } catch (e) {
    await db.query(`UPDATE public.aviso_envio SET status = 'erro', erro = $2, atualizado_em = NOW() WHERE id = $1`, [id, String(e.message).slice(0, 400)]);
    console.warn(`[avisos] falha no chamado ${t.id}: ${e.message}`);
  }
  return 1;
}

// Reenvia falhas recentes (poucas tentativas, só dentro de JANELA_RETRY_MIN).
async function reenviarFalhas(regras) {
  const r = await db.query(
    `SELECT * FROM public.aviso_envio WHERE status = 'erro' AND modo = 'ativo' AND tentativas < $1
        AND criado_em > NOW() - ($2 || ' minutes')::interval ORDER BY id LIMIT 20`, [MAX_TENTATIVAS, String(JANELA_RETRY_MIN)]);
  for (const f of r.rows) {
    const regra = regras.find((x) => x.id === f.regra_id);
    if (!regra || regra.modo !== 'ativo' || !regra.agente_id) continue;
    try {
      await db.query(`UPDATE public.aviso_envio SET tentativas = tentativas + 1 WHERE id = $1`, [f.id]);
      await enviarAcao(regra, { id: f.ticket_id }, f.mensagem);
      await db.query(`UPDATE public.aviso_envio SET status = 'enviado', erro = NULL, atualizado_em = NOW() WHERE id = $1`, [f.id]);
    } catch (e) {
      await db.query(`UPDATE public.aviso_envio SET erro = $2, atualizado_em = NOW() WHERE id = $1`, [f.id, String(e.message).slice(0, 400)]);
    }
  }
}

async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    const estado = await lerEstado();
    if (!estado.ligado) return;
    const regras = await regrasAtivas();
    // sem regra ativa: a vigia acompanha o relógio, para uma regra ligada depois não disparar para chamados de horas atrás
    if (!regras.length) { const agora = new Date().toISOString(); await gravarEstado({ vigia: agora, ultimoCiclo: agora, ultimoErro: null, resumoCiclo: { regrasAtivas: 0, consultados: 0 } }); return; }
    // Sem vigia (primeira vez): começa de agora — nunca dispara retroativamente para chamados antigos.
    const vigia = estado.vigia || new Date().toISOString();
    const desde = new Date(vigia).toISOString().replace(/\.\d+Z$/, 'Z');
    const lista = await movidesk('GET', '/tickets', {
      query: { $select: 'id,subject,serviceFull,createdDate,baseStatus,status,ownerTeam,urgency', $filter: `createdDate ge ${desde}`, $orderby: 'createdDate asc', $top: POR_CICLO },
    });
    const tickets = (Array.isArray(lista) ? lista : []).map((t) => ({ ...t, id: String(t.id), servico: Array.isArray(t.serviceFull) ? t.serviceFull.join(' > ') : (t.serviceFull || '') }));
    let maior = vigia;
    const resumo = { regrasAtivas: regras.length, consultados: tickets.length, fechados: 0, semRegra: 0, casaram: 0, jaTratados: 0, registrados: 0, servicosSemRegra: [] };
    for (const t of tickets) {
      await processarChamado(regras, t, resumo);
      if (t.createdDate && new Date(t.createdDate) > new Date(maior)) maior = new Date(t.createdDate).toISOString();
    }
    // lote cheio de chamados com a mesma data: avança só se a vigia mudou, senão o próximo ciclo repete (dedup protege)
    await reenviarFalhas(regras);
    await gravarEstado({ vigia: maior, ultimoCiclo: new Date().toISOString(), ultimoErro: null, resumoCiclo: resumo });
  } catch (e) {
    console.warn('[avisos] ciclo falhou:', e.message);
    await gravarEstado({ ultimoErro: String(e.message).slice(0, 300), ultimoCiclo: new Date().toISOString() }).catch(() => {});
  } finally { rodando = false; }
}

async function agendar() {
  clearTimeout(timer);
  let seg = 120;
  try { seg = (await lerEstado()).intervaloSeg || 60; } catch { /* tabela ainda não existe: tenta de novo */ }
  timer = setTimeout(async () => { await ciclo(); agendar(); }, Math.max(30, seg) * 1000);
  timer.unref?.();
}
function iniciar() { garantirTabelas().catch((e) => console.error('[avisos] tabelas:', e.message)); agendar(); }

module.exports = { iniciar, ciclo, garantirTabelas, lerEstado, gravarEstado, servicoCasa, montarMensagem, VARIAVEIS, listaAgentes };
