// Configurações → Automações: dispara a "Análise do cliente por IA" como NOTA INTERNA em chamados abertos do Movidesk,
// por webhook (o Movidesk avisa) ou por verificação agendada. Servidor: server/routes/automacoes.js e server/utils/automacoes.js
// (nasce desligado; automação nova nasce em simulação — faz a análise e guarda no histórico, sem escrever no Movidesk).
const AU = { dados: null, listas: null, agentes: null, editando: null, historico: [] };
const auEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const auFmt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const AU_STATUS = { New: 'Novo', InAttendance: 'Em atendimento', InProgress: 'Em andamento', Stopped: 'Parado' };
const AU_ROTULO = { enviado: '✅ Gravado', simulado: '🧪 Simulado', erro: '❌ Erro', processando: '⏳ Processando', ignorado: '⏭️ Ignorado' };

async function auApi(caminho, metodo = 'GET', corpo) {
    const r = await fetch(`${API_BASE}/automacoes${caminho}`, { method: metodo, headers: { ...authHeaders(), ...(corpo ? { 'Content-Type': 'application/json' } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
    return d;
}

async function automacoesCarregar() {
    const root = document.getElementById('auRoot');
    if (!root || !isCurrentUserAdmin()) return;
    try {
        AU.dados = await auApi('');
        AU.historico = (await auApi('/historico')).itens;
        auRender();
    } catch (e) { root.innerHTML = `<p class="config-status error">${auEsc(e.message)}</p>`; }
}

function auResumoCondicoes(c) {
    const p = [];
    p.push(`aberto${(c.status || []).length ? ` (${c.status.map((s) => AU_STATUS[s] || s).join(', ')})` : ''}`);
    if ((c.equipes || []).length) p.push(`equipe: ${c.equipes.map(auEsc).join(', ')}`);
    if ((c.servicos || []).length) p.push(`serviço: ${c.servicos.map(auEsc).join(', ')}`);
    if ((c.classificacoes || []).length) p.push(`classificação: ${c.classificacoes.map(auEsc).join(', ')}`);
    if ((c.urgencias || []).length) p.push(`urgência: ${c.urgencias.map(auEsc).join(', ')}`);
    p.push(`criado nos últimos ${c.criadoUltimosDias || 3} dia(s)`);
    if (c.abertoHaMinHoras) p.push(`aberto há pelo menos ${c.abertoHaMinHoras} h`);
    return p.join(' · ');
}

function auRender() {
    const { estado, regras, resumo7d, iaConfigurada } = AU.dados;
    const r7 = (k) => resumo7d[k] || 0;
    document.getElementById('auRoot').innerHTML = `
      <div class="config-card">
        <h3 class="config-card-title">Automações</h3>
        <p class="config-card-help">Faz o Hub agir sozinho em chamados <strong>abertos</strong> do Movidesk. Hoje a ação disponível é a <strong>análise do cliente por IA</strong>
          (sentimento, urgência, risco de churn, sinais e recomendações), registrada como <strong>nota interna</strong> no chamado, em nome do agente escolhido (o cliente não vê).
          O gatilho pode ser um <strong>webhook</strong> (o Movidesk avisa quando chega chamado) ou uma <strong>verificação agendada</strong> dos chamados em aberto conforme as condições.
          Cada automação age <strong>no máximo uma vez por chamado</strong>. Automação nova nasce em <em>simulação</em>: faz a análise e guarda no histórico, sem escrever no Movidesk.</p>
        <div class="config-form-stack">
          <label style="display:flex;gap:10px;align-items:center;font-weight:700"><input type="checkbox" id="auLigado" ${estado.ligado ? 'checked' : ''} onchange="auSalvarGeral()"> Módulo ligado</label>
          ${iaConfigurada ? '' : '<p class="config-status error" style="margin:0">A chave da OpenAI não está configurada (Configurações → Inteligência Artificial): nada será analisado.</p>'}
          <p class="config-card-help" style="margin:0">Última verificação agendada: ${auFmt(estado.ultimoCiclo)}${estado.ultimoErro ? ` · <span style="color:#c0392b">erro: ${auEsc(estado.ultimoErro)}</span>` : ''}
            · Últimos 7 dias: ${r7('enviado')} gravadas, ${r7('simulado')} simuladas, ${r7('erro')} com erro, ${r7('ignorado')} ignoradas</p>
          <span id="auGeralStatus" class="config-status"></span>
        </div>
      </div>
      <div class="config-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <h3 class="config-card-title" style="margin:0">Regras</h3>
          <button class="config-btn" type="button" onclick="auNova()">+ Nova automação</button>
        </div>
        <div id="auForm"></div>
        <div>${regras.length ? regras.map(auLinha).join('') : '<p class="config-card-help">Nenhuma automação criada ainda.</p>'}</div>
      </div>
      <div class="config-card">
        <h3 class="config-card-title">Histórico recente</h3>
        <div class="rolagem" style="max-height:420px;overflow:auto">
          <table class="pessoas-table"><thead><tr><th>Quando</th><th>Chamado</th><th>Automação</th><th>Origem</th><th>Resultado</th></tr></thead>
          <tbody>${AU.historico.length ? AU.historico.map((h) => `<tr><td>${auFmt(h.criado_em)}</td><td>#${auEsc(h.ticket_id)}<br><small>${auEsc(h.assunto)}</small></td><td>${auEsc(h.automacao_nome)}</td><td>${auEsc(h.origem)}</td>
            <td>${AU_ROTULO[h.status] || auEsc(h.status)}${h.modo === 'simulacao' && h.status !== 'ignorado' ? ' <small>(simulação)</small>' : ''}${h.erro ? `<br><small>${auEsc(h.erro)}</small>` : ''}
              ${h.texto ? `<br><a href="#" onclick="auVerTexto(${h.id});return false">ver nota</a>` : ''}</td></tr>`).join('') : '<tr><td colspan="5" class="pessoas-empty">Nada ainda.</td></tr>'}</tbody></table>
        </div>
        <div id="auTextoHist"></div>
      </div>`;
}

function auLinha(r) {
    const modo = r.modo === 'ativo' ? '<b style="color:#1a7f37">grava de verdade</b>' : '<b style="color:#b7791f">simulação</b>';
    const gat = r.gatilho === 'webhook'
        ? `Webhook <code style="user-select:all;word-break:break-all">${auEsc(r.webhookUrl || '')}</code>`
        : `Verifica a cada ${r.intervalo_min} min (até ${r.max_por_ciclo} chamados por vez)${r.ultimo_ciclo ? ` · última: ${auFmt(r.ultimo_ciclo)}${r.ultimo_resumo ? ` (${r.ultimo_resumo.candidatos} candidatos, ${r.ultimo_resumo.processados} processados)` : ''}` : ''}`;
    return `<div class="config-card" style="margin:12px 0 0;padding:14px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
        <div style="min-width:0;flex:1"><strong>${auEsc(r.nome)}</strong> ${r.ativo ? '' : '<span class="config-card-help">(desligada)</span>'}
          <p class="config-card-help" style="margin:4px 0">${AU.dados.acoes[r.acao] || r.acao} · autor da nota: ${auEsc(r.agente_nome || 'não definido')} · ${modo}</p>
          <p class="config-card-help" style="margin:0">Quando: ${auResumoCondicoes(r.condicoes)}</p>
          <p class="config-card-help" style="margin:4px 0 0">${gat}</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="config-btn config-btn-muted" onclick="auEditar(${r.id})">Editar</button>
          <button class="config-btn config-btn-muted" onclick="auTestar(${r.id})">Testar em um chamado</button>
          <button class="config-btn config-btn-muted" onclick="auExcluir(${r.id})">Excluir</button></div>
      </div><div id="auTeste${r.id}"></div></div>`;
}

async function auGarantirListas() {
    if (!AU.listas) {
        const pega = async (c, k) => { try { return (await auApi(c))[k]; } catch { return []; } };
        const [servicos, classificacoes, equipes, urgencias] = await Promise.all([pega('/servicos', 'servicos'), pega('/classificacoes', 'classificacoes'), pega('/equipes', 'equipes'), pega('/urgencias', 'urgencias')]);
        AU.listas = { servicos: servicos.map((s) => s.servico), classificacoes, equipes, urgencias };
    }
    if (!AU.agentes) { try { AU.agentes = (await auApi('/agentes')).agentes; } catch (e) { AU.agentes = []; AU.erroAgentes = e.message; } }
}

async function auNova() {
    AU.editando = { id: null, nome: '', ativo: false, modo: 'simulacao', gatilho: 'webhook', intervalo_min: 15, acao: 'analise_cliente', agente_id: '', max_por_ciclo: 10, condicoes: JSON.parse(JSON.stringify(AU.dados.condicoesPadrao)) };
    await auFormulario();
}
async function auEditar(id) { AU.editando = JSON.parse(JSON.stringify(AU.dados.regras.find((r) => r.id === id))); await auFormulario(); }

// Campo de lista com chips: digita, Enter adiciona; sugestões vêm do banco.
const AU_CAMPOS = [
    ['equipes', 'Equipe responsável', 'Digite para buscar uma equipe e tecle Enter', 'equipes'],
    ['servicos', 'Serviço', 'Escolher "Agronegócio" cobre tudo que está abaixo dele', 'servicos'],
    ['classificacoes', 'Classificação do ticket', 'Digite para buscar uma classificação e tecle Enter', 'classificacoes'],
    ['urgencias', 'Urgência', 'Digite para buscar uma urgência e tecle Enter', 'urgencias'],
];
function auChips(chave) {
    const el = document.getElementById(`auChips_${chave}`); if (!el) return;
    el.innerHTML = AU.editando.condicoes[chave].map((s, i) => `<span style="background:var(--surface-mid,#eee);border-radius:999px;padding:4px 10px;font-size:12px">${auEsc(s)} <a href="#" onclick="AU.editando.condicoes['${chave}'].splice(${i},1);auChips('${chave}');return false" style="text-decoration:none">✕</a></span>`).join('');
}
async function auFormulario() {
    await auGarantirListas();
    const r = AU.editando, c = r.condicoes, f = document.getElementById('auForm');
    f.innerHTML = `<div class="config-card" style="margin:12px 0;padding:16px;border:2px solid var(--brand,#ff8a2b)">
      <h4 class="config-card-title" style="font-size:15px">${r.id ? 'Editar automação' : 'Nova automação'}</h4>
      <div class="config-form-stack">
        <input id="auNome" class="config-input" maxlength="120" placeholder="Nome (ex.: Análise do cliente — chamados novos do Suporte)" value="${auEsc(r.nome)}">
        <div><strong>Ação</strong>
          <select id="auAcao" class="config-input">${Object.entries(AU.dados.acoes).map(([k, v]) => `<option value="${k}" ${k === r.acao ? 'selected' : ''}>${auEsc(v)}</option>`).join('')}</select></div>
        <div><strong>Gatilho</strong>
          <select id="auGatilho" class="config-input" onchange="auGatilhoMudou()">
            <option value="webhook" ${r.gatilho === 'webhook' ? 'selected' : ''}>Webhook — o Movidesk avisa quando chega um chamado</option>
            <option value="agendado" ${r.gatilho === 'agendado' ? 'selected' : ''}>Agendado — o Hub olha os chamados em aberto de tempos em tempos</option></select>
          <p class="config-card-help" id="auGatDica" style="margin:6px 0 0"></p>
          <div id="auAgendadoCampos" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
            <label>Verificar a cada <input type="number" id="auIntervalo" class="config-input" style="width:90px" min="5" max="1440" value="${r.intervalo_min}"> min</label>
            <label>No máximo <input type="number" id="auMax" class="config-input" style="width:80px" min="1" max="50" value="${r.max_por_ciclo}"> chamados por verificação</label>
            <label>Só se aberto há pelo menos <input type="number" id="auMinH" class="config-input" style="width:80px" min="0" max="720" value="${c.abertoHaMinHoras || 0}"> h</label></div></div>
        <div><strong>Condições</strong> <span class="config-card-help">— só chamados <b>abertos</b> são considerados; campo em branco vale para qualquer valor</span>
          <div style="margin:6px 0"><span class="config-card-help">Status:</span>
            ${Object.entries(AU_STATUS).map(([k, v]) => `<label style="margin-right:12px"><input type="checkbox" class="auSt" value="${k}" ${(c.status || []).includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div>
          ${AU_CAMPOS.map(([k, rot, dica]) => `<div style="margin:8px 0"><span class="config-card-help"><b>${rot}</b> — ${dica}</span>
            <div id="auChips_${k}" style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0"></div>
            <input id="auIn_${k}" class="config-input" list="auLista_${k}" placeholder="Digitar e Enter" autocomplete="off">
            <datalist id="auLista_${k}">${(AU.listas[k] || []).map((x) => `<option value="${auEsc(x)}">`).join('')}</datalist></div>`).join('')}
          <label>Somente chamados criados nos últimos <input type="number" id="auDias" class="config-input" style="width:80px" min="1" max="30" value="${c.criadoUltimosDias || 3}"> dia(s)
            <span class="config-card-help">(proteção: a automação não mexe em chamado antigo)</span></label></div>
        <div><button class="config-btn config-btn-muted" type="button" onclick="auPrevia()">Ver quantos chamados atendem agora</button> <div id="auPreviaTxt" class="config-card-help" style="margin-top:6px"></div></div>
        <select id="auAgente" class="config-input"><option value="">— Agente autor da nota (obrigatório para gravar de verdade) —</option>
          ${AU.agentes.map((a) => `<option value="${auEsc(a.id)}" ${a.id === r.agente_id ? 'selected' : ''}>${auEsc(a.nome)}</option>`).join('')}</select>
        ${AU.erroAgentes ? `<p class="config-status error">${auEsc(AU.erroAgentes)}</p>` : ''}
        <select id="auModo" class="config-input"><option value="simulacao" ${r.modo !== 'ativo' ? 'selected' : ''}>Simulação — faz a análise e guarda no histórico, não escreve no Movidesk</option>
          <option value="ativo" ${r.modo === 'ativo' ? 'selected' : ''}>Gravar de verdade — nota interna no chamado</option></select>
        <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="auAtivo" ${r.ativo ? 'checked' : ''}> Automação ativa</label>
        <div><button class="config-btn" type="button" onclick="auSalvar()">Salvar automação</button> <button class="config-btn config-btn-muted" type="button" onclick="document.getElementById('auForm').innerHTML=''">Cancelar</button> <span id="auFormStatus" class="config-status"></span></div>
      </div></div>`;
    for (const [k] of AU_CAMPOS) {
        auChips(k);
        document.getElementById(`auIn_${k}`).addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return; e.preventDefault();
            const v = e.target.value.trim(); if (v && !AU.editando.condicoes[k].includes(v)) AU.editando.condicoes[k].push(v);
            e.target.value = ''; auChips(k);
        });
    }
    auGatilhoMudou();
    f.scrollIntoView({ block: 'nearest' });
}
function auGatilhoMudou() {
    const ag = document.getElementById('auGatilho').value === 'agendado';
    document.getElementById('auAgendadoCampos').style.display = ag ? 'flex' : 'none';
    document.getElementById('auGatDica').innerHTML = ag
        ? 'O Hub consulta o banco (atualizado pela carga a cada 15 min) e age nos chamados abertos que atendem às condições e ainda não foram tratados por esta automação.'
        : 'Ao salvar, o Hub gera um endereço secreto (aparece na lista abaixo). No Movidesk, crie um gatilho/automação de “chamado novo” que faça uma requisição <b>POST</b> nesse endereço com o número do chamado (campo <code>id</code> no JSON, ou <code>?id=</code> na URL). O Hub responde na hora e processa em fila.';
}
// Texto digitado nos campos de lista e não confirmado com Enter também conta (antes era descartado em silêncio).
function auAbsorverPendentes() {
    for (const [k] of AU_CAMPOS) {
        const inp = document.getElementById(`auIn_${k}`), v = inp && inp.value.trim();
        if (v && !AU.editando.condicoes[k].includes(v)) AU.editando.condicoes[k].push(v);
        if (inp) inp.value = '';
        auChips(k);
    }
}
function auCondicoesDoForm() {
    auAbsorverPendentes();
    return { ...AU.editando.condicoes, status: [...document.querySelectorAll('.auSt:checked')].map((x) => x.value), criadoUltimosDias: Number(document.getElementById('auDias').value), abertoHaMinHoras: Number(document.getElementById('auMinH').value) };
}
async function auPrevia() {
    const alvo = document.getElementById('auPreviaTxt');
    alvo.textContent = 'Calculando…';
    try {
        const d = await auApi('/previa', 'POST', { condicoes: auCondicoesDoForm(), id: AU.editando.id, gatilho: document.getElementById('auGatilho').value });
        alvo.innerHTML = `<b>${d.casam}</b> chamado(s) aberto(s) atendem a estas condições agora (de ${d.janela} abertos na janela de dias).` + (d.exemplos.length ? '<br>' + d.exemplos.map((e) => `#${auEsc(e.id)} — ${auEsc(e.equipe || 'sem equipe')} — ${auEsc((e.assunto || '').slice(0, 70))}`).join('<br>') : '');
        return d;
    } catch (e) { alvo.textContent = e.message; return null; }
}
async function auSalvar() {
    const r = AU.editando, st = document.getElementById('auFormStatus');
    const sel = document.getElementById('auAgente');
    const corpo = {
        nome: document.getElementById('auNome').value, acao: document.getElementById('auAcao').value, gatilho: document.getElementById('auGatilho').value,
        intervalo_min: Number(document.getElementById('auIntervalo').value), max_por_ciclo: Number(document.getElementById('auMax').value),
        condicoes: auCondicoesDoForm(),
        agente_id: sel.value, agente_nome: sel.value ? sel.options[sel.selectedIndex].text : '', modo: document.getElementById('auModo').value, ativo: document.getElementById('auAtivo').checked,
    };
    if (corpo.modo === 'ativo' && corpo.ativo) {
        const d = await auPrevia();
        if (!d || !confirm(`Esta automação vai gravar notas internas de verdade em até ${d.casam} chamado(s) abertos que atendem às condições agora (e nos próximos que chegarem), ${corpo.gatilho === 'agendado' ? `no máximo ${corpo.max_por_ciclo} a cada ${corpo.intervalo_min} min` : 'via webhook'}. Confirmar?`)) return;
    }
    try { await auApi(r.id ? `/regras/${r.id}` : '/regras', r.id ? 'PUT' : 'POST', corpo); await automacoesCarregar(); }
    catch (e) { st.className = 'config-status error'; st.textContent = e.message; }
}
async function auExcluir(id) {
    if (!confirm('Excluir esta automação? O histórico dela continua guardado.')) return;
    try { await auApi(`/regras/${id}`, 'DELETE'); await automacoesCarregar(); } catch (e) { alert(e.message); }
}
async function auSalvarGeral() {
    const st = document.getElementById('auGeralStatus'), box = document.getElementById('auLigado');
    if (box.checked && !AU.dados.estado.ligado && !confirm('Ligar as automações? As regras ativas passam a rodar (as que estão em simulação não escrevem no Movidesk).')) { box.checked = false; return; }
    try { await auApi('/geral', 'PUT', { ligado: box.checked }); await automacoesCarregar(); }
    catch (e) { st.className = 'config-status error'; st.textContent = e.message; }
}

// Testar: roda a análise num chamado e mostra a nota que seria gravada — não grava nada, nem no histórico.
async function auTestar(id) {
    const alvo = document.getElementById(`auTeste${id}`);
    const n = prompt('Número do chamado para testar (nada será gravado no Movidesk):');
    if (!n) return;
    alvo.innerHTML = '<p class="config-card-help">Analisando…</p>';
    try {
        const d = await auApi(`/regras/${id}/testar`, 'POST', { ticket: Number(n) });
        alvo.innerHTML = `<div style="margin-top:10px;padding:12px;border:1px dashed var(--border,#ccc);border-radius:12px">
          <p class="config-card-help" style="margin:0 0 6px"><b>#${auEsc(n)}</b> ${auEsc(d.assunto)} — ${d.casa ? '✅ atende às condições' : `⚠️ não atende às condições: ${auEsc(d.motivo)}`}</p>
          <pre style="white-space:pre-wrap;margin:0;font:inherit">${auEsc(d.texto).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')}</pre></div>`;
    } catch (e) { alvo.innerHTML = `<p class="config-status error">${auEsc(e.message)}</p>`; }
}
function auVerTexto(id) {
    const h = AU.historico.find((x) => x.id === id); if (!h) return;
    document.getElementById('auTextoHist').innerHTML = `<div style="margin-top:10px;padding:12px;border:1px dashed var(--border,#ccc);border-radius:12px">
      <p class="config-card-help" style="margin:0 0 6px"><b>#${auEsc(h.ticket_id)}</b> — nota ${h.status === 'enviado' ? 'gravada' : 'simulada'}</p>
      <pre style="white-space:pre-wrap;margin:0;font:inherit">${auEsc(h.texto).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')}</pre></div>`;
}
