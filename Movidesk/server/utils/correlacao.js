'use strict';
// Correlação de chamados em incidentes (sem IA: determinística e explicável).
// Agrupa chamados abertos recentes que são do mesmo serviço e têm assuntos parecidos
// (sobreposição de termos significativos). Um grupo só vira sugestão se tiver chamados
// suficientes de clientes diferentes — vários clientes com o mesmo sintoma indicam falha de serviço.
const SEM_VALOR = new Set((
  'de da do das dos para por com sem sob sobre em no na nos nas um uma uns umas ao aos que como mais menos muito ' +
  'nao não nem ser esta esse essa isso este ate até entre apos após the erro erros problema problemas ajuda duvida dúvida ' +
  'chamado ticket sistema favor urgente solicitacao solicitação preciso necessito gostaria apresentando apresenta ' +
  'ocorrendo quando ainda esta está estao estão fazer fazendo tentar tentando'
).split(/\s+/));

function termos(assunto) {
  const base = String(assunto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const sem = new Set([...SEM_VALOR].map((x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '')));
  const junto = base.replace(/\b([a-z]{2,4})-([a-z])\b/g, '$1$2');   // "NF-e" -> "nfe", "CT-e" -> "cte"
  // números de 3 a 5 dígitos (códigos de erro, ex.: rejeição 999) contam; números longos (nº de chamado, CNPJ) não
  return new Set(junto.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !(/^\d+$/.test(t) && t.length > 5) && !sem.has(t)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}
// termos presentes em pelo menos metade dos membros
function nucleo(membros) {
  const cont = new Map();
  for (const m of membros) for (const t of m.termos) cont.set(t, (cont.get(t) || 0) + 1);
  const min = Math.max(1, Math.ceil(membros.length / 2));
  return new Set([...cont].filter(([, n]) => n >= min).map(([t]) => t));
}
const primeiroNivel = (s) => String(s || '').split(' > ')[0].trim();

// tickets: [{id, assunto, servico, criadoEm, clienteId, cliente}]
function agrupar(tickets, { limiar = 0.34, minTickets = 3, minClientes = 2 } = {}) {
  const porServico = new Map();
  for (const t of tickets) {
    const tt = { ...t, termos: termos(t.assunto) };
    if (!tt.termos.size) continue;
    const k = primeiroNivel(t.servico) || '(sem serviço)';
    if (!porServico.has(k)) porServico.set(k, []);
    porServico.get(k).push(tt);
  }
  const grupos = [];
  for (const [servico, lista] of porServico) {
    lista.sort((a, b) => new Date(a.criadoEm) - new Date(b.criadoEm));
    const clusters = [];
    for (const t of lista) {
      let melhor = null, ms = 0;
      for (const c of clusters) { const s = jaccard(t.termos, c.core); if (s > ms) { ms = s; melhor = c; } }
      if (melhor && ms >= limiar) { melhor.membros.push(t); melhor.core = nucleo(melhor.membros); }
      else clusters.push({ membros: [t], core: new Set(t.termos) });
    }
    for (const c of clusters) {
      const clientes = new Set(c.membros.map((m) => m.clienteId || m.cliente).filter(Boolean));
      if (c.membros.length < minTickets || clientes.size < minClientes) continue;
      const coesao = c.membros.reduce((a, m) => a + jaccard(m.termos, c.core), 0) / c.membros.length;
      if (coesao < limiar) continue;
      const central = c.membros.reduce((b, m) => (jaccard(m.termos, c.core) > jaccard(b.termos, c.core) ? m : b), c.membros[0]);
      const datas = c.membros.map((m) => new Date(m.criadoEm).getTime());
      grupos.push({
        servico: servico === '(sem serviço)' ? '' : servico,
        titulo: String(central.assunto || '').trim().slice(0, 140),
        termos: [...c.core].slice(0, 6),
        coesao: Math.round(coesao * 100),
        clientes: clientes.size,
        primeiroEm: new Date(Math.min(...datas)).toISOString(), ultimoEm: new Date(Math.max(...datas)).toISOString(),
        tickets: c.membros.map((m) => ({ id: m.id, assunto: String(m.assunto || '').slice(0, 160), cliente: m.cliente || null, criadoEm: m.criadoEm })),
      });
    }
  }
  // mais chamados e mais clientes primeiro
  return grupos.sort((a, b) => b.clientes - a.clientes || b.tickets.length - a.tickets.length);
}

// Sugestão de impacto/urgência/gravidade conforme a abrangência.
function sugerirNiveis(g) {
  const impacto = g.clientes >= 6 ? 1 : g.clientes >= 3 ? 2 : 3;
  return { impacto, urgencia: 2, grave: g.clientes >= 10 };
}

// Chamados soltos que combinam com um incidente já aberto (título + assuntos dos chamados dele).
function relacionados(incidente, ticketsDoIncidente, candidatos, { limiar = 0.25, limite = 30 } = {}) {
  const base = ticketsDoIncidente.map((t) => ({ termos: termos(t.assunto) })).filter((m) => m.termos.size);
  const tit = termos(incidente.titulo);
  const core = new Set(tit);
  if (base.length) { const n = nucleo(base.length >= 3 ? base : base); for (const t of n) core.add(t); }
  const serv = primeiroNivel(incidente.servico).toLowerCase();
  return candidatos.map((c) => {
    const tm = termos(c.assunto);
    const mesmo = serv && primeiroNivel(c.servico).toLowerCase() === serv;
    let s = jaccard(tm, core);
    if (!s) return null;
    if (serv && !mesmo) s *= 0.5;   // outro serviço pesa menos, mas não elimina
    return { ...c, score: Math.round(s * 100), mesmoServico: !!mesmo };
  }).filter((x) => x && x.score >= Math.round(limiar * 100)).sort((a, b) => b.score - a.score).slice(0, limite);
}

module.exports = { termos, jaccard, agrupar, sugerirNiveis, relacionados };
