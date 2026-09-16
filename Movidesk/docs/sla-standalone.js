// Generated from server/utils/sla.js; keep both versions in sync.
// =========================
// Parâmetros do SLA
// =========================

const SLA_PRIMEIRO_CONTATO_MINUTOS = {
  "critica": 30,
  "alta": 60,
  "media": 120,
  "baixa": 240,
};

const HORARIOS_ATENDIMENTO = [
  { inicio: 7, inicioMin: 45, fim: 12, fimMin: 0 },    // 07:45-12:00
  { inicio: 13, inicioMin: 30, fim: 18, fimMin: 0 },   // 13:30-18:00
];

const STATUS_PAUSA_SLA = new Set([
  "aguardando retorno do cliente",
  "aguardando terceiro/fornecedor",
  "aguardando validação do cliente",
  "aguardando validacao do cliente",
  "em atendimento - desenvolvimento",
  "em atendimento desenvolvimento",
]);

// =========================
// Funções utilitárias
// =========================

function normalizar(texto) {
  if (!texto) return "";

  texto = texto.trim().toLowerCase();
  // Remove acentos usando decomposição Unicode
  texto = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return texto;
}

function parseData(dataStr) {
  if (!dataStr) return null;
  if (dataStr instanceof Date) return Number.isFinite(dataStr.getTime()) ? dataStr : null;
  if (typeof dataStr === "object") {
    if (dataStr.createdDate) return parseData(dataStr.createdDate);
    if (dataStr.changedDate) return parseData(dataStr.changedDate);
    return null;
  }

  try {
    const parsed = new Date(dataStr);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function ehDiaUtil(data) {
  const dia = data.getUTCDay();
  return dia !== 0 && dia !== 6; // Não domingo (0) nem sábado (6)
}

const businessClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function wallClock(date) {
  const p = Object.fromEntries(businessClock.formatToParts(date).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
function businessInstant(day, hour, minute) {
  const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  let instant = target;
  // Convert a local business boundary to UTC using the IANA zone, including historical DST.
  for (let i = 0; i < 3; i++) instant += target - wallClock(new Date(instant));
  return instant;
}
function minutosUteisEntre(inicio, fim) {
  inicio = parseData(inicio); fim = parseData(fim);
  if (!inicio || !fim || fim <= inicio) return 0;
  if (fim - inicio > 100 * 366 * 86400000) throw new Error('Intervalo de SLA inválido');
  const day = new Date(wallClock(inicio)); day.setUTCHours(0, 0, 0, 0);
  const last = new Date(wallClock(fim)); last.setUTCHours(0, 0, 0, 0);
  let elapsed = 0;
  while (day <= last) {
    if (ehDiaUtil(day)) for (const p of HORARIOS_ATENDIMENTO) {
      const start = Math.max(inicio.getTime(), businessInstant(day, p.inicio, p.inicioMin));
      const end = Math.min(fim.getTime(), businessInstant(day, p.fim, p.fimMin));
      elapsed += Math.max(0, end - start);
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return elapsed / 60000;
}

function obterMinutosSLAPorUrgencia(ticket) {
  const urgencia = normalizar(ticket.urgency || ticket.slaAgreementRule || "");

  // Tentar match direto
  if (urgencia in SLA_PRIMEIRO_CONTATO_MINUTOS) {
    return SLA_PRIMEIRO_CONTATO_MINUTOS[urgencia];
  }

  // Tentar match parcial
  if (urgencia.includes("critica")) return 30;
  if (urgencia.includes("alta")) return 60;
  if (urgencia.includes("media")) return 120;
  if (urgencia.includes("baixa")) return 240;

  // Default: Média (2 horas úteis)
  return 120;
}

function ehStatusPausado(status) {
  return STATUS_PAUSA_SLA.has(normalizar(status));
}

// =========================
// Primeiro contato
// =========================

function encontrarPrimeiroContato(ticket) {
  /**
   * Considera primeiro contato a primeira ação pública feita por um agente,
   * excluindo ações criadas pelo solicitante/cliente.
   */

  const actions = ticket.actions || [];

  const clientesIds = new Set();
  (ticket.clients || []).forEach(cliente => {
    if (cliente.id) clientesIds.add(String(cliente.id));
  });

  if (ticket.createdBy && ticket.createdBy.id) {
    clientesIds.add(String(ticket.createdBy.id));
  }

  const acoesOrdenadas = [...actions].sort((a, b) => {
    const dataA = parseData(a.createdDate) || new Date(0);
    const dataB = parseData(b.createdDate) || new Date(0);
    return dataA - dataB;
  });

  for (const action of acoesOrdenadas) {
    if (action.isDeleted) continue;
    if (action.type !== 2) continue; // type 2 = ação pública

    const criadoPorId = String((action.createdBy || {}).id || "");
    if (clientesIds.has(criadoPorId)) continue;

    if (!parseData(action.createdDate)) continue;
    return {
      actionId: action.id,
      createdDate: parseData(action.createdDate),
      createdBy: (action.createdBy || {}).businessName,
      description: action.description,
    };
  }

  return null;
}

// =========================
// Pausas de SLA
// =========================

function montarLinhaDoTempoStatus(ticket) {
  /**
   * Preferência:
   * 1. Usa statusHistories, se existir.
   * 2. Caso contrário, usa os status das actions como aproximação.
   */

  const eventos = [];

  if (ticket.statusHistories && ticket.statusHistories.length > 0) {
    ticket.statusHistories.forEach(item => {
      const data = parseData(item.changedDate);
      const status = item.status;

      if (data && status) {
        eventos.push({ data, status });
      }
    });
  } else {
    (ticket.actions || []).forEach(action => {
      const data = parseData(action.createdDate);
      const status = action.status;

      if (data && status) {
        eventos.push({ data, status });
      }
    });
  }

  eventos.sort((a, b) => a.data - b.data);

  return eventos;
}

function calcularMinutosUteisComPausas(ticket, inicio, fim) {
  /**
   * Calcula minutos úteis entre abertura e primeiro contato,
   * descontando períodos em status de pausa.
   */

  const eventos = montarLinhaDoTempoStatus(ticket);

  if (eventos.length === 0) {
    return minutosUteisEntre(inicio, fim);
  }

  let total = 0;
  let statusAtual = "Novo"; // A later pause must not apply retroactively to ticket creation.
  let cursor = inicio;

  for (const evento of eventos) {
    const dataEvento = evento.data;

    if (dataEvento <= inicio) {
      statusAtual = evento.status;
      continue;
    }

    if (dataEvento >= fim) {
      break;
    }

    if (!ehStatusPausado(statusAtual)) {
      total += minutosUteisEntre(cursor, dataEvento);
    }

    cursor = dataEvento;
    statusAtual = evento.status;
  }

  // Último trecho até o primeiro contato
  if (cursor < fim && !ehStatusPausado(statusAtual)) {
    total += minutosUteisEntre(cursor, fim);
  }

  return total;
}

// =========================
// Cálculo principal
// =========================

function calcularSLAPrimeiroContato(ticket) {
  const abertura = parseData(ticket.createdDate);
  const primeiroContato = encontrarPrimeiroContato(ticket);

  const slaPrevistoMinutos = obterMinutosSLAPorUrgencia(ticket);

  const resultado = {
    ticketId: ticket.id,
    urgency: ticket.urgency,
    slaAgreementRule: ticket.slaAgreementRule,
    slaPrevistoMinutos,
    abertura: abertura ? abertura.toISOString() : null,
    primeiroContatoEncontrado: false,
    primeiroContato: null,
    minutosUteisConsumidos: null,
    dentroDoSLA: null,
    minutosEstouro: null,
  };

  if (!abertura) {
    return resultado;
  }

  if (!primeiroContato) {
    return resultado;
  }

  const dataPrimeiroContato = primeiroContato.createdDate;

  const minutosConsumidos = calcularMinutosUteisComPausas(
    ticket,
    abertura,
    dataPrimeiroContato
  );

  const dentrodoSLA = minutosConsumidos <= slaPrevistoMinutos;

  resultado.primeiroContatoEncontrado = true;
  resultado.primeiroContato = {
    actionId: primeiroContato.actionId,
    createdDate: dataPrimeiroContato.toISOString(),
    createdBy: primeiroContato.createdBy,
  };
  resultado.minutosUteisConsumidos = minutosConsumidos;
  resultado.dentroDoSLA = dentrodoSLA;
  resultado.minutosEstouro = Math.max(0, minutosConsumidos - slaPrevistoMinutos);

  return resultado;
}

if (typeof module !== "undefined" && module.exports) module.exports = {
  calcularSLAPrimeiroContato,
  minutosUteisEntre,
  normalizar,
  parseData,
  calcularMinutosUteisComPausas,
  encontrarPrimeiroContato,
};

// ─── Exemplo de uso (execute: node sla-standalone.js) ────────────

if (typeof require !== "undefined" && require.main === module) {
  const ticketExemplo = {
    id: 823408,
    createdDate: "2026-04-28T13:00:00.000Z",
    urgency: "Alta",
    createdBy: { id: "cli_001" },
    clients: [{ id: "cli_001" }],
    actions: [
      {
        id: 9910,
        type: 2,
        isDeleted: false,
        createdDate: "2026-04-28T13:05:00.000Z",
        createdBy: { id: "cli_001", businessName: "Cliente" },
      },
      {
        id: 9912,
        type: 2,
        isDeleted: false,
        createdDate: "2026-04-28T14:18:00.000Z",
        createdBy: { id: "age_007", businessName: "Rafael Inácio" },
      },
    ],
    statusHistories: [
      { changedDate: "2026-04-28T13:00:00.000Z", status: "Novo" },
      { changedDate: "2026-04-28T13:10:00.000Z", status: "Em Atendimento" },
    ],
  };

  const resultado = calcularSLAPrimeiroContato(ticketExemplo);
  console.log("── Resultado SLA ───────────────────────────────");
  console.log(`Ticket:          #${resultado.ticketId}`);
  console.log(`Urgência:        ${resultado.urgency}`);
  console.log(`Prazo previsto:  ${resultado.slaPrevistoMinutos} min`);
  console.log(`Primeiro contato encontrado: ${resultado.primeiroContatoEncontrado}`);
  if (resultado.primeiroContatoEncontrado) {
    console.log(`Primeiro contato por: ${resultado.primeiroContato.createdBy}`);
    console.log(`Tempo consumido: ${resultado.minutosUteisConsumidos} min úteis`);
    console.log(`Dentro do SLA:   ${resultado.dentroDoSLA}`);
    console.log(`Estouro:         ${resultado.minutosEstouro} min`);
  }
  console.log("────────────────────────────────────────────────");
}
