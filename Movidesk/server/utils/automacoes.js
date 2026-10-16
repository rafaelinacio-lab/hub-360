'use strict';
// Automações (Configurações → Automações): dispara uma AÇÃO em chamados abertos quando uma CONDIÇÃO é atendida.
// Hoje a única ação é "Análise do cliente por IA" → grava o resultado como NOTA INTERNA no chamado (nunca resposta pública).
//
// Gatilhos:
//  - webhook : o Movidesk chama POST /api/webhooks/automacao/<token> (ex.: "chamado novo"); o Hub responde na hora (202) e processa em fila.
//  - agendado: a cada `intervalo_min` o motor procura no BANCO (silver.*) chamados ABERTOS que atendem às condições.
// Segurança (mesmo padrão dos Avisos automáticos):
//  - chave geral desligada por padrão; regra nasce em "simulação" (faz a análise e guarda no histórico, mas NÃO escreve no Movidesk);
//  - public.automacao_execucao tem UNIQUE (automacao, chamado): cada regra age no máximo uma vez por chamado, mesmo com reinício,
//    webhook repetido ou ciclos sobrepostos;
//  - só chamados ABERTOS (nunca fechados/resolvidos), só criados nos últimos N dias (padrão 3) e no máximo `max_por_ciclo` por vez;
//  - a nota sai em nome de um agente do Movidesk escolhido na regra; uma chamada por vez (cota de 150 req/min do Movidesk).
const db = require('../db/remote');
const { movidesk } = require('./movideskPeople');
const { analisarCliente } = require('./analiseCliente');
const { textoParaHtml, servicoCasa } = require('./avisosAutomaticos');
const { configurada: iaConfigurada } = require('./ai');

const ACAO_TIPO_INTERNA = 1;
const ACAO_ORIGEM = Number(process.env.MOVIDESK_ACTION_ORIGIN || 9);
const ABERTOS = ['New', 'InAttendance', 'InProgress', 'Stopped'];
const CF_CLASSIFICACAO = 23946;
const MAX_TENTATIVAS = 3;
const JANELA_RETRY_MIN = 60;
const FILA_MAX = 300;
const norm = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const CONDICOES_PADRAO = { status: [], equipes: [], servicos: [], classificacoes: [], urgencias: [], criadoUltimosDias: 3, abertoHaMinHoras: 0 };
const ACOES = { analise_cliente: 'Análise do cliente por IA (nota interna)' };

let pronto = null;
function garantirTabelas() {
  if (!pronto) pronto = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS public.automacao_estado (chave text PRIMARY KEY, valor jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    await db.query(`CREATE TABLE IF NOT EXISTS public.automacao (
      id serial PRIMARY KEY, nome text NOT NULL, ativo boolean NOT NULL DEFAULT false, modo text NOT NULL DEFAULT 'simulacao',
      gatilho text NOT NULL DEFAULT 'webhook', token text, intervalo_min integer NOT NULL DEFAULT 15,
      condicoes jsonb NOT NULL DEFAULT '{}'::jsonb, acao text NOT NULL DEFAULT 'analise_cliente',
      agente_id text, agente_nome text, max_por_ciclo integer NOT NULL DEFAULT 10,
      criado_por text, criado_em timestamptz NOT NULL DEFAULT NOW(), atualizado_em timestamptz NOT NULL DEFAULT NOW(),
      ultimo_ciclo timestamptz, ultimo_resumo jsonb)`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS automacao_token_uq ON public.automacao (token) WHERE token IS NOT NULL`);
    await db.query(`CREATE TABLE IF NOT EXISTS public.automacao_execucao (
      id bigserial PRIMARY KEY, automacao_id integer NOT NULL, automacao_nome text, ticket_id bigint NOT NULL, origem text NOT NULL,
      status text NOT NULL, modo text NOT NULL, assunto text, texto text, erro text, tentativas integer NOT NULL DEFAULT 0,
      criado_em timestamptz NOT NULL DEFAULT NOW(), atualizado_em timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (automacao_id, ticket_id))`);
    await db.query(`CREATE INDEX IF NOT EXISTS automacao_execucao_criado ON public.automacao_execucao (criado_em DESC)`);
  })().catch((e) => { pronto = null; throw e; });
  return pronto;
}

async function lerEstado() {
  await garantirTabelas();
  const r = await db.query(`SELECT valor FROM public.automacao_estado WHERE chave = 'geral'`);
  return { ligado: false, ultimoCiclo: null, ultimoErro: null, ...(r.rows[0]?.valor || {}) };
}
async function gravarEstado(parcial) {
  await garantirTabelas();
  const atual = await lerEstado();
  await db.query(`INSERT INTO public.automacao_estado (chave, valor) VALUES ('geral', $1::jsonb) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify({ ...atual, ...parcial })]);
}

// ── Condições ───────────────────────────────────────────────────────────
function normalizarCondicoes(c) {
  c = c && typeof c === 'object' ? c : {};
  const lista = (v, max = 50, tam = 300) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x == null ? '' : x).trim().slice(0, tam)).filter(Boolean))].slice(0, max);
  const num = (v, pad, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : pad; };
  return {
    status: lista(c.status).filter((s) => ABERTOS.includes(s)),
    equipes: lista(c.equipes), servicos: lista(c.servicos), classificacoes: lista(c.classificacoes), urgencias: lista(c.urgencias, 10, 40),
    criadoUltimosDias: num(c.criadoUltimosDias, 3, 1, 30),
    abertoHaMinHoras: num(c.abertoHaMinHoras, 0, 0, 24 * 30),
  };
}

// Lê o chamado do banco no formato usado pelas condições. null se não existir.
async function lerChamado(id) {
  const r = await db.query(`
    SELECT t.ticket_id::text AS id, t.subject, t.status, t.basestatus, t.urgency, t.ownerteam, t.service_full, t.createddate,
           (SELECT string_agg(DISTINCT cf.valor_texto, ', ') FROM silver.ticket_campo_customizado cf
             WHERE cf.ticket_id = t.ticket_id::bigint AND cf.custom_field_id::text = '${CF_CLASSIFICACAO}') AS classificacao
      FROM silver.ticket t WHERE t.ticket_id = $1::bigint`, [id]);
  return r.rows[0] || null;
}

// Motivo pelo qual o chamado NÃO atende às condições (null = atende). `origem` webhook ignora a idade mínima (chamado acabou de chegar).
function motivoDeNaoCasar(t, c, origem) {
  if (!ABERTOS.includes(t.basestatus)) return 'chamado não está aberto';
  if (c.status.length && !c.status.includes(t.basestatus)) return 'status fora da condição';
  if (c.equipes.length && !c.equipes.some((e) => norm(e) === norm(t.ownerteam))) return 'equipe fora da condição';
  if (c.servicos.length && !servicoCasa(t.service_full, c.servicos)) return 'serviço fora da condição';
  if (c.classificacoes.length && !c.classificacoes.some((x) => norm(x) === norm(t.classificacao))) return 'classificação fora da condição';
  if (c.urgencias.length && !c.urgencias.some((u) => norm(u) === norm(t.urgency))) return 'urgência fora da condição';
  const idadeH = t.createddate ? (Date.now() - new Date(t.createddate).getTime()) / 3600000 : 0;
  if (idadeH > c.criadoUltimosDias * 24) return `criado há mais de ${c.criadoUltimosDias} dia(s)`;
  if (origem !== 'webhook' && c.abertoHaMinHoras && idadeH < c.abertoHaMinHoras) return `aberto há menos de ${c.abertoHaMinHoras} h`;
  return null;
}

// ── Texto da nota ───────────────────────────────────────────────────────
const ROTULO = { positivo: 'Positivo', neutro: 'Neutro', frustrado: 'Frustrado', irritado: 'Irritado', baixa: 'Baixa', media: 'Média', alta: 'Alta', baixo: 'Baixo', medio: 'Médio' };
function textoDaAnalise(a) {
  const h = a.historico || {};
  const partes = [
    '**Análise do cliente · Hub 360 (IA)**',
    `Sentimento: **${ROTULO[a.sentimento] || a.sentimento}** · Urgência percebida: **${ROTULO[a.urgenciaPercebida] || a.urgenciaPercebida}** · Risco de churn: **${ROTULO[a.riscoDeChurn] || a.riscoDeChurn}**`,
    a.resumo,
  ];
  if (a.perfil) partes.push(`**Perfil:** ${a.perfil}`);
  if (a.sinais.length) partes.push(['**Sinais**', ...a.sinais.map((x) => `• ${x}`)].join('\n'));
  if (a.recomendacoes.length) partes.push(['**Recomendações**', ...a.recomendacoes.map((x) => `• ${x}`)].join('\n'));
  if (h.organizacao) {
    const n = (v) => (v == null ? '—' : v);
    partes.push(`**Histórico de ${h.organizacao}:** ${n(h.tickets90d)} chamado(s) nos últimos 90 dias · ${n(h.tickets12m)} em 12 meses · ${n(h.abertosAgora)} aberto(s) agora${h.tempoMedioResolucaoH != null ? ` · resolução média ${h.tempoMedioResolucaoH} h` : ''}.`);
  }
  partes.push('Nota gerada automaticamente por IA a partir do chamado e do histórico no Hub 360. É apoio ao atendimento: confira antes de agir.');
  return partes.join('\n\n');
}

// ── Execução de uma regra em um chamado ─────────────────────────────────
async function escreverNota(regra, ticketId, texto) {
  await movidesk('PATCH', '/tickets', {
    query: { id: ticketId },
    body: { actions: [{ type: ACAO_TIPO_INTERNA, origin: ACAO_ORIGEM, description: textoParaHtml(texto), createdBy: { id: regra.agente_id } }] },
  });
  try { await require('../scripts/movidesk-loader').sincronizarTicket(ticketId); require('../routes/tickets').limparCache(); }
  catch (e) { console.warn('[automacoes] não consegui atualizar o banco após a nota:', e.message); }
}

// Reserva (UNIQUE) → analisa → grava (ou simula). Retorna { status, motivo? }.
async function executarNoChamado(regra, t, origem, { forcar = false } = {}) {
  const simulando = regra.modo !== 'ativo' || !regra.agente_id;
  const id = Number(t.id);
  if (forcar) await db.query(`DELETE FROM public.automacao_execucao WHERE automacao_id = $1 AND ticket_id = $2`, [regra.id, id]);
  const ins = await db.query(
    `INSERT INTO public.automacao_execucao (automacao_id, automacao_nome, ticket_id, origem, status, modo, assunto)
     VALUES ($1,$2,$3,$4,'processando',$5,$6) ON CONFLICT (automacao_id, ticket_id) DO NOTHING RETURNING id`,
    [regra.id, regra.nome, id, origem, simulando ? 'simulacao' : 'ativo', String(t.subject || '').slice(0, 300)]);
  if (!ins.rows.length) return { status: 'ja_tratado' };
  const execId = ins.rows[0].id;
  try {
    const a = await analisarCliente(id, { userEmail: 'automacao@hub-360' });
    if (!a) { await db.query(`UPDATE public.automacao_execucao SET status='ignorado', erro=$2, atualizado_em=NOW() WHERE id=$1`, [execId, 'Chamado sem informação no banco para analisar']); return { status: 'ignorado' }; }
    const texto = textoDaAnalise(a);
    await db.query(`UPDATE public.automacao_execucao SET texto = $2, tentativas = 1 WHERE id = $1`, [execId, texto]);
    if (simulando) { await db.query(`UPDATE public.automacao_execucao SET status='simulado', atualizado_em=NOW() WHERE id=$1`, [execId]); return { status: 'simulado', texto }; }
    await escreverNota(regra, id, texto);
    await db.query(`UPDATE public.automacao_execucao SET status='enviado', erro=NULL, atualizado_em=NOW() WHERE id=$1`, [execId]);
    return { status: 'enviado', texto };
  } catch (e) {
    await db.query(`UPDATE public.automacao_execucao SET status='erro', erro=$2, atualizado_em=NOW() WHERE id=$1`, [execId, String(e.message).slice(0, 400)]);
    console.warn(`[automacoes] "${regra.nome}" falhou no chamado ${id}: ${e.message}`);
    return { status: 'erro', erro: e.message };
  }
}

// Refaz as que falharam (poucas tentativas, só na última hora). A análise é refeita (não guardamos o texto de quem falhou antes de gerar).
async function reexecutarFalhas() {
  const r = await db.query(
    `SELECT e.id, e.ticket_id, e.texto, e.tentativas, a.* FROM public.automacao_execucao e JOIN public.automacao a ON a.id = e.automacao_id
      WHERE e.status = 'erro' AND e.modo = 'ativo' AND e.tentativas < $1 AND a.ativo AND a.modo = 'ativo' AND a.agente_id IS NOT NULL
        AND e.criado_em > NOW() - ($2 || ' minutes')::interval ORDER BY e.id LIMIT 10`, [MAX_TENTATIVAS, String(JANELA_RETRY_MIN)]);
  for (const f of r.rows) {
    try {
      await db.query(`UPDATE public.automacao_execucao SET tentativas = tentativas + 1 WHERE id = $1`, [f.id]);
      let texto = f.texto;
      if (!texto) { const a = await analisarCliente(Number(f.ticket_id), { userEmail: 'automacao@hub-360' }); if (!a) continue; texto = textoDaAnalise(a); }
      await escreverNota({ agente_id: f.agente_id }, f.ticket_id, texto);
      await db.query(`UPDATE public.automacao_execucao SET status='enviado', texto=$2, erro=NULL, atualizado_em=NOW() WHERE id=$1`, [f.id, texto]);
    } catch (e) { await db.query(`UPDATE public.automacao_execucao SET erro=$2, atualizado_em=NOW() WHERE id=$1`, [f.id, String(e.message).slice(0, 400)]); }
  }
}

// ── Gatilho agendado ────────────────────────────────────────────────────
let rodando = false;
async function cicloAgendado() {
  if (rodando) return;
  rodando = true;
  try {
    const estado = await lerEstado();
    if (!estado.ligado) return;
    if (!(await iaConfigurada().catch(() => false))) return;
    const regras = (await db.query(`SELECT * FROM public.automacao WHERE ativo AND gatilho = 'agendado'
        AND (ultimo_ciclo IS NULL OR ultimo_ciclo <= NOW() - (intervalo_min || ' minutes')::interval) ORDER BY id`)).rows;
    for (const regra of regras) await rodarRegraAgendada(regra);
    await reexecutarFalhas();
    await gravarEstado({ ultimoCiclo: new Date().toISOString(), ultimoErro: null });
  } catch (e) {
    console.warn('[automacoes] ciclo falhou:', e.message);
    await gravarEstado({ ultimoErro: String(e.message).slice(0, 300), ultimoCiclo: new Date().toISOString() }).catch(() => {});
  } finally { rodando = false; }
}

// Chamados abertos, criados na janela, que atendem às condições e ainda não foram tratados pela regra (regraId pode ser null na prévia).
async function buscarCandidatos(c, regraId, origem = 'agendado') {
  const cand = await db.query(`
    SELECT t.ticket_id::text AS id, t.subject, t.status, t.basestatus, t.urgency, t.ownerteam, t.service_full, t.createddate,
           (SELECT string_agg(DISTINCT cf.valor_texto, ', ') FROM silver.ticket_campo_customizado cf
             WHERE cf.ticket_id = t.ticket_id::bigint AND cf.custom_field_id::text = '${CF_CLASSIFICACAO}') AS classificacao
      FROM silver.ticket t
     WHERE t.basestatus = ANY($1) AND t.createddate >= NOW() - ($2 || ' days')::interval
       AND ($3::int IS NULL OR NOT EXISTS (SELECT 1 FROM public.automacao_execucao e WHERE e.automacao_id = $3 AND e.ticket_id = t.ticket_id::bigint))
     ORDER BY t.createddate DESC LIMIT 2000`, [ABERTOS, String(c.criadoUltimosDias), regraId]);
  return { total: cand.rows.length, casam: cand.rows.filter((t) => !motivoDeNaoCasar(t, c, origem)) };
}

async function rodarRegraAgendada(regra, origem = 'agendado') {
  const c = normalizarCondicoes(regra.condicoes);
  const resumo = { candidatos: 0, processados: 0, ignorados: 0 };
  // Pré-filtro no SQL (barato): abertos, criados na janela e ainda não tratados por esta regra. O resto das condições é conferido em memória.
  const { total, casam } = await buscarCandidatos(c, regra.id, origem === 'manual' ? 'agendado' : origem);
  resumo.candidatos = total; resumo.ignorados = total - casam.length;
  const cand = { rows: casam };
  const limite = Math.max(1, Math.min(50, regra.max_por_ciclo || 10));
  for (const t of cand.rows) {
    if (resumo.processados >= limite) break;
    const r = await executarNoChamado(regra, t, origem);
    if (r.status !== 'ja_tratado') resumo.processados++;
  }
  await db.query(`UPDATE public.automacao SET ultimo_ciclo = NOW(), ultimo_resumo = $2::jsonb WHERE id = $1`, [regra.id, JSON.stringify(resumo)]);
  return resumo;
}

// "Rodar agora": mesma varredura do gatilho agendado, na hora, respeitando o modo da regra (simulação não escreve no Movidesk),
// as condições e o limite por rodada. Funciona também com a regra/módulo desligados (é uma ação deliberada do admin). Uma rodada por vez.
async function rodarAgora(regra) {
  if (rodando) throw new Error('Já existe uma rodada em andamento. Aguarde alguns instantes e tente de novo.');
  if (!(await iaConfigurada().catch(() => false))) throw new Error('A chave da OpenAI não está configurada.');
  rodando = true;
  try { return await rodarRegraAgendada(regra, 'manual'); } finally { rodando = false; }
}

// ── Gatilho webhook (fila em memória, um chamado por vez) ───────────────
const fila = [];
let drenando = false;
function enfileirar(regraId, ticketId) {
  if (fila.length >= FILA_MAX) return false;
  if (fila.some((x) => x.regraId === regraId && x.ticketId === ticketId)) return true;
  fila.push({ regraId, ticketId });
  drenar().catch((e) => console.warn('[automacoes] fila:', e.message));
  return true;
}
async function drenar() {
  if (drenando) return;
  drenando = true;
  try {
    while (fila.length) {
      const { regraId, ticketId } = fila.shift();
      try { await processarWebhook(regraId, ticketId); } catch (e) { console.warn(`[automacoes] webhook chamado ${ticketId}:`, e.message); }
    }
  } finally { drenando = false; }
}
async function processarWebhook(regraId, ticketId) {
  const estado = await lerEstado();
  if (!estado.ligado) return;
  const regra = (await db.query(`SELECT * FROM public.automacao WHERE id = $1 AND ativo AND gatilho = 'webhook'`, [regraId])).rows[0];
  if (!regra || !(await iaConfigurada().catch(() => false))) return;
  // O chamado acabou de chegar: pode ainda não estar no banco (a carga roda a cada 15 min). Grava o chamado com o mesmo gravador da carga.
  let t = await lerChamado(ticketId);
  if (!t) {
    try { await require('../scripts/movidesk-loader').sincronizarTicket(ticketId); } catch (e) { console.warn('[automacoes] sincronizarTicket:', e.message); }
    t = await lerChamado(ticketId);
  }
  if (!t) return;
  const motivo = motivoDeNaoCasar(t, normalizarCondicoes(regra.condicoes), 'webhook');
  if (motivo) {
    await db.query(`INSERT INTO public.automacao_execucao (automacao_id, automacao_nome, ticket_id, origem, status, modo, assunto, erro)
      VALUES ($1,$2,$3,'webhook','ignorado',$4,$5,$6) ON CONFLICT (automacao_id, ticket_id) DO NOTHING`,
      [regra.id, regra.nome, Number(ticketId), regra.modo, String(t.subject || '').slice(0, 300), motivo]);
    return;
  }
  await executarNoChamado(regra, t, 'webhook');
}

// O Movidesk pode mandar o número em formatos diferentes; aceita os mais comuns (corpo JSON ou query string).
function ticketDoPayload(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const cand = [b.id, b.Id, b.ticketId, b.TicketId, b.ticket_id, b.ticket?.id, b.Ticket?.Id, b.data?.id, b.data?.ticketId, req.query.id, req.query.ticketId, req.query.ticket];
  for (const v of cand) { const n = Number(v); if (Number.isInteger(n) && n > 0) return n; }
  return null;
}

let timer = null;
function iniciar() {
  garantirTabelas().catch((e) => console.error('[automacoes] tabelas:', e.message));
  clearInterval(timer);
  timer = setInterval(() => { cicloAgendado().catch(() => {}); }, 60 * 1000);
  timer.unref?.();
}

module.exports = {
  iniciar, garantirTabelas, lerEstado, gravarEstado, normalizarCondicoes, CONDICOES_PADRAO, ACOES, ABERTOS,
  lerChamado, buscarCandidatos, motivoDeNaoCasar, executarNoChamado, textoDaAnalise, enfileirar, ticketDoPayload, cicloAgendado, rodarAgora,
};
