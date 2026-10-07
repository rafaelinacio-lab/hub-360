// Configurações → Avisos automáticos: mensagens disparadas quando chega chamado novo de um serviço configurado.
// Servidor: server/routes/avisos.js e server/utils/avisosAutomaticos.js (nasce desligado; regras novas nascem em simulação).
const AV = { dados: null, classes: null, servicos: null, agentes: null, editando: null, historico: [] };
const avEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const avLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
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
          <label style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">Endereço público do Hub (para as imagens abrirem para o cliente)
            <input type="text" id="avUrlPublica" class="config-input" style="min-width:280px;flex:1" placeholder="https://hub.suaempresa.com.br (HTTPS, acessível sem VPN)" value="${avEsc(estado.urlPublica || '')}"></label>
          <div><button class="config-btn" type="button" onclick="avSalvarGeral()">Salvar</button> <span id="avGeralStatus" class="config-status"></span></div>
          <div><button class="config-btn config-btn-muted" type="button" onclick="avVerificarAgora()">Verificar agora</button></div>
          <p class="config-card-help" style="margin:0">${avDiagnostico(estado)}</p>
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

function avVigenciaTxt(r) {
    if (!r.vigencia_inicio && !r.vigencia_fim) return 'sem prazo (vale sempre)';
    const agora = Date.now();
    const estado = r.vigencia_fim && agora > new Date(r.vigencia_fim) ? ' — <b style="color:#c0392b">encerrada</b>' : r.vigencia_inicio && agora < new Date(r.vigencia_inicio) ? ' — <b style="color:#b7791f">ainda não começou</b>' : ' — <b style="color:#1a7f37">vigente</b>';
    return `${r.vigencia_inicio ? 'de ' + avFmt(r.vigencia_inicio) : 'desde já'} ${r.vigencia_fim ? 'até ' + avFmt(r.vigencia_fim) : 'sem data final'}${estado}`;
}
function avLinhaRegra(r) {
    const modo = r.modo === 'ativo' ? '<b style="color:#1a7f37">envia de verdade</b>' : '<b style="color:#b7791f">simulação</b>';
    return `<div class="config-card" style="margin:12px 0 0;padding:14px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
        <div><strong>${avEsc(r.nome)}</strong> ${r.ativo ? '' : '<span class="config-card-help">(desligada)</span>'}
          <p class="config-card-help" style="margin:4px 0">${r.servicos.map(avEsc).join(' · ')}${(r.classificacoes || []).length ? ` · <b>Classificação:</b> ${r.classificacoes.map(avEsc).join(', ')}` : ''}</p>
          <p class="config-card-help" style="margin:0">${r.tipo_acao === 'publica' ? 'Resposta pública' : 'Nota interna'} · remetente: ${avEsc(r.agente_nome || 'não definido')} · ${modo}</p>
          <p class="config-card-help" style="margin:0">Prazo: ${avVigenciaTxt(r)}</p></div>
        <div style="display:flex;gap:8px"><button class="config-btn config-btn-muted" onclick="avEditar(${r.id})">Editar</button>
          <button class="config-btn config-btn-muted" onclick="avExcluir(${r.id})">Excluir</button></div>
      </div>
      <pre style="white-space:pre-wrap;margin:10px 0 0;font:inherit;opacity:.85">${avEsc(r.mensagem)}</pre></div>`;
}

async function avGarantirListas() {
    if (!AV.classes) { try { AV.classes = (await avApi('/classificacoes')).classificacoes; } catch { AV.classes = []; } }
    if (!AV.servicos) { try { AV.servicos = (await avApi('/servicos')).servicos; } catch { AV.servicos = []; } }
    if (!AV.agentes) { try { AV.agentes = (await avApi('/agentes')).agentes; } catch (e) { AV.agentes = []; AV.erroAgentes = e.message; } }
}

async function avNovaRegra() { AV.editando = { id: null, nome: '', ativo: false, modo: 'simulacao', servicos: [], classificacoes: [], tipo_acao: 'publica', mensagem: '{{saudacao}}! Recebemos o seu chamado #{{ticket}} e ele já está na fila de atendimento.', agente_id: '', agente_nome: '' }; await avFormulario(); }
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
        <div><strong>Classificação do ticket</strong> <span class="config-card-help">— opcional; sem nenhuma escolhida vale para qualquer classificação</span>
          <div id="avChipsC" style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0"></div>
          <input id="avClasseIn" class="config-input" list="avClassesLista" placeholder="Digite para buscar uma classificação e tecle Enter">
          <datalist id="avClassesLista">${AV.classes.map((c) => `<option value="${avEsc(c)}">`).join('')}</datalist></div>
        <select id="avTipo" class="config-input"><option value="publica" ${r.tipo_acao === 'publica' ? 'selected' : ''}>Resposta pública (o cliente vê)</option><option value="interna" ${r.tipo_acao === 'interna' ? 'selected' : ''}>Nota interna (só a equipe vê)</option></select>
        <select id="avAgente" class="config-input"><option value="">— Agente remetente (obrigatório para enviar de verdade) —</option>
          ${AV.agentes.map((a) => `<option value="${avEsc(a.id)}" ${a.id === r.agente_id ? 'selected' : ''}>${avEsc(a.nome)}</option>`).join('')}</select>
        ${AV.erroAgentes ? `<p class="config-status error">${avEsc(AV.erroAgentes)}</p>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="config-btn config-btn-muted" onclick="avInserir('negrito')" title="Negrito"><b>N</b></button>
          <button type="button" class="config-btn config-btn-muted" onclick="avInserir('link')" title="Inserir link">🔗 Link</button>
          <button type="button" class="config-btn config-btn-muted" onclick="document.getElementById('avArq').click()" title="Enviar uma imagem do seu computador (também dá para colar ou arrastar na caixa)">🖼️ Enviar imagem</button>
          <button type="button" class="config-btn config-btn-muted" onclick="avInserir('imagem')" title="Usar uma imagem que já está na internet">🔗 Imagem por endereço</button>
          <input type="file" id="avArq" accept="image/png,image/jpeg,image/gif,image/webp" hidden onchange="avEnviarArquivo(this.files[0]);this.value=''"> <span id="avImgStatus" class="config-card-help"></span></div>
        <textarea id="avMsg" class="config-input" rows="6" maxlength="5000" placeholder="Mensagem">${avEsc(r.mensagem)}</textarea>
        <p class="config-card-help" style="margin:0">Variáveis: ${AV.dados.variaveis.map((v) => `<code>{{${v}}}</code>`).join(' ')}<br>Formatação: <code>**negrito**</code> · <code>[texto](https://link)</code> · <code>![descrição](https://endereço-da-imagem.png)</code>.<br>Imagem: use <b>Enviar imagem</b>, ou cole (Ctrl+V) / arraste uma imagem na caixa. O cliente precisa conseguir abrir o endereço do Hub (HTTPS, sem login nem VPN — veja "Endereço público do Hub" no topo).</p>
        <div><button class="config-btn config-btn-muted" type="button" onclick="avPrevia()">Ver prévia</button> <div id="avPreviaTxt" class="config-card-help" style="margin-top:8px"></div></div>
        <select id="avModo" class="config-input"><option value="simulacao" ${r.modo !== 'ativo' ? 'selected' : ''}>Simulação — só registra no histórico, não escreve no Movidesk</option><option value="ativo" ${r.modo === 'ativo' ? 'selected' : ''}>Enviar de verdade para o Movidesk</option></select>
        <div><strong>Por quanto tempo o aviso fica no ar</strong> <span class="config-card-help">— vale para chamados criados dentro do período; deixe em branco para não ter prazo</span>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
            <label>Início <input type="datetime-local" id="avIni" class="config-input" value="${avLocal(r.vigencia_inicio)}"></label>
            <label>Fim <input type="datetime-local" id="avFim" class="config-input" value="${avLocal(r.vigencia_fim)}"></label></div></div>
        <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="avAtivo" ${r.ativo ? 'checked' : ''}> Regra ativa</label>
        <div><button class="config-btn" type="button" onclick="avSalvarRegra()">Salvar regra</button> <button class="config-btn config-btn-muted" type="button" onclick="document.getElementById('avForm').innerHTML=''">Cancelar</button> <span id="avFormStatus" class="config-status"></span></div>
      </div></div>`;
    avChips(); avChipsC();
    const ta = document.getElementById('avMsg');
    ta.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); avEnviarArquivo(f); } });
    ta.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) e.preventDefault(); });
    ta.addEventListener('drop', (e) => { const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); avEnviarArquivo(f); } });
    document.getElementById('avClasseIn').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return; e.preventDefault();
        const v = e.target.value.trim(); if (v && !AV.editando.classificacoes.includes(v)) AV.editando.classificacoes.push(v);
        e.target.value = ''; avChipsC();
    });
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
function avChipsC() {
    document.getElementById('avChipsC').innerHTML = AV.editando.classificacoes.map((s, i) => `<span style="background:var(--surface-mid,#eee);border-radius:999px;padding:4px 10px;font-size:12px">${avEsc(s)} <a href="#" onclick="AV.editando.classificacoes.splice(${i},1);avChipsC();return false" title="Remover">✕</a></span>`).join('') || '<span class="config-card-help">Qualquer classificação.</span>';
}
async function avPrevia() {
    const alvo = document.getElementById('avPreviaTxt');
    try {
        const d = await avApi('/previa', 'POST', { mensagem: document.getElementById('avMsg').value, servico: AV.editando.servicos[0] });
        // o HTML vem do servidor já escapado, só com <p>, <br>, <b>, <a> e <img> http(s); mesmo assim vai num iframe sem scripts
        alvo.innerHTML = '<iframe sandbox="" style="width:100%;height:240px;border:1px solid var(--border,#ccc);border-radius:12px;background:#fff"></iframe>';
        alvo.firstChild.srcdoc = `<body style="font:14px sans-serif;color:#222;margin:12px">${d.html}</body>`;
    } catch (e) { alvo.textContent = e.message; }
}
async function avSalvarRegra() {
    const r = AV.editando, st = document.getElementById('avFormStatus');
    const sel = document.getElementById('avAgente');
    const corpo = { nome: document.getElementById('avNome').value, servicos: r.servicos, classificacoes: r.classificacoes || [], tipo_acao: document.getElementById('avTipo').value, mensagem: document.getElementById('avMsg').value,
        agente_id: sel.value, agente_nome: sel.value ? sel.options[sel.selectedIndex].text : '', modo: document.getElementById('avModo').value,
        vigencia_inicio: document.getElementById('avIni').value ? new Date(document.getElementById('avIni').value).toISOString() : null,
        vigencia_fim: document.getElementById('avFim').value ? new Date(document.getElementById('avFim').value).toISOString() : null, ativo: document.getElementById('avAtivo').checked };
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
    try { await avApi('/geral', 'PUT', { ligado, intervaloSeg: Number(document.getElementById('avIntervalo').value), urlPublica: document.getElementById('avUrlPublica').value }); await avisosCarregar(); }
    catch (e) { st.className = 'config-status error'; st.textContent = e.message; }
}

function avDiagnostico(e) {
    const r = e.resumoCiclo;
    if (!e.ligado) return '<strong>Módulo desligado</strong> — marque "Módulo ligado" e salve.';
    if (!r) return 'Aguardando a primeira verificação…';
    if (!r.regrasAtivas) return '<strong>Nenhuma regra ativa.</strong> Edite a regra e marque "Regra ativa" — regra desligada não dispara.';
    const cl = r.outraClassificacao ? ` ${r.outraClassificacao} chamado(s) do serviço com outra classificação (${(r.classificacoesVistas || []).map(avEsc).join('; ')}).` : '';
    const sem = r.servicosSemRegra?.length ? ` Serviços sem regra: ${r.servicosSemRegra.map(avEsc).join('; ')}.` : '';
    return `Na última verificação: ${r.regrasAtivas} regra(s) ativa(s) · ${r.consultados} chamado(s) novo(s) consultado(s) · ${r.casaram} do(s) serviço(s) configurado(s) · ${r.registrados} aviso(s) registrado(s)${r.jaTratados ? ` · ${r.jaTratados} já tratado(s)` : ''}${r.fechados ? ` · ${r.fechados} já fechado(s)` : ''}.${sem}${cl}`;
}
async function avVerificarAgora() {
    try { await avApi('/verificar', 'POST', {}); await avisosCarregar(); } catch (e) { alert(e.message); }
}

// Botões de formatação da mensagem: inserem a sintaxe no ponto do cursor (ou em volta do texto selecionado)
function avInserir(tipo) {
    const ta = document.getElementById('avMsg');
    const ini = ta.selectionStart, fim = ta.selectionEnd, sel = ta.value.slice(ini, fim);
    let ins;
    if (tipo === 'negrito') ins = `**${sel || 'texto'}**`;
    else if (tipo === 'link') {
        const url = prompt('Endereço do link (https://...):', 'https://'); if (!url) return;
        if (!/^https?:\/\//i.test(url)) { alert('Use um endereço que comece com http:// ou https://'); return; }
        ins = `[${sel || prompt('Texto que aparece para o cliente:', 'clique aqui') || 'clique aqui'}](${url.trim()})`;
    } else {
        const url = prompt('Endereço (URL) da imagem — precisa ser público (https://...):', 'https://'); if (!url) return;
        if (!/^https?:\/\//i.test(url)) { alert('Use um endereço que comece com http:// ou https://'); return; }
        ins = `![${sel || 'imagem'}](${url.trim()})`;
    }
    ta.setRangeText(ins, ini, fim, 'end'); ta.focus();
}

async function avEnviarArquivo(arq) {
    if (!arq) return;
    const st = document.getElementById('avImgStatus');
    if (arq.size > 3 * 1024 * 1024) { st.textContent = 'Imagem maior que 3 MB.'; return; }
    st.textContent = 'Enviando imagem…';
    try {
        const r = await fetch(`${API_BASE}/avisos/imagem?nome=${encodeURIComponent(arq.name || 'imagem')}`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': arq.type || 'application/octet-stream' }, body: arq });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
        const ta = document.getElementById('avMsg');
        const nome = (arq.name || 'imagem').replace(/\.[^.]+$/, '').replace(/[\[\]()]/g, '');
        ta.setRangeText(`\n\n![${nome}](${d.url})\n\n`, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus();
        st.textContent = !d.https ? '⚠️ Imagem inserida, mas o endereço NÃO é HTTPS: o Movidesk só exibe imagem por HTTPS, acessível sem login nem VPN. Preencha o "Endereço público do Hub" (https://...) no topo da tela.'
            : d.publicaConfigurada ? 'Imagem inserida.' : '⚠️ Imagem inserida com o endereço desta tela. Confirme que ele abre sem login nem VPN, ou preencha o "Endereço público do Hub" no topo.';
    } catch (e) { st.textContent = e.message; }
}
