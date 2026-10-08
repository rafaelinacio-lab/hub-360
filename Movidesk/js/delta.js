// Configurações → Carga Datalake → cartão "Carga delta" (só o que mudou: essencial na hora, ações/campos em segundo plano).
// Servidor: GET/PUT /api/crons/delta, POST /delta/recuar e /delta/conferir (server/routes/crons.js) e runDelta (movidesk-loader.js).
const DT = { dados: null, timer: 0 };
const dtEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dtHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
async function dtApi(caminho, metodo = 'GET', corpo) {
    const r = await fetch(`${API_BASE}${caminho}`, { method: metodo, headers: { ...authHeaders(), ...(corpo ? { 'Content-Type': 'application/json' } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
    return d;
}
// Atualiza o status a cada 5 s enquanto a aba Carga Datalake está aberta (switchConfigTab chama deltaParar ao trocar de aba).
function deltaParar() { clearInterval(DT.timer); DT.timer = 0; }
async function deltaCarregar(silencioso = false) {
    const root = document.getElementById('deltaRoot');
    if (!root) return;
    try {
        DT.dados = await dtApi('/crons/delta');
        if (!silencioso || !document.getElementById('deltaIntervalo')) deltaRender(); else deltaAtualizarStatus();
        if (!DT.timer) DT.timer = setInterval(() => deltaCarregar(true), 5000);
    } catch (e) { root.innerHTML = `<div class="config-card"><p class="config-status error">${dtEsc(e.message)}</p></div>`; }
}

function deltaStatusHtml() {
    const { job, config: c, rodando, fase, rapida } = DT.dados;
    if (!job) return '<span class="config-token-status config-token-status-off">Ainda não configurada</span> Clique em <b>Salvar e ligar</b>.';
    const FASE = { preparando: 'preparando', fetching: 'perguntando ao Movidesk o que mudou', saving: 'gravando', reconferindo: 'conferindo os abertos' };
    const badge = rodando || job.last_status === 'running' ? `<span class="config-token-status config-token-status-on">Rodando agora</span>${fase ? ` ${dtEsc(FASE[fase] || fase)}…` : ''}`
        : job.last_status === 'queued' ? '<span class="config-token-status config-token-status-off">Na fila</span> esperando outra carga terminar'
        : job.enabled ? '<span class="config-token-status config-token-status-on">Ligada</span>' : '<span class="config-token-status config-token-status-off">Desligada</span>';
    const e = c?.ultima_execucao, f = c?.ultima_conferencia;
    const atraso = c?.cursor_em ? Math.max(0, Math.round((Date.now() - new Date(c.cursor_em).getTime()) / 60000)) : null;
    const linhas = [
        `${badge} a cada <b>${job.interval_minutes} min</b> · última execução: <b>${dtHora(job.last_run_at)}</b>${job.last_status === 'error' ? ` · <span style="color:#c0392b">erro: ${dtEsc(job.last_error || '')}</span>` : ''}`,
        c?.cursor_em ? `Em dia com o Movidesk até <b>${dtHora(c.cursor_em)}</b>${atraso != null ? ` (há ${atraso} min)` : ''}` : 'Cursor: ainda não rodou (a primeira execução parte do chamado mais recente do banco).',
        e ? `Última rodada: <b>${e.listados}</b> mudaram no Movidesk · <b>${e.gravados}</b> gravados (status, responsável, prazo, clientes) · ${e.jaEmDia} já estavam em dia · <b>${e.segundos} s</b>` : '',
        deltaDetalhesHtml(),
        f ? `Conferência dos abertos (${dtHora(c.ultima_conferencia_em)}): Movidesk <b>${f.abertosMovidesk}</b> × banco <b>${f.abertosBanco}</b> · <b>${f.enfileirados}</b> para regravar (faltando ${f.faltando}, divergentes ${f.divergentes}, abertos só no banco ${f.soNoBanco}) · ${f.segundos} s · a cada ${c.conferir_a_cada_min} min` : `Conferência dos abertos: a cada <b>${c?.conferir_a_cada_min || 30} min</b> (ainda não rodou).`,
    ];
    if (job.enabled && rapida?.enabled) linhas.push('<span style="color:#b45309">A cron &quot;Pendentes rápidos (Painel TV)&quot; (Cargas automáticas, abaixo) também está ligada e ocupa a fila por vários minutos a cada rodada — com o delta ligado ela não é mais necessária; desative-a para o delta rodar no horário.</span>');
    return linhas.filter(Boolean).join('<br>');
}

function deltaDetalhesHtml() {
    const d = DT.dados.detalhes;
    if (!d) return '';
    const txt = d.rodando ? `<b>gravando</b> — ${d.feitos} feitos, <b>${d.fila}</b> na fila` : (d.atrasados ? `<b>${d.atrasados}</b> aguardando a próxima rodada` : 'em dia');
    return `Detalhes em segundo plano (ações, campos): ${txt}${d.atrasados && d.rodando ? ` · ${d.atrasados} com detalhes atrasados no banco` : ''}${d.falhas ? ` · <span style="color:#c0392b">${d.falhas} falha(s) — ${dtEsc(d.ultimoErro || '')}</span>` : ''}${!d.rodando && d.terminadoEm ? ` · última: ${dtHora(d.terminadoEm)}` : ''}`;
}

function deltaHistoricoHtml() {
    const h = DT.dados.historico;
    if (!h.length) return '<p class="config-card-help">Nenhuma execução ainda.</p>';
    const dur = (a, b) => (a && b ? `${Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000))} s` : '—');
    const st = { done: '✅ Concluída', error: '❌ Erro', running: '⏳ Rodando', cancelled: '⏹ Cancelada' };
    return `<div class="rolagem" style="max-height:240px;overflow:auto"><table class="pessoas-table"><thead><tr><th>Início</th><th>Duração</th><th>Regravados</th><th>Resultado</th></tr></thead><tbody>${h.map((r) =>
        `<tr><td>${dtHora(r.started_at)}</td><td>${dur(r.started_at, r.finished_at)}</td><td>${r.tickets_loaded ?? '—'}</td><td>${st[r.status] || dtEsc(r.status)}${r.error_msg ? `<br><small>${dtEsc(r.error_msg)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function deltaAtualizarStatus() {
    const a = document.getElementById('deltaStatus'), b = document.getElementById('deltaHistorico');
    if (a) a.innerHTML = deltaStatusHtml(); if (b) b.innerHTML = deltaHistoricoHtml();
}

function deltaRender() {
    const { job, config: c } = DT.dados;
    document.getElementById('deltaRoot').innerHTML = `
      <div class="config-card">
        <h3 class="config-card-title">Carga delta — só o que mudou (recomendada)</h3>
        <p class="config-card-help">A cada execução o Hub pergunta ao Movidesk <strong>quais chamados mudaram</strong> desde a última vez (abertos ou encerrados) e grava
          <strong>na hora</strong> o essencial deles (status, responsável, prazo, clientes) — leva poucos segundos. As <strong>ações e campos</strong> desses chamados vêm logo em seguida,
          <strong>em segundo plano</strong>, sem segurar as outras cargas. De tempos em tempos confere todos os chamados abertos (inclusive os parados há meses) e corrige o que divergir.</p>
        <div id="deltaStatus" style="margin:10px 0 14px;font-size:14px">${deltaStatusHtml()}</div>
        <div class="config-form-stack">
          <label>Rodar a cada (minutos, mínimo 1)
            <input id="deltaIntervalo" class="config-input" type="number" min="1" max="60" style="width:110px" value="${job?.interval_minutes || 2}"></label>
          <label>Conferir todos os abertos a cada (minutos, de 5 a 1440)
            <input id="deltaConferir" class="config-input" type="number" min="5" max="1440" style="width:110px" value="${c?.conferir_a_cada_min || 30}"></label>
          <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="deltaAtiva" ${job ? (job.enabled ? 'checked' : '') : 'checked'}> Ligada</label>
          <div>
            <button class="config-btn" type="button" onclick="deltaSalvar()">${job ? 'Salvar' : 'Salvar e ligar'}</button>
            ${job ? `<button class="config-btn config-btn-muted" type="button" onclick="deltaAcao('run')">Rodar agora</button>
            <button class="config-btn config-btn-muted" type="button" onclick="deltaAcao('conferir')">Conferir abertos agora</button>
            <button class="config-btn config-btn-muted" type="button" onclick="deltaAcao('stop')">Parar</button>` : ''}
            <span id="deltaMsg" class="config-status"></span>
          </div>
          ${job ? `<div class="config-card-help" style="margin:0">Reprocessar o que mudou nas últimas
            <input id="deltaHoras" class="config-input" type="number" min="1" max="720" style="width:80px;display:inline-block" value="24"> horas
            <button class="config-btn config-btn-muted" type="button" onclick="deltaRecuar()">Recuar</button> (vale na próxima execução)</div>` : ''}
        </div>
        <h4 style="margin:16px 0 8px">Últimas execuções</h4>
        <div id="deltaHistorico">${deltaHistoricoHtml()}</div>
      </div>`;
}

function deltaMsg(texto, ok = true) { const m = document.getElementById('deltaMsg'); if (m) { m.className = `config-status ${ok ? 'ok' : 'error'}`; m.textContent = texto; } }
async function deltaSalvar() {
    try {
        DT.dados = await dtApi('/crons/delta', 'PUT', { interval_minutes: Number(document.getElementById('deltaIntervalo').value),
            conferir_a_cada_min: Number(document.getElementById('deltaConferir').value), enabled: document.getElementById('deltaAtiva').checked });
        deltaRender(); deltaMsg('Salvo.');
    } catch (e) { deltaMsg(e.message, false); }
}
async function deltaAcao(acao) {
    const id = DT.dados?.job?.id;
    try {
        if (acao === 'conferir') { const r = await dtApi('/crons/delta/conferir', 'POST', {}); deltaMsg(r.queued ? 'Na fila — roda quando a carga atual terminar.' : 'Conferência iniciada…'); }
        else if (acao === 'run') { const r = await dtApi(`/crons/${id}/run`, 'POST', {}); deltaMsg(r.queued ? 'Na fila — roda quando a carga atual terminar.' : 'Execução iniciada…'); }
        else { await dtApi(`/crons/${id}/stop`, 'POST', {}); deltaMsg('Pedido de parada enviado.'); }
        setTimeout(() => deltaCarregar(true), 1500);
    } catch (e) { deltaMsg(e.message, false); }
}
async function deltaRecuar() {
    const horas = Number(document.getElementById('deltaHoras').value);
    if (!confirm(`Reprocessar tudo o que mudou nas últimas ${horas} hora(s)? Pode levar alguns minutos na próxima execução.`)) return;
    try { DT.dados = await dtApi('/crons/delta/recuar', 'POST', { horas }); deltaAtualizarStatus(); deltaMsg('Cursor recuado — vale na próxima execução.'); }
    catch (e) { deltaMsg(e.message, false); }
}
