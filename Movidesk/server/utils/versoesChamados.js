'use strict';
// Versões lançadas × chamados (card do Painel Geral, visão Suporte Técnico): para cada versão lançada no período, o suporte vê se os chamados
// que estão entrando têm relação com ela. Sinais, por versão:
//   - antes × depois: chamados de Suporte Técnico do produto abertos nos N dias ANTES e nos N dias DEPOIS do lançamento (ritmo por dia);
//   - citam a versão ou a atualização: no assunto ou nas primeiras ações do cliente (só o que ele escreveu) aparece o número da versão ou frases como "após a atualização";
//   - marcados "após a atualização": campo Causa do Movidesk (148916) = "Situação Reportada Após a Atualização";
//   - RELACIONADOS (o que o gráfico mostra): chamados abertos DEPOIS do lançamento, dentro da janela, que têm ligação com ESTA versão — citam o número dela,
//     estão marcados "após a atualização" ou estão vinculados às tarefas que ela entregou (sem contar duas vezes o chamado que tem mais de um sinal);
//   - vinculados às tarefas da versão: chamados ligados (jiraIssueKey) às tarefas que a versão entregou — a demanda que ela atendeu.
// Versões vêm do versoes_data.json do extrator do Jira (mesma pasta da aba Jira); o produto vem de server/data/versoes-servico.json.
const fs = require('fs');
const path = require('path');
const db = require('../db/remote');

const JIRA_DATA_DIR = path.resolve(__dirname, '../../', process.env.JIRA_DATA_DIR || '../Jira');
const MAPA = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/versoes-servico.json'), 'utf8')); } catch { return {}; } })();
// O relacionamento chamado × versão olha só o que o CLIENTE escreveu: as 3 primeiras ações públicas dele (profile_type 2; sem e-mail
// da Viasoft quando o tipo vem vazio). Ações de agente, da IA e internas (análise, orientação, encaminhamento) não entram: elas
// citam versão/atualização por conta do próprio atendimento e não mostram o problema que o cliente relatou.
const TXT_CLIENTE = (col) => `SELECT lower(regexp_replace(string_agg(x.d, ' ' ORDER BY x.acao_id), '<[^>]+>', ' ', 'g')) FROM (
            SELECT a.acao_id, a.descricao AS d FROM silver.ticket_acao a
             WHERE a.ticket_id = ${col} AND a.tipo = 2 AND COALESCE(a.descricao, '') <> ''
               AND (a.criado_por_profile_type = 2 OR (a.criado_por_profile_type IS NULL AND COALESCE(a.criado_por_email, '') NOT ILIKE '%@viasoft.com.br'))
             ORDER BY a.acao_id LIMIT 3) x`;
const SEM_CHAVE = '§§sem-chave§§';
const CAUSA_APOS = 'Situação Reportada Após a Atualização';
const RX_CITA = '(ap(o|ó)s|depois).{0,25}(atualiz|vers(ao|ão))|nova vers(ao|ão)|atualizamos|atualizei|atualizou|vers(ao|ão) nova';

let _cacheVersoes = { chave: '', dados: null };
function lerVersoes() {
  const f = path.join(JIRA_DATA_DIR, 'versoes_data.json');
  let st; try { st = fs.statSync(f); } catch { return null; }
  const chave = `${st.mtimeMs}:${st.size}`;
  if (_cacheVersoes.chave === chave) return _cacheVersoes.dados;
  try { _cacheVersoes = { chave, dados: JSON.parse(fs.readFileSync(f, 'utf8')) }; return _cacheVersoes.dados; } catch { return null; }
}

// "4.0.2409.1052 - Lote 733" -> ['4.0.2409.1052', '4.0.2409']; "v.2026.10.13" -> ['2026.10.13']; textos sem número de versão -> []
function tokensDaVersao(nome) {
  const out = new Set();
  for (const m of String(nome || '').matchAll(/\d+(?:\.\d+){2,}/g)) {
    out.add(m[0]);
    const p = m[0].split('.');
    if (p.length > 3) out.add(p.slice(0, 3).join('.'));
  }
  return [...out].filter((t) => t.length >= 6);
}
const chavesDe = (v) => { const k = [...new Set((v.tarefas || []).map((t) => String(t.chave).toUpperCase()).filter(Boolean))]; return k.length ? k : [SEM_CHAVE]; };
const projetoPrincipal = (v) => {
  const c = {}; (v.tarefas || []).forEach((t) => { if (t.projeto) c[t.projeto] = (c[t.projeto] || 0) + 1; });
  const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : '';
};

// esc = escopo de vertical do perfil (utils/verticalScope.escopoVertical). Quem tem vertical só vê versões do próprio produto.
// Versões lançadas no mês/ano escolhidos (mes 0 = o ano todo). Os chamados relacionados são os abertos DEPOIS do lançamento, até hoje.
async function calcular({ esc, ano, mes, pertence }) {
  const dados = lerVersoes();
  const anoN = /^\d{4}$/.test(String(ano)) ? Number(ano) : new Date().getFullYear();
  const mesN = Number(mes) >= 1 && Number(mes) <= 12 ? Number(mes) : 0;
  if (!dados) return { versoes: [], aviso: 'O arquivo de versões do Jira ainda não foi gerado (versoes_data.json).', ano: anoN, mes: mesN };
  const hoje = new Date().toISOString().slice(0, 10);
  const ini = `${anoN}-${String(mesN || 1).padStart(2, '0')}-01`;
  const fim = new Date(Date.UTC(anoN, mesN || 12, 0)).toISOString().slice(0, 10);   // último dia do mês (ou do ano)
  let lista = (dados.versoes || []).filter((v) => v.released && v.release_date && v.release_date >= ini && v.release_date <= fim && v.release_date <= hoje)
    .sort((a, b) => b.release_date.localeCompare(a.release_date)).slice(0, 500);
  const base = lista.map((v) => {
    const proj = projetoPrincipal(v);
    const servicos = MAPA[proj] || null;
    return { v, proj, servicos, tokens: tokensDaVersao(v.nome) };
  });
  const noEscopo = (b) => !esc || !esc.filtrar || (b.servicos && b.servicos.some((s) => pertence(esc.verticais, { servico: s })));
  const visiveis = base.filter(noEscopo);

  // chamados vinculados às tarefas de cada versão: uma leitura só para todas
  const pares = [];   // [chave, índice da versão]
  visiveis.forEach((b, i) => { new Set((b.v.tarefas || []).map((t) => String(t.chave).toUpperCase())).forEach((k) => pares.push([k, i])); });
  const vinc = new Map();
  if (pares.length) {
    const cond = esc && esc.filtrar ? `AND btrim(split_part(COALESCE(t.service_full, ''), ' > ', 1)) = ANY($3::text[])` : '';
    const r = await db.query(`
      SELECT p.i, COUNT(*)::int AS vinculados, COUNT(*) FILTER (WHERE t.basestatus IN ('New','InAttendance','Stopped','InProgress'))::int AS abertos,
             COUNT(DISTINCT t.jiraissuekey)::int AS tarefas_com_chamado
        FROM unnest($1::text[], $2::int[]) AS p(k, i) JOIN silver.ticket t ON upper(t.jiraissuekey) = p.k
       WHERE t.jiraissuekey IS NOT NULL ${cond} GROUP BY p.i`, [pares.map((x) => x[0]), pares.map((x) => x[1]), ...(cond ? [esc.verticais] : [])]);
    r.rows.forEach((x) => vinc.set(x.i, x));
  }

  // Uma leitura por PRODUTO (desde o lançamento mais antigo dele): texto do cliente, causa e chave do Jira de cada chamado; as contagens de cada versão saem daqui
  const grupos = new Map();
  visiveis.forEach((b) => { if (!b.servicos) return; const k = b.servicos.join('|'); const g = grupos.get(k) || { servicos: b.servicos, min: b.v.release_date }; if (b.v.release_date < g.min) g.min = b.v.release_date; grupos.set(k, g); });
  for (const g of grupos.values()) {
    const r = await db.query(`
      SELECT t.createddate, upper(t.jiraissuekey) AS jk,
             lower(COALESCE(t.subject, '')) || ' ' || COALESCE((${TXT_CLIENTE('t.ticket_id')}), '') AS txt,
             (SELECT lower(c2.valor_texto) FROM silver.ticket_campo_customizado c2 WHERE c2.ticket_id = t.ticket_id AND c2.custom_field_id = 148916 LIMIT 1) AS causa
        FROM silver.ticket t JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = 23946 AND cf.valor_texto = 'Suporte Técnico'
       WHERE t.createddate >= $2::date AND btrim(split_part(COALESCE(t.service_full, ''), ' > ', 1)) = ANY($1::text[])`, [g.servicos, g.min]);
    g.tickets = r.rows.map((x) => ({ em: new Date(x.createddate).getTime(), jk: x.jk, txt: x.txt || '', causa: x.causa || '' }));
  }
  const rxCita = new RegExp(RX_CITA);
  const causaApos = CAUSA_APOS.toLowerCase();
  const out = [];
  for (let i = 0; i < visiveis.length; i++) {
    const { v, proj, servicos, tokens } = visiveis[i];
    const item = { id: String(v.id || v.nome), nome: v.nome, lancada: v.release_date, projeto: proj, servicos: servicos || [], tarefas: (v.tarefas || []).length,
      tiposTarefa: (v.tarefas || []).reduce((o, t) => { const k = /bug/i.test(t.tipo || '') ? 'bugs' : 'outras'; o[k] = (o[k] || 0) + 1; return o; }, { bugs: 0, outras: 0 }),
      tokens, vinculados: (vinc.get(i) || {}).vinculados || 0, vinculadosAbertos: (vinc.get(i) || {}).abertos || 0, tarefasComChamado: (vinc.get(i) || {}).tarefas_com_chamado || 0,
      diasDecorridos: Math.max(0, Math.floor((Date.now() - new Date(v.release_date + 'T00:00:00-03:00').getTime()) / 86400000)) };
    if (servicos) {
      const desdeMs = new Date(v.release_date + 'T00:00:00Z').getTime(), chaves = new Set(chavesDe(v));
      const c = { depois: 0, citaAtualizacao: 0, citaVersao: 0, causaApos: 0, vincDepois: 0, relacionados: 0 };
      for (const t of grupos.get(servicos.join('|')).tickets) {
        if (t.em < desdeMs) continue;
        c.depois++;
        const cita = tokens.some((k) => t.txt.includes(k)), apos = t.causa.startsWith(causaApos), vinc2 = chaves.has(t.jk);
        if (rxCita.test(t.txt)) c.citaAtualizacao++;
        if (cita) c.citaVersao++;
        if (apos) c.causaApos++;
        if (vinc2) c.vincDepois++;
        if (cita || apos || vinc2) c.relacionados++;
      }
      Object.assign(item, c);
    }
    out.push(item);
  }
  return { versoes: out, ano: anoN, mes: mesN, desde: ini, ate: fim, geradoEm: dados.gerado_em || null, semMapa: visiveis.filter((b) => !b.servicos).length };
}

// Chamados por trás de um número do card. tipo: depois | cita | citaversao | causa | vinculados. Devolve só os ids (a rota monta as linhas completas).
async function idsDoItem({ esc, versaoId, tipo, pertence }) {
  const dados = lerVersoes(); if (!dados) return [];
  const v = (dados.versoes || []).find((x) => String(x.id || x.nome) === String(versaoId)); if (!v) return [];
  const proj = projetoPrincipal(v), servicos = MAPA[proj] || null;
  if (esc && esc.filtrar && !(servicos && servicos.some((s) => pertence(esc.verticais, { servico: s })))) return [];
  if (tipo === 'vinculados') {
    const chaves = [...new Set((v.tarefas || []).map((t) => String(t.chave).toUpperCase()))];
    const cond = esc && esc.filtrar ? `AND btrim(split_part(COALESCE(service_full, ''), ' > ', 1)) = ANY($2::text[])` : '';
    return (await db.query(`SELECT ticket_id::text AS id FROM silver.ticket WHERE upper(jiraissuekey) = ANY($1::text[]) ${cond} ORDER BY createddate DESC LIMIT 500`, [chaves, ...(cond ? [esc.verticais] : [])])).rows.map((x) => x.id);
  }
  if (!servicos) return [];
  const filtro = { depois: 'TRUE', cita: 'txt ~ $3', citaversao: 'EXISTS (SELECT 1 FROM unnest($4::text[]) k WHERE position(k IN txt) > 0)', causa: 'causa LIKE lower($5) || \'%\'',
    relacionados: '(EXISTS (SELECT 1 FROM unnest($4::text[]) k WHERE position(k IN txt) > 0) OR causa LIKE lower($5) || \'%\' OR vinc)' }[tipo];
  if (!filtro) return [];
  const tokens = tokensDaVersao(v.nome);
  const r = await db.query(`
    WITH d AS (
      SELECT t.ticket_id, t.createddate,
             lower(COALESCE(t.subject, '')) || ' ' || COALESCE((${TXT_CLIENTE('t.ticket_id')}), '') AS txt,
             (SELECT lower(c2.valor_texto) FROM silver.ticket_campo_customizado c2 WHERE c2.ticket_id = t.ticket_id AND c2.custom_field_id = 148916 LIMIT 1) AS causa,
             (upper(t.jiraissuekey) = ANY($6::text[])) AS vinc
        FROM silver.ticket t JOIN silver.ticket_campo_customizado cf ON cf.ticket_id = t.ticket_id AND cf.custom_field_id = 23946 AND cf.valor_texto = 'Suporte Técnico'
       WHERE t.createddate >= $2::date
         AND btrim(split_part(COALESCE(t.service_full, ''), ' > ', 1)) = ANY($1::text[]))
    SELECT ticket_id::text AS id FROM d WHERE ${filtro} AND $3::text IS NOT NULL AND $4::text[] IS NOT NULL AND $5::text IS NOT NULL AND $6::text[] IS NOT NULL   -- cita todos os parâmetros: o Postgres exige que a consulta use todos
     ORDER BY createddate DESC LIMIT 500`,
  [servicos, v.release_date, RX_CITA, tokens.length ? tokens : ['§§sem-versao§§'], CAUSA_APOS, chavesDe(v)]);
  return r.rows.map((x) => x.id);
}

module.exports = { calcular, idsDoItem, tokensDaVersao };
