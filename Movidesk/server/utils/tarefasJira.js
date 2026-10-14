'use strict';
// Dados das tarefas do Jira (resumo, status, projeto, responsável…) para o card "Tarefas do Jira × chamados" do Painel Geral.
// A fonte são os mesmos JSON do extrator (pasta Jira, a mesma da aba Jira: routes/jira.js): dashboard_data.json (tarefas abertas, com responsável),
// abertos_data.json e fechados_data.json. Monta um índice chave → dados, guardado na memória e refeito só quando algum arquivo muda
// (o extrator roda de hora em hora). Nada daqui chama o Jira: só lê arquivos.
const fs = require('fs');
const path = require('path');

const JIRA_DATA_DIR = path.resolve(__dirname, '../../', process.env.JIRA_DATA_DIR || '../Jira');
const ARQUIVOS = ['dashboard_data.json', 'abertos_data.json', 'fechados_data.json'];
const FINAIS = /finaliz|conclu|resolv|fechad|cancel|reprov|done|closed/i;

let cache = { chave: '', itens: new Map(), geradoEm: null };
let carregando = null;

const assinatura = () => ARQUIVOS.map((f) => { try { const s = fs.statSync(path.join(JIRA_DATA_DIR, f)); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return `${f}:ausente`; } }).join('|');
const lerJson = (f) => new Promise((ok) => fs.readFile(path.join(JIRA_DATA_DIR, f), 'utf8', (err, raw) => {
  if (err) return ok(null);
  try { ok(JSON.parse(raw)); } catch { ok(null); }
}));

function registrar(mapa, x, aberta) {
  const chave = String(x && x.chave || '').trim().toUpperCase();
  if (!chave) return;
  const resp = x.responsavel || x.dev || x.at_tec || x.at || x.ar || null;
  const antigo = mapa.get(chave) || {};
  mapa.set(chave, {
    chave,
    resumo: x.summary || antigo.resumo || '',
    status: x.status || antigo.status || '',
    projeto: x.projeto || antigo.projeto || '',
    tipo: x.tipo || antigo.tipo || '',
    responsavel: resp || antigo.responsavel || null,
    criado: x.criado || antigo.criado || null,
    resolvido: x.resolvido || antigo.resolvido || null,
    prazo: x.prazo || antigo.prazo || null,
    finalizada: aberta ? false : (antigo.finalizada === false ? false : FINAIS.test(String(x.status || ''))),
  });
}

async function construir() {
  const [dash, ab, fe] = await Promise.all(ARQUIVOS.map(lerJson));
  const mapa = new Map();
  // ordem de menor para maior prioridade de "aberta": fechados, depois abertos do ano, por fim as tarefas abertas do dashboard (mais completas)
  ((fe && fe.itens) || []).forEach((x) => registrar(mapa, x, false));
  ((ab && ab.itens) || []).forEach((x) => registrar(mapa, x, false));
  ((dash && dash.tarefas_abertas) || []).forEach((x) => registrar(mapa, x, true));
  return { itens: mapa, geradoEm: (dash && dash.gerado_em) || null };
}

// Índice chave → dados. Refaz se algum arquivo mudou; pedidos simultâneos dividem a mesma leitura.
async function indice() {
  const ass = assinatura();
  if (cache.chave === ass && cache.itens.size) return cache;
  if (!carregando) carregando = construir().then((r) => { cache = { chave: ass, ...r }; return cache; }).finally(() => { carregando = null; });
  return carregando;
}

module.exports = { indice };
