// =========================
// Parâmetros do SLA
// =========================

const SLA_PRIMEIRO_CONTATO_MINUTOS = {
  "critica": 30,
  "alta": 60,
  "media": 120,
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
  // Chamado já encerrado: o tempo parado em Resolvido/Fechado/Cancelado não conta (Política de SLA, item 19.3:
  // na reabertura o período de inatividade permanece excluído). Sem isso, um chamado reaberto anos depois
  // somava milhares de horas ao tempo de solução.
  "resolvido", "resolved", "fechado", "closed", "cancelado", "canceled",
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
  if (dataStr instanceof Date) return dataStr;
  if (typeof dataStr === "object") {
    if (dataStr.createdDate) return parseData(dataStr.createdDate);
    if (dataStr.changedDate) return parseData(dataStr.changedDate);
    return null;
  }
  
  try {
    return new Date(dataStr);
  } catch (e) {
    return null;
  }
}

function ehDiaUtil(data) {
  const dia = data.getUTCDay();
  return dia !== 0 && dia !== 6; // Não domingo (0) nem sábado (6)
}

// Fuso de Brasília (America/Sao_Paulo): UTC-3, sem horário de verão desde 2019.
const FUSO_BRASILIA_MIN = -180;

function minutosUteisEntre(inicio, fim, fusoMin = 0) {
  /**
   * Calcula minutos úteis entre duas datas,
   * considerando segunda a sexta e os horários:
   * 07:45-12:00 e 13:30-18:00.
   * 
   * IMPORTANTE: Usa UTC para evitar problemas de fuso horário
   */

  if (!inicio || !fim || fim <= inicio) return 0;

  // fusoMin: os instantes vêm do banco em UTC; o expediente (07:45-12:00 / 13:30-18:00) é horário de Brasília.
  // Deslocar os dois extremos pelo fuso faz os getters UTC abaixo enxergarem o relógio de parede de Brasília
  // (a diferença entre eles, em minutos, não muda). Padrão 0 = comportamento antigo (expediente lido em UTC).
  if (fusoMin) {
    inicio = new Date(inicio.getTime() + fusoMin * 60000);
    fim = new Date(fim.getTime() + fusoMin * 60000);
  }

  let total = 0;
  let diaAtual = new Date(inicio);
  diaAtual.setUTCHours(0, 0, 0, 0);
  
  const diaFinal = new Date(fim);
  diaFinal.setUTCHours(0, 0, 0, 0);

  while (diaAtual <= diaFinal) {
    if (ehDiaUtil(diaAtual)) {
      for (const periodo of HORARIOS_ATENDIMENTO) {
        const periodoInicio = new Date(diaAtual);
        periodoInicio.setUTCHours(periodo.inicio, periodo.inicioMin, 0, 0);
        
        const periodoFim = new Date(diaAtual);
        periodoFim.setUTCHours(periodo.fim, periodo.fimMin, 0, 0);

        const inicioCalculo = new Date(Math.max(inicio.getTime(), periodoInicio.getTime()));
        const fimCalculo = new Date(Math.min(fim.getTime(), periodoFim.getTime()));

        if (fimCalculo > inicioCalculo) {
          total += Math.floor((fimCalculo - inicioCalculo) / 60000); // Converter ms em minutos
        }
      }
    }

    diaAtual.setUTCDate(diaAtual.getUTCDate() + 1);
  }

  return total;
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
  
  // Default: Média (16 horas úteis)
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

function calcularMinutosUteisComPausas(ticket, inicio, fim, fusoMin = 0) {
  /**
   * Calcula minutos úteis entre abertura e primeiro contato,
   * descontando períodos em status de pausa.
   */

  const eventos = montarLinhaDoTempoStatus(ticket);

  if (eventos.length === 0) {
    return minutosUteisEntre(inicio, fim, fusoMin);
  }

  let total = 0;
  let statusAtual = eventos[0].status;
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
      total += minutosUteisEntre(cursor, dataEvento, fusoMin);
    }

    cursor = dataEvento;
    statusAtual = evento.status;
  }

  // Último trecho até o primeiro contato
  if (cursor < fim && !ehStatusPausado(statusAtual)) {
    total += minutosUteisEntre(cursor, fim, fusoMin);
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

module.exports = {
  calcularSLAPrimeiroContato,
  calcularMinutosUteisComPausas,
  minutosUteisEntre,
  FUSO_BRASILIA_MIN,
  normalizar,
  parseData,
};
