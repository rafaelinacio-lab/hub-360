'use strict';
// Política de SLA e Atendimento Técnico (POL-SLA-001): horas úteis por chamado, marcos, apuração mensal e extrato de horas técnicas.
// Funções PURAS (sem banco): recebem dados já lidos e a configuração. A leitura/gravação fica em routes/slaHoras.js.
// Tudo que a política deixa variável (janela, feriados, prazos por plano, faixas de crédito, status de pausa) está na configuração.
const FUSO_MIN = -180;   // Brasília (UTC-3, sem horário de verão)
const SEVERIDADES = ['Crítica', 'Alta', 'Média', 'Baixa'];

const semAcento = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const sevDe = (urgencia) => {
  const u = semAcento(urgencia);
  return u.startsWith('critic') ? 'Crítica' : u.startsWith('alta') ? 'Alta' : u.startsWith('media') ? 'Média' : u.startsWith('baixa') ? 'Baixa' : null;
};

const PADRAO = {
  // Seção 3.2: seg–sex 08h30–12h00 e 13h30–18h00 (8 horas úteis), exceto feriados nacionais, do PR e de Pato Branco.
  janela: [['08:30', '12:00'], ['13:30', '18:00']],
  // Ponto de partida editável (conferir/ajustar em Configurações → SLA e horas): feriados nacionais de 2026 e o estadual do PR.
  // Feriados municipais de Pato Branco/PR NÃO estão aqui: cadastre pela tela.
  feriados: [['2026-01-01', 'Confraternização Universal'], ['2026-04-03', 'Sexta-feira Santa'], ['2026-04-21', 'Tiradentes'], ['2026-05-01', 'Dia do Trabalho'],
    ['2026-09-07', 'Independência'], ['2026-10-12', 'Nossa Sra. Aparecida'], ['2026-11-02', 'Finados'], ['2026-11-15', 'Proclamação da República'],
    ['2026-11-20', 'Consciência Negra'], ['2026-12-19', 'Emancipação do Paraná'], ['2026-12-25', 'Natal']].map(([data, nome]) => ({ data, nome })),
  // Status do Movidesk em que a contagem fica suspensa (Seção 10) + chamado encerrado (item 19.3: inatividade excluída).
  pausas: ['Aguardando retorno do cliente', 'Aguardando terceiro/fornecedor', 'Aguardando validação do cliente', 'Em atendimento - desenvolvimento',
    'Resolvido', 'Resolved', 'Fechado', 'Closed', 'Cancelado', 'Canceled'],
  // Ações públicas desses autores (automações, avisos) NÃO valem como Primeira Resposta (Seção 2: só interação humana).
  autoresAutomaticos: [],
  planoPadrao: 'padrao',
  // Anexo A, em MINUTOS ÚTEIS: pr = Primeira Resposta, contorno, resolucao (null = não se aplica).
  planos: {
    padrao: {
      'Crítica': { pr: 45, contorno: 240, resolucao: 480 }, 'Alta': { pr: 120, contorno: 480, resolucao: 960 },
      'Média': { pr: 240, contorno: null, resolucao: 1440 }, 'Baixa': { pr: 480, contorno: null, resolucao: 1920 },
    },
    premium: {
      'Crítica': { pr: 30, contorno: 120, resolucao: 240 }, 'Alta': { pr: 60, contorno: 240, resolucao: 480 },
      'Média': { pr: 120, contorno: null, resolucao: 960 }, 'Baixa': { pr: 240, contorno: null, resolucao: 1440 },
    },
  },
  // Anexo A.5: cumprimento global mínimo (%) → horas técnicas de crédito. Avaliado do maior para o menor.
  creditos: [{ min: 90, horas: 0 }, { min: 85, horas: 4 }, { min: 80, horas: 8 }, { min: 75, horas: 12 }, { min: 0, horas: 16 }],
  gatilhoCriticoHoras: 4,      // A.6: Primeira Resposta/Contorno Crítico além do dobro do prazo → mínimo de 4 h
  limiteMensalHoras: 16,       // A.7 (Padrão)
  validadeMeses: 3,            // Seção 21.8
  minimoElegiveis: 5,          // Seção 20: abaixo disso a apuração acumula
  // Lançamento automático das horas técnicas ao fim de cada mês (a política vale desde 01/08/2026).
  automatico: { ativo: true, desde: '2026-08' },
};

const num = (v, min, max, pad) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : pad; };
const hhmm = (v, pad) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : pad);
function normalizar(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const janela = Array.isArray(e.janela) && e.janela.length ? e.janela.slice(0, 4).map((p, i) => [hhmm(p && p[0], PADRAO.janela[i % 2][0]), hhmm(p && p[1], PADRAO.janela[i % 2][1])]).filter((p) => p[0] < p[1]) : PADRAO.janela;
  const planos = {};
  for (const plano of ['padrao', 'premium']) {
    planos[plano] = {};
    for (const s of SEVERIDADES) {
      const o = (e.planos && e.planos[plano] && e.planos[plano][s]) || {}, d = PADRAO.planos[plano][s];
      const m = (k) => (o[k] === null ? null : o[k] === undefined ? d[k] : num(o[k], 1, 1000000, d[k]));
      planos[plano][s] = { pr: m('pr'), contorno: m('contorno'), resolucao: m('resolucao') };
    }
  }
  const creditos = (Array.isArray(e.creditos) && e.creditos.length ? e.creditos : PADRAO.creditos)
    .map((c) => ({ min: num(c && c.min, 0, 100, 0), horas: num(c && c.horas, 0, 1000, 0) })).sort((a, b) => b.min - a.min).slice(0, 10);
  return {
    janela: janela.length ? janela : PADRAO.janela,
    feriados: (Array.isArray(e.feriados) ? e.feriados : PADRAO.feriados).map((f) => ({ data: String(f && f.data || '').slice(0, 10), nome: String(f && f.nome || '').slice(0, 80) }))
      .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.data)).slice(0, 400),
    pausas: [...new Set((Array.isArray(e.pausas) ? e.pausas : PADRAO.pausas).map((s) => String(s).trim().slice(0, 120)).filter(Boolean))].slice(0, 80),
    autoresAutomaticos: [...new Set((Array.isArray(e.autoresAutomaticos) ? e.autoresAutomaticos : []).map((s) => String(s).trim().slice(0, 120)).filter(Boolean))].slice(0, 40),
    planoPadrao: e.planoPadrao === 'premium' ? 'premium' : 'padrao',
    planos, creditos,
    gatilhoCriticoHoras: num(e.gatilhoCriticoHoras, 0, 1000, PADRAO.gatilhoCriticoHoras),
    limiteMensalHoras: num(e.limiteMensalHoras, 0, 10000, PADRAO.limiteMensalHoras),
    validadeMeses: Math.round(num(e.validadeMeses, 1, 60, PADRAO.validadeMeses)),
    minimoElegiveis: Math.round(num(e.minimoElegiveis, 1, 1000, PADRAO.minimoElegiveis)),
    automatico: { ativo: !(e.automatico && e.automatico.ativo === false), desde: /^\d{4}-(0[1-9]|1[0-2])$/.test(String(e.automatico && e.automatico.desde)) ? e.automatico.desde : PADRAO.automatico.desde },
  };
}

// ── Horas úteis ────────────────────────────────────────────────────────────
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
// Minutos úteis entre dois instantes: seg–sex, dentro das janelas e fora de feriados (relógio de Brasília).
function minutosUteis(inicio, fim, cfg) {
  const a = new Date(inicio).getTime(), b = new Date(fim).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  const off = FUSO_MIN * 60000, feriados = new Set(cfg.feriados.map((f) => f.data));
  const janelas = cfg.janela.map(([i, f]) => [toMin(i), toMin(f)]);
  const dia0 = Math.floor((a + off) / 86400000), dia1 = Math.floor((b + off) / 86400000);
  let total = 0;
  for (let d = dia0; d <= dia1; d++) {
    const base = new Date(d * 86400000);
    const dow = base.getUTCDay();
    if (dow === 0 || dow === 6 || feriados.has(base.toISOString().slice(0, 10))) continue;
    for (const [i, f] of janelas) {
      const ini = d * 86400000 + i * 60000 - off, fimJ = d * 86400000 + f * 60000 - off;
      const lo = Math.max(a, ini), hi = Math.min(b, fimJ);
      if (hi > lo) total += hi - lo;
    }
  }
  return Math.round(total / 60000);
}

// Minutos úteis líquidos: desconta os trechos em status de pausa. eventos = [{ em, status }] (mudanças de status do chamado).
function minutosLiquidos(inicio, fim, eventos, cfg) {
  const pausas = new Set(cfg.pausas.map(semAcento));
  const ini = new Date(inicio).getTime(), fimMs = new Date(fim).getTime();
  const ev = (eventos || []).map((e) => ({ t: new Date(e.em).getTime(), s: semAcento(e.status) })).filter((e) => Number.isFinite(e.t)).sort((x, y) => x.t - y.t);
  let status = 'novo', cursor = ini, total = 0;
  for (const e of ev) {
    if (e.t <= ini) { status = e.s; continue; }
    if (e.t >= fimMs) break;
    if (!pausas.has(status)) total += minutosUteis(cursor, e.t, cfg);
    cursor = e.t; status = e.s;
  }
  if (cursor < fimMs && !pausas.has(status)) total += minutosUteis(cursor, fimMs, cfg);
  return total;
}

// ── Um chamado: marcos e se ficou dentro do SLA ───────────────────────────────
// c: { criadoEm, resolvidoEm, urgencia, eventos, primeiraRespostaEm|null, contornoEm|null }
function avaliarChamado(c, plano, cfg) {
  const sev = sevDe(c.urgencia);
  const prazos = sev ? cfg.planos[plano][sev] : null;
  const marco = (nome, fimEm, prazo) => {
    if (!prazo) return { nome, aplica: false, dentro: null };
    if (!fimEm) return { nome, aplica: true, prazo, minutos: null, dentro: null, semRegistro: true };
    const minutos = minutosLiquidos(c.criadoEm, fimEm, c.eventos, cfg);
    return { nome, aplica: true, prazo, minutos, dentro: minutos <= prazo, vezes: prazo ? minutos / prazo : null };
  };
  const pr = marco('Primeira Resposta', c.primeiraRespostaEm, prazos && prazos.pr);
  const contorno = marco('Contorno', c.contornoEm, prazos && prazos.contorno);
  const resolucao = marco('Resolução do Suporte', c.resolvidoEm, prazos && prazos.resolucao);
  const medidos = [pr, contorno, resolucao].filter((m) => m.dentro !== null);
  return {
    severidade: sev, plano, marcos: { pr, contorno, resolucao },
    // Seção 20.2: dentro do SLA só se TODOS os marcos aplicáveis (e medidos) foram cumpridos. null = nada mensurável.
    dentro: !sev || !medidos.length ? null : medidos.every((m) => m.dentro),
    // Contorno não é medido enquanto a equipe não registrar esse marco no Movidesk.
    naoMedidos: [pr, contorno, resolucao].filter((m) => m.aplica && m.dentro === null).map((m) => m.nome),
  };
}

// ── Apuração de um cliente na competência ────────────────────────────────────
function faixaCredito(pct, cfg) {
  const p = Math.round(pct * 100) / 100;
  for (const f of cfg.creditos) if (p >= f.min) return f.horas;
  return cfg.creditos.length ? cfg.creditos[cfg.creditos.length - 1].horas : 0;
}
// avaliados: resultados de avaliarChamado dos chamados elegíveis ENCERRADOS na competência.
function apurarCliente(avaliados, cfg) {
  const aval = avaliados.filter((a) => a.dentro !== null);
  const dentro = aval.filter((a) => a.dentro).length, fora = aval.length - dentro;
  const pct = aval.length ? (dentro / aval.length) * 100 : null;
  const ca = aval.filter((a) => a.severidade === 'Crítica' || a.severidade === 'Alta');
  const pctCA = ca.length ? (ca.filter((a) => a.dentro).length / ca.length) * 100 : null;
  // A.6: Primeira Resposta (ou Contorno) de chamado Crítico acima do DOBRO do prazo garante crédito mínimo.
  const gatilho = aval.some((a) => a.severidade === 'Crítica' && [a.marcos.pr, a.marcos.contorno].some((m) => m.dentro === false && m.minutos > 2 * m.prazo));
  let horas = pct === null ? 0 : faixaCredito(pct, cfg);
  if (gatilho) horas = Math.max(horas, cfg.gatilhoCriticoHoras);
  const acumula = aval.length < cfg.minimoElegiveis;   // Seção 20.5
  return { elegiveis: avaliados.length, avaliados: aval.length, dentro, fora, pct, pctCriticaAlta: pctCA, gatilhoCritico: gatilho,
    creditoFaixa: horas, creditoSugerido: Math.min(horas, cfg.limiteMensalHoras), acumula };
}

// ── Extrato de horas técnicas (livro de lançamentos) ─────────────────────────────
// lancamentos: [{ tipo: 'credito'|'uso'|'ajuste', horas (positivo p/ credito/uso, ±p/ ajuste), criado_em, validade (date|null) }]
// Os usos consomem o crédito que vence primeiro (FIFO). Crédito vencido sem uso vira "expirado".
function saldoExtrato(lancamentos, hoje = new Date()) {
  const ordem = [...lancamentos].sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
  const lotes = [];
  let usoTotal = 0, ajuste = 0;
  for (const l of ordem) {
    const h = Number(l.horas) || 0;
    if (l.tipo === 'credito') lotes.push({ restante: h, concedido: h, validade: l.validade ? new Date(l.validade) : null, em: l.criado_em });
    else if (l.tipo === 'uso') usoTotal += h;
    else if (l.tipo === 'ajuste') { if (h >= 0) lotes.push({ restante: h, concedido: h, validade: null, em: l.criado_em }); else usoTotal += -h; }
  }
  lotes.sort((a, b) => (a.validade ? a.validade.getTime() : Infinity) - (b.validade ? b.validade.getTime() : Infinity));
  let falta = usoTotal;
  for (const l of lotes) { const t = Math.min(l.restante, falta); l.restante -= t; falta -= t; }
  const vencido = (l) => l.validade && l.validade.getTime() < hoje.getTime();
  const disponivel = lotes.filter((l) => !vencido(l)).reduce((s, l) => s + l.restante, 0);
  const expirado = lotes.filter(vencido).reduce((s, l) => s + l.restante, 0);
  const proximo = lotes.filter((l) => !vencido(l) && l.restante > 0 && l.validade).sort((a, b) => a.validade - b.validade)[0] || null;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { concedido: r2(lotes.reduce((s, l) => s + l.concedido, 0)), usado: r2(usoTotal - Math.max(0, falta)), disponivel: r2(disponivel), expirado: r2(expirado),
    aVencer: proximo ? { horas: r2(proximo.restante), validade: proximo.validade.toISOString().slice(0, 10) } : null, excedenteUso: r2(Math.max(0, falta)) };
}
const somaMeses = (data, n) => { const d = new Date(data); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

module.exports = { PADRAO, SEVERIDADES, normalizar, minutosUteis, minutosLiquidos, avaliarChamado, apurarCliente, faixaCredito, saldoExtrato, somaMeses, sevDe, semAcento };
