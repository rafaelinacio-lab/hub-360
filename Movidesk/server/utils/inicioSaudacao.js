'use strict';
// Saudação da tela "Início": uma por pessoa por dia, que NUNCA repete para aquela pessoa.
//   1) IA (utils/ai.js, source 'inicio_saudacao'): recebe só números agregados e o primeiro nome + as últimas saudações dela,
//      devolve {saudacao}; o servidor valida (tamanho, emoji, números que não existem no contexto, repetição/semelhança).
//   2) Banco de frases de reserva (IA desligada, sem chave, erro ou mais de 8 s): aberturas × corpos por situação, sempre
//      escolhendo uma combinação que a pessoa nunca recebeu.
// Tabela public.hub_inicio_saudacao (user_id, dia, texto, chave, origem): PK (user_id, dia) = uma por dia (recarregar devolve
// a mesma) e UNIQUE (user_id, chave) = nunca repete (a chave é o texto normalizado, sem acento nem pontuação).
// Desligar a IA: config 'inicio_saudacao_ia' = '0' (padrão ligada). O conteúdo dos chamados nunca vai para a IA.
const db = require('../db/remote');

const LIMITE_IA_MS = 8000;
const HISTORICO_PARA_IA = 30;
const MAX_CHARS = 140;

// ── normalização ───────────────────────────────────────────────────────────────────────────────────────────
const semAcento = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '');
const chaveDe = (t) => semAcento(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const palavras = (t) => new Set(chaveDe(t).split(' ').filter((p) => p.length > 2));
const similaridade = (a, b) => {   // Jaccard das palavras (>2 letras)
  const A = palavras(a), B = palavras(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const p of A) if (B.has(p)) i++;
  return i / (A.size + B.size - i);
};
const qtdEmoji = (t) => (String(t).match(/\p{Extended_Pictographic}/gu) || []).length;
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// ── armazenamento (tabela própria; _store é trocável nos testes) ───────────────────────────────────────────────
let _tabela = null;
function garantirTabela() {
  if (!_tabela) {
    _tabela = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.hub_inicio_saudacao (
          user_id   INTEGER NOT NULL,
          dia       DATE NOT NULL,
          texto     TEXT NOT NULL,
          chave     TEXT NOT NULL,
          origem    TEXT,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, dia),
          UNIQUE (user_id, chave)
        )`);
    })().catch((e) => { _tabela = null; throw e; });
  }
  return _tabela;
}
const _store = {
  async doDia(userId, dia) {
    await garantirTabela();
    const r = await db.query(`SELECT texto, origem FROM public.hub_inicio_saudacao WHERE user_id = $1 AND dia = $2`, [userId, dia]);
    return r.rows[0] || null;
  },
  async historico(userId) {
    await garantirTabela();
    const r = await db.query(`SELECT texto, chave FROM public.hub_inicio_saudacao WHERE user_id = $1 ORDER BY dia DESC`, [userId]);
    return r.rows;
  },
  // devolve true se gravou; false se o dia já tinha saudação; lança { code: '23505', constraint chave } se o texto já foi usado
  async gravar(userId, dia, texto, chave, origem) {
    await garantirTabela();
    const r = await db.query(
      `INSERT INTO public.hub_inicio_saudacao (user_id, dia, texto, chave, origem) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, dia) DO NOTHING RETURNING texto`, [userId, dia, texto, chave, origem]);
    return r.rows.length > 0;
  },
};

// ── banco de frases de reserva ─────────────────────────────────────────────────────────────────────────────
// {sd} = Bom dia/Boa tarde/Boa noite · {nome} = primeiro nome · {dias} {seq} {venc} {abertos} {hoje} {feriado} = do contexto
const ABERTURAS = [
  '{sd}, {nome}!', '{sd}, {nome}.', 'Oi, {nome}! {sd}.', '{sd}! Que bom ver você, {nome}.', '{nome}, {sd}!', 'Olá, {nome}. {sd}!',
  '{sd}, {nome} — tudo certo?', 'E aí, {nome}? {sd}!', '{sd}, {nome}. Seja bem-vindo(a) de volta.', 'Oi, {nome}.', 'Que bom te ver, {nome}. {sd}!',
  '{nome}, {sd} e boas-vindas.', 'Chegou {nome}! {sd}.', '{sd}, {nome}. Vamos lá?',
];
// cada corpo: t = texto; se = condição sobre o contexto (omitida = vale sempre)
const CORPOS = [
  // sem condição (neutros)
  ...[
    'O resumo de hoje já está pronto logo abaixo.', 'Separei o que importa da sua fila e da sua equipe.', 'Tudo o que mudou está logo aqui embaixo.',
    'Vamos ver como está o dia da equipe.', 'Um olhar rápido no que é seu e no que é do time.', 'Aqui vai o retrato do dia, sem rodeios.',
    'Deixei o essencial à mão para você começar.', 'O painel está atualizado e esperando por você.', 'Primeiro o resumo, depois o café.',
    'Dá uma olhada no que está em andamento.', 'Vamos organizar o dia com calma.', 'O que está pendente aparece primeiro.',
    'Os números abaixo são de agora.', 'Começamos pelo que pede atenção.', 'Um passo de cada vez; o resumo ajuda.',
    'A fila fala por si, e eu só organizei.', 'Segue o panorama da sua equipe.', 'Hoje o foco é manter o ritmo.',
    'Boa hora para ver o que ficou pendente.', 'O Hub trouxe o resumo mais recente.', 'Resumo fresquinho, direto da base.',
    'O time já está na estrada; veja como anda.', 'Que o dia seja leve para a fila.', 'Cada chamado resolvido deixa a fila mais leve.',
    'Aqui você acompanha sua fila e a da equipe.', 'O que importa está nos cartões abaixo.', 'Vamos transformar pendências em resolvidos.',
    'Deixei tudo organizado para você decidir por onde começar.', 'Mais um dia para fazer o suporte brilhar.', 'Sem pressa, mas sem perder o prazo.',
    'Confira como a equipe está agora.', 'Quando precisar, é só abrir uma das abas lá em cima.', 'O melhor ponto de partida é o resumo de hoje.',
    'O foco do dia está logo aqui.', 'Tem novidade na equipe; confira abaixo.', 'Prazos em dia deixam o cliente feliz.',
    'Uma boa leitura do dia começa por aqui.', 'Vamos conferir o que a equipe fez e o que falta fazer.', 'Pronto: tudo atualizado para você.',
    'A equipe agradece cada chamado bem resolvido.', 'Hoje vale priorizar o que está perto do prazo.', 'Respire fundo e comece pelo que vence primeiro.',
    'O resumo ajuda a decidir por onde começar.', 'Os cartões abaixo mostram você e o time lado a lado.', 'Olhe primeiro o que está mais antigo.',
    'Bom dia de trabalho começa com visão clara da fila.', 'Passei os olhos na fila; o resumo está aí.', 'Aqui tudo se atualiza sozinho, fique à vontade.',
    'Um bom suporte começa com uma boa visão do dia.', 'O resumo já considera a sua vertical.',
  ].map((t) => ({ t })),
  ...[
    'Quando a fila anda, o cliente sente.', 'Pequenas vitórias do dia também contam.', 'Que cada resposta de hoje seja clara e rápida.',
    'Prioridade é decidir o que não pode esperar.', 'O resumo está aqui; o ritmo é seu.', 'Ver o todo ajuda a escolher o próximo passo.',
    'Boa leitura, bom trabalho e bons resultados.', 'Cuidar da fila é cuidar do cliente.', 'O time conta com você, e você com o time.',
    'Hoje é dia de manter o SLA em alta.', 'Foco no que gera mais valor para o cliente.', 'Aqui está o que mudou, sem enrolação.',
    'Mais clareza, menos correria: comece pelo resumo.', 'Quem enxerga a fila decide melhor.', 'Antes de mergulhar, uma olhada geral ajuda.',
    'Respostas rápidas e claras fazem diferença.', 'O painel guardou o que importa para você.', 'Que o dia renda e a fila diminua.',
    'Cada detalhe do resumo ajuda a priorizar.', 'Seu time está de olho; o resumo mostra como estamos.', 'Um bom dia de suporte é feito de decisões pequenas.',
    'Resumo do dia pronto, escolha por onde atacar.', 'Aqui o dia começa com informação em dia.', 'Antes do primeiro chamado, uma visão do todo.',
  ].map((t) => ({ t })),
  // primeira visita
  ...[
    'É a sua primeira vez por aqui; fique à vontade para explorar.', 'Primeira visita! Daqui em diante eu vou lembrar do seu caminho.',
    'Este é o seu ponto de partida: resumo, equipe e atalhos.', 'Por aqui você vê o seu dia e o da equipe de relance.',
    'Bem-vindo(a) ao Hub: o resumo abaixo é só o começo.', 'Primeiro acesso por aqui; as abas lá em cima levam ao resto.',
  ].map((t) => ({ t, se: (c) => c.primeira })),
  // voltou depois de 1 dia
  ...[
    'Você esteve aqui ontem; veja o que mudou desde então.', 'Ontem foi a última vez que você passou por aqui; segue o que mudou.',
    'De ontem para hoje, a fila andou; confira.', 'Voltou rápido! Veja as novidades de ontem para cá.',
  ].map((t) => ({ t, se: (c) => c.diasDesde === 1 })),
  // fila dele
  ...[
    'Você tem {venc} chamado(s) passando da meta; vale começar por eles.', 'Atenção: {venc} chamado(s) seu(s) já passaram da meta.',
    'Seus vencidos hoje: {venc}. Comece por eles se puder.', 'Há {venc} chamado(s) seu(s) pedindo atenção por causa do prazo.',
  ].map((t) => ({ t, se: (c) => c.filaVencidos > 0 })),
  ...[
    'Sua fila está em dia: {abertos} em aberto e nenhum vencido.', 'Nenhum chamado seu passou da meta; bom trabalho.',
    'Fila organizada: {abertos} em aberto, todos dentro do prazo.', 'Nada vencido na sua fila agora.',
  ].map((t) => ({ t, se: (c) => c.filaAbertos > 0 && c.filaVencidos === 0 })),
  ...[
    'Sua fila está limpa agora; bom momento para ajudar a equipe.', 'Sem chamados em aberto na sua fila; ótimo momento para respirar.',
    'Fila zerada por aqui, aproveite para olhar a equipe.',
  ].map((t) => ({ t, se: (c) => c.vinculado && c.filaAbertos === 0 })),
  ...[
    'Hoje vencem {hoje} chamado(s) seu(s); vale priorizar.', 'Tem {hoje} chamado(s) seu(s) com prazo terminando hoje.',
  ].map((t) => ({ t, se: (c) => c.vencemHoje > 0 })),
  // dia da semana
  ...[
    ['Segunda-feira: a semana começa agora, com calma e foco.', 'Começo de semana; um passo de cada vez.', 'Segundou! O resumo ajuda a arrumar a semana.'],
    ['Terça-feira: a semana já pegou ritmo.', 'Terça é dia de manter o embalo.', 'Já é terça, e a fila segue andando.'],
    ['Quarta-feira: meio da semana, hora de conferir o rumo.', 'Quarta: metade do caminho já foi.', 'No meio da semana, vale olhar o resumo com carinho.'],
    ['Quinta-feira: a reta final da semana começou.', 'Quinta: falta pouco para o fim de semana.', 'Quinta é dia de fechar pontas soltas.'],
    ['Sexta-feira: hora de deixar a fila organizada para a semana que vem.', 'Sextou! Mas ainda dá para fechar bastante coisa.', 'Sexta: um último gás antes do descanso.'],
    ['Sábado de plantão? O resumo está aqui para ajudar.', 'Fim de semana por aqui; obrigado pela dedicação.'],
    ['Domingo por aqui? Obrigado pela dedicação.', 'Mesmo no domingo, o resumo está em dia.'],
  ].flatMap((lista, dow) => lista.map((t) => ({ t, se: (c) => c.dow === dow }))),
  // feriado e calendário
  ...[
    'Amanhã é {feriado}; hoje vale fechar o que der.', 'Véspera de {feriado}: bom dia para deixar a fila em ordem.',
    'Com {feriado} amanhã, vale organizar o que fica pendente.',
  ].map((t) => ({ t, se: (c) => !!c.feriadoAmanha })),
  ...[
    'Começo de mês: números zerados e tudo por fazer.', 'Mês novo, metas novas; o resumo mostra onde estamos.', 'Início de mês é bom momento para olhar o SLA.',
  ].map((t) => ({ t, se: (c) => c.diaMes <= 3 })),
  ...[
    'Fim de mês chegando: vale conferir o que ainda dá para fechar.', 'Reta final do mês; o SLA agradece cada chamado no prazo.',
    'Faltam poucos dias para fechar o mês; o resumo mostra como estamos.',
  ].map((t) => ({ t, se: (c) => c.diaMes >= 27 })),
  // período do dia
  ...[
    'Que o café ajude hoje.', 'Manhã é ótima para atacar o que está mais antigo.', 'A manhã rende; comece pelo que pesa mais.',
  ].map((t) => ({ t, se: (c) => c.periodo === 'manha' })),
  ...[
    'A tarde é boa para fechar o que ficou aberto.', 'Metade do dia já foi; veja como estamos.', 'Depois do almoço, um bom momento para rever a fila.',
  ].map((t) => ({ t, se: (c) => c.periodo === 'tarde' })),
  ...[
    'Já é noite, e você ainda por aqui; obrigado pelo empenho.', 'Hora de fechar o dia com a fila sob controle.', 'Última olhada do dia: o resumo está aí.',
  ].map((t) => ({ t, se: (c) => c.periodo === 'noite' })),
];
const SD = { manha: 'Bom dia', tarde: 'Boa tarde', noite: 'Boa noite' };
const EMOJI = { manha: '☀️', tarde: '🌤️', noite: '🌙' };

const preencher = (modelo, c) => modelo
  .replace(/\{sd\}/g, SD[c.periodo] || 'Olá').replace(/\{nome\}/g, c.primeiroNome || 'colega')
  .replace(/\{dias\}/g, c.diasDesde == null ? '' : String(c.diasDesde)).replace(/\{seq\}/g, String(c.sequencia || ''))
  .replace(/\{venc\}/g, String(c.filaVencidos || 0)).replace(/\{abertos\}/g, String(c.filaAbertos || 0))
  .replace(/\{hoje\}/g, String(c.vencemHoje || 0)).replace(/\{feriado\}/g, c.feriadoAmanha || '');

const TOTAL_MODELOS = ABERTURAS.length + CORPOS.length;

// Escolhe, em ordem determinística por (pessoa, dia), uma combinação abertura × corpo que ela nunca recebeu.
// Em ~70% dos dias os corpos que citam a situação real (fila, feriado…) vêm primeiro.
function doBanco(c, usadas, semente) {
  const corpos = CORPOS.filter((x) => !x.se || x.se(c));
  const situacaoPrimeiro = hash(`${semente}:p`) % 10 < 7;
  const cand = [];
  corpos.forEach((corpo, ci) => ABERTURAS.forEach((_, ai) => cand.push({ ci, ai, prio: (corpo.se ? 0 : 1) ^ (situacaoPrimeiro ? 0 : 1), h: hash(`${semente}:${ci}:${ai}`) })));
  cand.sort((x, y) => x.prio - y.prio || x.h - y.h);
  for (const { ci, ai } of cand) {
    const base = `${preencher(ABERTURAS[ai], c)} ${preencher(corpos[ci].t, c)}`.replace(/\s+/g, ' ').trim();
    if (base.length > MAX_CHARS) continue;
    // um emoji em ~1/3 dos dias (nunca mais de um)
    const texto = hash(`${semente}:e`) % 3 === 0 && base.length + 3 <= MAX_CHARS ? `${base} ${EMOJI[c.periodo] || '👋'}` : base;
    if (!usadas.has(chaveDe(texto))) return texto;
  }
  // esgotou todas as combinações: acrescenta a data para ser inédito
  return `${preencher(ABERTURAS[0], c)} ${c.dataBr}: o resumo de hoje está pronto.`;
}

// ── IA ────────────────────────────────────────────────────────────────────────────────────────────────────
async function iaLigada() {
  try {
    const r = await db.query(`SELECT value FROM config WHERE key = 'inicio_saudacao_ia'`);
    return !(r.rows[0] && String(r.rows[0].value).trim() === '0');
  } catch { return true; }
}
function numerosPermitidos(c) {
  const s = new Set();
  [c.diaMes, c.mes, c.diasDesde, c.sequencia, c.filaAbertos, c.filaVencidos, c.vencemHoje].forEach((n) => { if (n != null && Number.isFinite(Number(n))) s.add(String(Number(n))); });
  (String(c.dataBr || '').match(/\d+/g) || []).forEach((n) => { s.add(String(Number(n))); });
  return s;
}
function validarIA(texto, c, historico) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (t.length < 12 || t.length > MAX_CHARS) return { ok: false, motivo: 'tamanho' };
  if (/https?:\/\/|www\./i.test(t)) return { ok: false, motivo: 'link' };
  if (qtdEmoji(t) > 1) return { ok: false, motivo: 'emoji' };
  // frases batidas que a IA tende a repetir todo dia (o prompt também proíbe; aqui é garantia)
  if (/estamos (aqui|prontos)|no que precisar|[àa] disposi[cç][aã]o|qualquer coisa|\bbora\b|conte conosco|em que (posso|podemos) ajudar/i.test(semAcento(t))) return { ok: false, motivo: 'frase batida' };
  const ok = numerosPermitidos(c);
  for (const n of (t.match(/\d+/g) || [])) if (!ok.has(String(Number(n)))) return { ok: false, motivo: `número ${n} fora do contexto` };
  const chave = chaveDe(t);
  if (!chave) return { ok: false, motivo: 'vazio' };
  const sem = (x) => chaveDe(x).replace(new RegExp(`\\b${chaveDe(c.primeiroNome || '-')}\\b`, 'g'), '').trim();
  for (const h of historico) {
    if (h.chave === chave) return { ok: false, motivo: 'repetida' };
    if (similaridade(sem(h.texto), sem(t)) >= 0.7) return { ok: false, motivo: 'parecida com uma anterior' };
  }
  return { ok: true, texto: t, chave };
}
const SISTEMA_IA = `Você escreve a saudação curta da tela inicial de um painel interno de suporte (Hub 360 da Viasoft). Responda SOMENTE um JSON: {"saudacao":"..."}.
Regras: português do Brasil; 1 ou 2 frases, no máximo ${MAX_CHARS} caracteres; tom leve, caloroso e profissional; use o primeiro nome da pessoa uma única vez; no máximo 1 emoji; não invente fatos nem números (só cite números presentes no CONTEXTO); não prometa nada.
Escolha UM gancho real do CONTEXTO e construa a frase em torno dele (o dia da semana, o mês ou a data, véspera de feriado, a primeira visita, a fila dela). Nunca cite contagem de dias sem entrar nem sequência de dias seguidos. Sem gancho forte, faça uma observação curta e específica sobre o período do dia ou o dia da semana.
PROIBIDO: 'estamos aqui', 'estamos prontos', 'no que precisar', 'à disposição', 'qualquer coisa', 'sucesso', 'produtivo' e 'tranquilo' juntos, 'bora', gírias de internet. Nunca termine com oferta de ajuda.
NÃO repita nem se pareça com nenhuma das saudações anteriores listadas: mude a abertura, a estrutura, o ritmo e o assunto a cada dia. Nunca mencione dados de chamados ou de clientes.`;

async function daIA(c, historico, userEmail) {
  const { chamarIA } = require('./ai');
  const ctx = {
    primeiroNome: c.primeiroNome, saudacaoDoPeriodo: SD[c.periodo], periodo: c.periodo, diaDaSemana: ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'][c.dow],
    data: c.dataBr, primeiraVisita: !!c.primeira,
    feriadoAmanha: c.feriadoAmanha || null, fila: c.vinculado ? { emAberto: c.filaAbertos, vencidos: c.filaVencidos, vencemHoje: c.vencemHoje } : null,
    saudacoesAnteriores: historico.slice(0, HISTORICO_PARA_IA).map((h) => h.texto),
  };
  const tentar = async (temperature) => {
    const r = await Promise.race([
      chamarIA({ source: 'inicio_saudacao', system: SISTEMA_IA, user: `CONTEXTO:\n${JSON.stringify(ctx)}`, json: true, maxTokens: 120, temperature, userEmail, timeoutMs: LIMITE_IA_MS, meta: { dia: c.dia } }),
      new Promise((_, ko) => setTimeout(() => ko(new Error('tempo da IA esgotado')), LIMITE_IA_MS + 500)),
    ]);
    return validarIA(r && r.saudacao, c, historico);
  };
  let v = await tentar(0.9);
  if (!v.ok) v = await tentar(1.1);   // uma nova tentativa, mais criativa
  return v.ok ? v : null;
}

// ── principal ─────────────────────────────────────────────────────────────────────────────────────────────
// c: { dia 'YYYY-MM-DD', dataBr, periodo, dow, diaMes, mes, primeiroNome, primeira, diasDesde, sequencia, feriadoAmanha,
//      vinculado, filaAbertos, filaVencidos, vencemHoje }
async function obterSaudacao({ userId, userEmail, contexto: c }) {
  const existente = await _store.doDia(userId, c.dia);
  if (existente) return { texto: existente.texto, origem: existente.origem || 'banco', nova: false };
  const historico = await _store.historico(userId);
  const usadas = new Set(historico.map((h) => h.chave));
  let texto = null, origem = 'banco', chave = null, erroIA = null;
  if (await iaLigada()) {
    try {
      const v = await daIA(c, historico, userEmail);
      if (v) { texto = v.texto; chave = v.chave; origem = 'ia'; }
    } catch (e) { erroIA = e.message; }
  }
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    if (!texto) { texto = doBanco(c, usadas, `${userId}:${c.dia}:${tentativa}`); chave = chaveDe(texto); origem = 'banco'; }
    try {
      const gravou = await _store.gravar(userId, c.dia, texto, chave, origem);
      if (!gravou) { const j = await _store.doDia(userId, c.dia); return { texto: j.texto, origem: j.origem || 'banco', nova: false }; }
      return { texto, origem, nova: true, erroIA };
    } catch (e) {
      if (e && e.code === '23505') { usadas.add(chave); texto = null; continue; }   // já usada: tenta outra
      throw e;
    }
  }
  texto = `${preencher(ABERTURAS[0], c)} ${c.dataBr}: o resumo de hoje está pronto.`;
  await _store.gravar(userId, c.dia, texto, chaveDe(texto), 'banco').catch(() => {});
  return { texto, origem: 'banco', nova: true, erroIA };
}

module.exports = { obterSaudacao, doBanco, validarIA, chaveDe, similaridade, preencher, _store, TOTAL_MODELOS, ABERTURAS, CORPOS, SD, MAX_CHARS };
