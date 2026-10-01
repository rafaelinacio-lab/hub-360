'use strict';
// Regras de agendamento das crons automáticas, além do intervalo em minutos:
//   schedule = {
//     anchor: 'HH:MM' | null,   // alinha as execuções a partir deste horário (ex.: 02:00 + 1440 = todo dia às 02:00)
//     inicio: 'HH:MM' | null,   // janela de horário em que pode rodar (inicio > fim = atravessa a meia-noite)
//     fim:    'HH:MM' | null,
//     dias:   [0..6] | null     // dias da semana em que pode rodar (0 = domingo … 6 = sábado); vazio/null = todos
//   }
// Horários sempre no fuso de São Paulo (o do time), independente do fuso do servidor.
const TZ = 'America/Sao_Paulo';
const MIN_INTERVALO = 1;
// setInterval estoura em 2^31 ms (~24,8 dias): acima disso dispararia sem parar.
const MAX_INTERVALO = 24 * 24 * 60;
const DIAS_SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function parseHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? h * 60 + mi : null;
}
const fmtHM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function agoraSP(date = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const h = Number(partes.hour) % 24;
  return { dow: DIAS_SEMANA[partes.weekday], min: h * 60 + Number(partes.minute), seg: Number(partes.second) };
}

// Valida e limpa o que veio da tela. Lança Error com mensagem em português para erros do usuário.
function normalizarSchedule(bruto) {
  if (bruto == null || typeof bruto !== 'object') return null;
  const out = {};
  const hm = (campo, rotulo) => {
    const v = bruto[campo];
    if (v == null || v === '') return null;
    const min = parseHM(v);
    if (min == null) throw new Error(`${rotulo} inválido — use HH:MM (ex.: 07:30).`);
    return fmtHM(min);
  };
  out.anchor = hm('anchor', 'Horário de alinhamento');
  out.inicio = hm('inicio', 'Início da janela');
  out.fim = hm('fim', 'Fim da janela');
  if ((out.inicio && !out.fim) || (!out.inicio && out.fim)) throw new Error('Informe o início e o fim da janela de horário (ou deixe os dois vazios).');
  if (out.inicio && out.inicio === out.fim) throw new Error('O início e o fim da janela não podem ser iguais.');
  if (Array.isArray(bruto.dias) && bruto.dias.length) {
    const dias = [...new Set(bruto.dias.map(Number))];
    if (dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Dia da semana inválido.');
    out.dias = dias.sort((a, b) => a - b);
    if (out.dias.length === 7) out.dias = null;
  } else out.dias = null;
  if (!out.anchor && !out.inicio && !out.dias) return null;
  return out;
}

function validarIntervalo(v) {
  const m = Number(v);
  if (!Number.isFinite(m) || !Number.isInteger(m) || m < MIN_INTERVALO) throw new Error(`O intervalo mínimo é ${MIN_INTERVALO} minuto.`);
  if (m > MAX_INTERVALO) throw new Error(`O intervalo máximo é ${MAX_INTERVALO / 1440} dias.`);
  return m;
}

// A execução agendada em `date` cai dentro da janela de horário e dos dias permitidos?
function dentroDaJanela(schedule, date = new Date()) {
  if (!schedule) return true;
  const { dow, min } = agoraSP(date);
  const ini = parseHM(schedule.inicio), fim = parseHM(schedule.fim);
  if (ini != null && fim != null) {
    const dentro = ini < fim ? (min >= ini && min < fim) : (min >= ini || min < fim);
    if (!dentro) return false;
    // janela que atravessa a meia-noite: a parte depois da meia-noite pertence ao dia anterior
    const diaBase = (ini > fim && min < fim) ? (dow + 6) % 7 : dow;
    return !Array.isArray(schedule.dias) || !schedule.dias.length || schedule.dias.includes(diaBase);
  }
  return !Array.isArray(schedule.dias) || !schedule.dias.length || schedule.dias.includes(dow);
}

// Milissegundos até a próxima execução alinhada: horário-âncora + k × intervalo (em minutos no relógio de SP).
function atrasoAteProximo(anchorMin, intervaloMin, date = new Date()) {
  const { min, seg } = agoraSP(date);
  const agora = min + seg / 60;
  const resto = (((agora - anchorMin) % intervaloMin) + intervaloMin) % intervaloMin;
  const faltam = resto === 0 ? intervaloMin : intervaloMin - resto;
  return Math.round(faltam * 60000);
}

const NOMES_DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function descreverIntervalo(m) {
  m = Number(m) || 0;
  if (m >= 1440 && m % 1440 === 0) return m === 1440 ? '1x por dia' : (m === 10080 ? '1x por semana' : `A cada ${m / 1440} dias`);
  if (m >= 60 && m % 60 === 0) return m === 60 ? 'A cada 1 hora' : `A cada ${m / 60} horas`;
  return `A cada ${m} min`;
}
function descreverSchedule(s) {
  if (!s) return '';
  const p = [];
  if (Array.isArray(s.dias) && s.dias.length) {
    const d = s.dias;
    const seq = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
    p.push(seq && d.length > 2 ? `${NOMES_DIAS[d[0]]}–${NOMES_DIAS[d[d.length - 1]]}` : d.map((x) => NOMES_DIAS[x]).join(', '));
  }
  if (s.inicio && s.fim) p.push(`${s.inicio}–${s.fim}`);
  if (s.anchor) p.push(`alinhada às ${s.anchor}`);
  return p.join(' · ');
}

module.exports = { parseHM, agoraSP, normalizarSchedule, validarIntervalo, dentroDaJanela, atrasoAteProximo, descreverIntervalo, descreverSchedule, MIN_INTERVALO, MAX_INTERVALO };
