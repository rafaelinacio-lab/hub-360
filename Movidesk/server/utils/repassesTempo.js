'use strict';
// Tempo de cada chamado com cada equipe e situação do SLA em cada repasse (card "Repasses entre equipes").
// Linha do tempo = criação → 1º repasse (equipe de origem do 1º repasse) → … → solução (ou agora, se ainda aberto).
// Tempo e SLA usam a régua do Hub: minutos úteis líquidos da política de SLA (janela de atendimento, sem fim de semana/feriado/pausa)
// contra a meta da urgência (slaRegraHub.META_H). Só chamados de Suporte Técnico (sem cliente excluído) têm meta; os demais só têm tempo.
const P = require('./slaPolitica');
const { metaDe } = require('./slaRegraHub');

// t: { id, criadoEm, urgencia, classificacao, foraCliente, fechadoEm|null }
// trs: repasses do chamado em ordem [{ de, para, em }]; eventos: [{ em, status }]; desde: início do histórico (Date|null)
function linhaDoTempo(t, trs, eventos, cfg, agora, desde) {
  if (!trs.length) return null;
  const criado = new Date(t.criadoEm).getTime();
  const fim = t.fechadoEm ? new Date(t.fechadoEm).getTime() : agora.getTime();
  const meta = String(t.classificacao || '').trim() === 'Suporte Técnico' && !t.foraCliente ? metaDe(t.urgencia) : null;
  const metaMin = meta == null ? null : meta * 60;
  const cortes = [criado, ...trs.map((x) => Math.min(Math.max(new Date(x.em).getTime(), criado), fim)), fim];
  const equipes = [trs[0].de, ...trs.map((x) => x.para)];
  const inicioEstimado = !!desde && criado < new Date(desde).getTime();
  const segs = [];
  let antes = 0;
  for (let i = 0; i < equipes.length; i++) {
    const min = P.minutosLiquidos(cortes[i], cortes[i + 1], eventos, cfg);
    const acum = antes + min;
    segs.push({
      equipe: equipes[i], de: cortes[i], ate: cortes[i + 1], min, acumMin: acum,
      jaVencidaAoReceber: metaMin != null && i > 0 ? antes > metaMin : null,      // chegou à equipe com a meta já estourada
      estourouAqui: metaMin != null ? antes <= metaMin && acum > metaMin : null,  // a meta estourou enquanto estava com esta equipe
      emAndamento: i === equipes.length - 1 && !t.fechadoEm,
      estimada: i === 0 && inicioEstimado,   // o 1º trecho de quem foi criado antes do histórico pode ter passado por outra equipe sem registro
    });
    antes = acum;
  }
  return {
    id: t.id, metaH: meta, totalMin: antes, aberto: !t.fechadoEm,
    sla: metaMin == null ? 'fora' : antes > metaMin ? 'vencido' : 'no_prazo',
    inicioEstimado,
    segs,
  };
}

// Por equipe (sobre as linhas do tempo): passagens, tempo médio e mediano, entradas já vencidas e estouros ocorridos com a equipe.
// Trechos estimados (1º trecho de chamado criado antes do histórico) não entram nas contas; só aparecem em `estimadas`.
function resumoPorEquipe(linhas) {
  const m = new Map();
  for (const l of linhas) for (const s of l.segs) {
    const o = m.get(s.equipe) || { equipe: s.equipe, passagens: 0, minutos: 0, lista: [], concluidas: 0, entradas: 0, entradasVencidas: 0, comMeta: 0, estouraram: 0, estimadas: 0 };
    m.set(s.equipe, o);
    if (s.estimada) { o.estimadas++; continue; }
    o.passagens++; o.minutos += s.min; o.lista.push(s.min);
    if (!s.emAndamento) o.concluidas++;
    if (s.estourouAqui != null) { o.comMeta++; if (s.estourouAqui) o.estouraram++; }
    if (s.jaVencidaAoReceber != null) { o.entradas++; if (s.jaVencidaAoReceber) o.entradasVencidas++; }
  }
  const h = (min) => Math.round(min / 6) / 10;
  const mediana = (v) => { if (!v.length) return 0; const x = [...v].sort((a, b) => a - b), k = x.length >> 1; return x.length % 2 ? x[k] : (x[k - 1] + x[k]) / 2; };
  return [...m.values()].map(({ lista, ...o }) => ({ ...o, horasMedias: o.passagens ? h(o.minutos / o.passagens) : 0, horasMediana: h(mediana(lista)) }))
    .filter((o) => o.passagens || o.estimadas).sort((a, b) => b.minutos - a.minutos);
}

module.exports = { linhaDoTempo, resumoPorEquipe };
