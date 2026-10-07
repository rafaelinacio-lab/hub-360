// Configurações → Avisos automáticos: mensagens disparadas quando chega chamado novo de um serviço configurado.
// Servidor: server/routes/avisos.js e server/utils/avisosAutomaticos.js (nasce desligado; regras novas nascem em simulação).
const AV = { dados: null, servicos: null, agentes: null, editando: null, historico: [] };
const avEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const avFmt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

async function avApi(caminho, metodo = 'GET', corpo) {
    const r = await fetch(`${API_BASE}/avisos${caminho}`, { method: metodo, headers: { ...authHeaders(), ...(corpo ? { 'Content-Type': 'application/json' } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
    return d;
}

async function avisosCarregar() {
    const root = document.getElementById('avRoot');
    if (!root || !isCurrentUserAdmin()) return;
    try {
        AV.dados = await avApi('');
        AV.historico = (await avApi('/historico')).itens;
        avRender();
    } catch (e) { root.innerHTML = `<p class="config-status error">${avEsc(e.message)}</p>`; }
}

function avRender() {
    const { estado, regras, resumo7d, variaveis } = AV.dados;
    const root = document.getElementById('avRoot');
    const r7 = (k) => resumo7d[k] || 0;
    root.innerHTML = `
      <div class="config-card">
        <h3 class="config-card-title">Avisos automáticos</h3>
        <p class="config-card-help">Quando chega um chamado novo no Movidesk de um serviço configurado abaixo, o Hub registra uma mensagem automática nele
          (resposta pública ou nota interna), em nome do agente escolhido na regra. Só vale para chamados criados <strong>depois</strong> que o módulo é ligado.
          Cada chamado recebe no máximo um aviso (vale a primeira regra ativa, na ordem da lista) e nunca repete.</p>
        <div class="config-form-stack">
          <label style="display:flex;gap:10px;align-items:center;font-weight:700"><input type="checkbox" id="avLigado" ${estado.ligado ? 'checked' : ''}> Módulo ligado</label>
          <label style="display:flex;gap:10px;align-items:center">Verificar chamados novos a cada
            <input type="number" id="avIntervalo" class="config-input" style="width:90px" min="30" max="600" value="${estado.intervaloSeg}"> segundos</label>
          <div><button class="config-btn" type="button" onclick="avSalvarGeral()">Salvar</button> <span id="avGeralStatus" class="config-status"></span></div>
          <p class="config-card-help" style="margin:0">Última verificação: ${avFmt(estado.ultimoCiclo)}${estado.ultimoErro ? ` · <span style="color:#c0392b">erro: ${avEsc(estado.ultimoErro)}</span>` : ''}
            · Últimos 7 dias: ${r7('enviado')} enviados, ${r7('simulado')} simulados, ${r7('erro')} com erro</p>
        </div>
      </div>
      <div class="config-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <h3 class="config-card-title" style="margin:0">Regras</h3>
          <button class="config-btn" type="button" onclick="avNovaRegra()">+ Nova regra</button>
        </div>
        <div id="avForm"></div>
        <div id="avRegras">${regras.length ? regras.map(avLinhaRegra).join('') : '<p class="config-card-help">Nenhuma regra criada ainda.</p>'}</div>
      </div>
      <div class="config-card">
        <h3 class="config-card-title">Histórico recente</h3>
        <div class="rolagem" style="max-height:420px;overflow:auto">
          <table class="pessoas-table"><thead><tr><th>Quando</th><th>Chamado</th><th>Serviço</th><th>Regra</th><th>Resultado</th></tr></thead>
          <tbody>${AV.historico.length ? AV.historico.map((h) => `<tr><td>${avFmt(h.criado_em)}</td><td>#${avEsc(h.ticket_id)}<br><small>${avEsc(h.assunto)}</small></td><td>${avEsc(h.servico)}</td><td>${avEsc(h.regra_nome)}</td>
            <td>${({ enviado: '✅ Enviado', simulado: '🧪 Simulado', erro: '❌ Erro', processando: '⏳ Processando' })[h.status] || h.status}${h.erro ? `<br><small>${avEsc(h.erro)}</small>` : ''}</td></tr>`).join('') : '<tr><td colspan="5" class="pessoas-loading">Nenhum aviso ainda.</td></tr>'}</tbody></table>
        </div>
      </div>`;
    root.dataset.vars = variaveis.join(',');
}

function avLinhaRegra(r) {
    const modo = r.modo === 'ativo' ? '<b style="color:#1a7f37">envia de verdade</b>' : '<b style="color:#b7791f">simulação</b>';
    return `<div class="config-card" style="margin:12px 0 0;padding:14px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
        <div><strong>${avEsc(r.nome)}</strong> ${r.ativo ? '' : '<span class="config-card-help">(desligada)</span>'}
          <p class="config-card-help" style="margin:4px 0">${r.servicos.map(avEsc).join(' · ')}</p>
          <p class="config-card-help" style="margin:0">${r.tipo_acao === 'publica' ? 'Resposta pública' : 'Nota interna'} · remetente: ${avEsc(r.agente_nome || 'não definido')} · ${modo}</p></div>
        <div style="display:flex;gap:8px"><button class="config-btn config-btn-muted" onclick="avEditar(${r.id})">Editar</button>
          <button class="config-btn config-btn-muted" onclick="avExcluir(${r.id})">Excluir</button></div>
      </div>
      <pre style="white-space:pre-wrap;margin:10px 0 0;font:inherit;opacity:.85">${avEsc(r.mensagem)}</pre></div>`;
}

async function avGarantirListas() {
    if (!AV.servicos) { try { AV.servicos = (await avApi('/servicos')).servicos; } catch { AV.servicos = []; } }
    if (!AV.agentes) { try { AV.agentes = (await avApi('/agentes')).agentes; } catch (e) { AV.agentes = []; AV.erroAgentes = e.message; } }
}

async function avNovaRegra() { AV.editando = { id: null, nome: '', ativo: false, modo: 'simulacao', servicos: [], tipo_acao: 'publica', mensagem: '{{saudacao}}! Recebemos o seu chamado #{{ticket}} e ele já está na fila de atendimento.', agente_id: '', agente_nome: '' }; await avFormulario(); }
async function avEditar(id) { AV.editando = JSON.parse(JSON.stringify(AV.dados.regras.find((r) => r.id === id))); await avFormulario(); }

async function avFormulario() {
    await avGarantirListas();
    const r = AV.editando, f = document.getElementById('avForm');
    f.innerHTML = `<div class="config-card" style="margin:12px 0;padding:16px;border:2px solid var(--brand,#ff8a2b)">
      <h4 class="config-card-title" style="font-size:15px">${r.id ? 'Editar regra' : 'Nova regra'}</h4>
      <div class="config-form-stack">
        <input id="avNome" class="config-input" maxlength="120" placeholder="Nome da regra (ex.: Agrotitan — boas-vindas)" value="${avEsc(r.nome)}">
        <div><strong>Serviços</strong> <span class="config-card-help">— escolher "Agronegócio" cobre tudo que está abaixo dele</span>
          <div id="avChips" style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0"></div>
          <input id="avServicoIn" class="config-input" list="avServicosLista" placeholder="Digite para buscar um serviço e tecle Enter">
          <datalist id="avServicosLista">${AV.servicos.map((s) => `<option value="${avEsc(s.servico)}">`).join('')}</datalist></div>
        <select id="avTipo" class="config-input"><option value="publica" ${r.tipo_acao === 'publica' ? 'selected' : ''}>Resposta pública (o cliente vê)</option><option value="interna" ${r.tipo_acao === 'interna' ? 'selected' : ''}>Nota interna (só a equipe vê)</option></select>
        <select id="avAgente" class="config-input"><option value="">— Agente remetente (obrigatório para enviar de verdade) —</option>
          ${AV.agentes.map((a) => `<option value="${avEsc(a.id)}" ${a.id === r.agente_id ? 'selected' : ''}>${avEsc(a.nome)}</option>`).join('')}</select>
        ${AV.erroAgentes ? `<p class="config-status error">${avEsc(AV.erroAgentes)}</p>` : ''}
        <textarea id="avMsg" class="config-input" rows="6" maxlength="5000" placeholder="Mensagem">${avEsc(r.mensagem)}</textarea>
        <p class="config-card-help" style="margin:0">Variáveis: ${AV.dados.variaveis.map((v) => `<code>{{${v}}}</code>`).join(' ')}</p>
        <div><button class="config-btn config-btn-muted" type="button" onclick="avPrevia()">Ver prévia</button> <span id="avPreviaTxt" class="config-card-help"></span></div>
        <select id="avModo" class="config-input"><option value="simulacao" ${r.modo !== 'ativo' ? 'selected' : ''}>Simulação — só registra no histórico, não escreve no Movidesk</option><option value="ativo" ${r.modo === 'ativo' ? 'selected' : ''}>Enviar de verdade para o Movidesk</option></select>
        <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="avAtivo" ${r.ativo ? 'checked' : ''}> Regra ativa</label>
        <div><button class="config-btn" type="button" onclick="avSalvarRegra()">Salvar regra</button> <button class="config-btn config-btn-muted" type="button" onclick="document.getElementById('avForm').innerHTML=''">Cancelar</button> <span id="avFormStatus" class="config-status"></span></div>
      </div></div>`;
    avChips();
    document.getElementById('avServicoIn').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return; e.preventDefault();
        const v = e.target.value.trim(); if (v && !AV.editando.servicos.includes(v)) AV.editando.servicos.push(v);
        e.target.value = ''; avChips();
    });
    f.scrollIntoView({ block: 'nearest' });
}
function avChips() {
    document.getElementById('avChips').innerHTML = AV.editando.servicos.map((s, i) => `<span style="background:var(--surface-mid,#eee);border-radius:999px;padding:4px 10px;font-size:12px">${avEsc(s)} <a href="#" onclick="AV.editando.servicos.splice(${i},1);avChips();return false" title="Remover">✕</a></span>`).join('') || '<span class="config-card-help">Nenhum serviço escolhido.</span>';
}
async function avPrevia() {
    try { const d = await avApi('/previa', 'POST', { mensagem: document.getElementById('avMsg').value, servico: AV.editando.servicos[0] }); document.getElementById('avPreviaTxt').textContent = d.texto; }
    catch (e) { document.getElementById('avPreviaTxt').textContent = e.message; }
}
async function avSalvarRegra() {
    const r = AV.editando, st = document.getElementById('avFormStatus');
    const sel = document.getElementById('avAgente');
    const corpo = { nome: document.getElementById('avNome').value, servicos: r.servicos, tipo_acao: document.getElementById('avTipo').value, mensagem: document.getElementById('avMsg').value,
        agente_id: sel.value, agente_nome: sel.value ? sel.options[sel.selectedIndex].text : '', modo: document.getElementById('avModo').value, ativo: document.getElementById('avAtivo').checked };
    if (corpo.modo === 'ativo' && corpo.ativo && !confirm('Esta regra vai escrever de verdade nos chamados novos do Movidesk (visível ao cliente se for resposta pública). Confirmar?')) return;
    try { await avApi(r.id ? `/regras/${r.id}` : '/regras', r.id ? 'PUT' : 'POST', corpo); await avisosCarregar(); }
    catch (e) { st.className = 'config-status error'; st.textContent = e.message; }
}
async function avExcluir(id) {
    if (!confirm('Excluir esta regra? O histórico dela continua guardado.')) return;
    try { await avApi(`/regras/${id}`, 'DELETE'); await avisosCarregar(); } catch (e) { alert(e.message); }
}
async function avSalvarGeral() {
    const st = document.getElementById('avGeralStatus');
    const ligado = document.getElementById('avLigado').checked;
    if (ligado && !AV.dados.estado.ligado && !confirm('Ligar os avisos automáticos? Só chamados criados a partir de agora serão considerados; regras em simulação não escrevem no Movidesk.')) return;
    try { await avApi('/geral', 'PUT', { ligado, intervaloSeg: Number(document.getElementById('avIntervalo').value) }); await avisosCarregar(); }
    catch (e) { st.className = 'config-status error'; st.textContent = e.message; }
}
