// Configurações → Carga rápida: pendentes quase ao vivo (campos básicos agora, detalhes em segundo plano).
// Servidor: GET/PUT /api/crons/rapida (server/routes/crons.js) e server/scripts/movidesk-loader.js (runPendentesRapido).
const RP = { dados: null, opcoes: null, timer: 0 };
const rpEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rpHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

async function rpApi(caminho, metodo = 'GET', corpo) {
    const r = await fetch(`${API_BASE}${caminho}`, { method: metodo, headers: { ...authHeaders(), ...(corpo ? { 'Content-Type': 'application/json' } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
    return d;
}
function rapidaParar() { clearInterval(RP.timer); RP.timer = 0; }

async function rapidaCarregar(silencioso = false) {
    const root = document.getElementById('rpRoot');
    if (!root) return;
    try {
        deltaCarregar(silencioso);
        RP.dados = await rpApi('/crons/rapida');
        if (!RP.opcoes) { try { RP.opcoes = await rpApi('/crons/task-options'); } catch { RP.opcoes = { teams: [], classifications: [] }; } }
        // não refaz o formulário enquanto a pessoa está editando
        if (!silencioso || !document.getElementById('rpEquipe')) rpRender(); else rpAtualizarStatus();
        if (!RP.timer) RP.timer = setInterval(() => rapidaCarregar(true), 5000);
    } catch (e) { root.innerHTML = `<p class="config-status error">${rpEsc(e.message)}</p>`; }
}

function rpStatusHtml() {
    const { job, tarefa, carregando, historico } = RP.dados;
    if (!tarefa || !job) return '<span class="config-token-status config-token-status-off">Ainda não configurada</span> Clique em <b>Salvar e ligar</b> (sem filtros = todos os pendentes).';
    const ult = historico[0];
    const esc = RP.dados.escopoAbertos;
    const ROT = { New: 'Novo', InAttendance: 'Em atendimento', Stopped: 'Aguardando', InProgress: 'Em andamento' };
    const porSt = (RP.dados.porStatus || []).map((x) => `${ROT[x.base] || x.base}: <b>${x.n}</b>`).join(' · ');
    const dif = (esc != null && ult && ult.tickets_loaded != null && ult.status === 'done') ? esc - ult.tickets_loaded : null;
    const proxima = job.enabled && job.last_run_at ? new Date(new Date(job.last_run_at).getTime() + job.interval_minutes * 60000) : null;
    const badge = carregando || job.last_status === 'running' ? '<span class="config-token-status config-token-status-on">Rodando agora</span>'
        : job.last_status === 'queued' ? '<span class="config-token-status config-token-status-off">Na fila</span>'
        : job.enabled ? '<span class="config-token-status config-token-status-on">Ligada</span>' : '<span class="config-token-status config-token-status-off">Desligada</span>';
    return `${badge} a cada <b>${job.interval_minutes} min</b> · última execução: <b>${rpHora(job.last_run_at)}</b>${job.last_status === 'error' ? ` · <span style="color:#c0392b">erro: ${rpEsc(job.last_error || '')}</span>` : ''}
        ${proxima ? ` · próxima: <b>${rpHora(proxima.toISOString())}</b>` : ''}${ult ? ` · ${ult.tickets_loaded ?? 0} chamados na última` : ''}${esc != null ? `<br>Abertos no banco (filtro escolhido; sem filtro = todos): <b>${esc}</b>${porSt ? ` (${porSt})` : ''}${dif != null ? ` · o Movidesk devolveu <b>${ult.tickets_loaded}</b> na última carga → <b>${dif > 0 ? dif + ' a mais no banco (chamados já fechados que estão sendo reconferidos, até 500 a cada 3 min)' : dif < 0 ? Math.abs(dif) + ' a menos no banco' : 'bate'}</b>` : ''}` : ''}`;
}

function rpDetalhesHtml() {
    const d = RP.dados.detalhes;
    if (!d) return '<p class="config-card-help">Aparece depois da primeira execução.</p>';
    const pct = d.abertos ? Math.round(((d.abertos - d.faltam) / d.abertos) * 100) : 100;
    return `<p style="margin:0 0 8px">${d.rodando ? `<b>Rodando agora</b> — ${d.feitos}/${d.fila} da rodada · ` : ''}${d.faltam ? `faltam <b>${d.faltam}</b> de ${d.abertos} chamados abertos` : `todos os <b>${d.abertos}</b> chamados abertos com detalhes`}${d.falhas ? ` · ${d.falhas} falha(s)` : ''}${d.terminadoEm && !d.rodando ? ` · última rodada: ${rpHora(d.terminadoEm)}` : ''}${d.ultimoErro ? ` · <span style="color:#c0392b">${rpEsc(d.ultimoErro)}</span>` : ''}</p>
        <div style="height:8px;border-radius:999px;background:var(--border);overflow:hidden"><div style="height:100%;width:${pct}%;background:#10b981"></div></div>`;
}

function rpHistoricoHtml() {
    const h = RP.dados.historico;
    if (!h.length) return '<p class="config-card-help">Nenhuma execução ainda.</p>';
    const dur = (a, b) => (a && b ? `${Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000))} s` : '—');
    const st = { done: '✅ Concluída', error: '❌ Erro', running: '⏳ Rodando', cancelled: '⏹ Cancelada' };
    return `<div class="rolagem" style="max-height:340px;overflow:auto"><table class="pessoas-table"><thead><tr><th>Início</th><th>Duração</th><th>Chamados</th><th>Resultado</th></tr></thead><tbody>${h.map((r) =>
        `<tr><td>${rpHora(r.started_at)}</td><td>${dur(r.started_at, r.finished_at)}</td><td>${r.tickets_loaded ?? '—'}</td><td>${st[r.status] || rpEsc(r.status)}${r.error_msg ? `<br><small>${rpEsc(r.error_msg)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function rpListaHtml() {
    const c = RP.dados?.conferenciaLista;
    if (!c || !c.iniciadoEm) return '';
    const pct = c.total ? Math.round((c.feitos / c.total) * 100) : 100;
    return `<p style="margin:0 0 6px">${c.rodando ? '<b>Conferindo…</b> ' : '<b>Concluída</b> · '}lista: <b>${c.naLista}</b> · abertos no banco que NÃO estão na lista: <b>${c.sobrando}</b> · da lista sem estar aberto no banco: <b>${c.faltando}</b> · verificados ${c.feitos}/${c.total} · corrigidos ${c.corrigidos}${c.falhas ? ` · ${c.falhas} falha(s)` : ''}${c.ultimoErro ? ` · <span style="color:#c0392b">${rpEsc(c.ultimoErro)}</span>` : ''}</p>
      <div style="height:8px;border-radius:999px;background:var(--border);overflow:hidden"><div style="height:100%;width:${pct}%;background:#10b981"></div></div>
      ${c.amostraSobrando?.length ? `<p class="config-card-help">Exemplos que sobram: ${c.amostraSobrando.map(rpEsc).join(', ')}</p>` : ''}
      ${c.amostraFaltando?.length ? `<p class="config-card-help">Exemplos que faltam: ${c.amostraFaltando.map(rpEsc).join(', ')}</p>` : ''}`;
}
async function rapidaDetalhesAgora() {
    const m = document.getElementById('rpDetMsg');
    try { await rpApi('/crons/rapida/detalhes', 'POST', {}); m.textContent = 'Iniciado — acompanhe acima.'; rapidaCarregar(true); } catch (e) { m.textContent = e.message; }
}
async function rapidaConferirLista() {
    const f = document.getElementById('rpLista')?.files?.[0], m = document.getElementById('rpListaMsg');
    if (!f) { m.textContent = 'Escolha o arquivo.'; return; }
    m.textContent = 'Enviando…';
    try {
        const r = await fetch(`${API_BASE}/crons/rapida/conferir-lista`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: await f.arrayBuffer() });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
        m.textContent = 'Conferência iniciada.'; rapidaCarregar(true);
    } catch (e) { m.textContent = e.message; }
}
function rpAtualizarStatus() {
    const a = document.getElementById('rpStatus'), b = document.getElementById('rpDetalhes'), c = document.getElementById('rpHistorico');
    if (a) a.innerHTML = rpStatusHtml(); if (b) b.innerHTML = rpDetalhesHtml(); if (c) c.innerHTML = rpHistoricoHtml();
    const l = document.getElementById('rpListaRes'); if (l) l.innerHTML = rpListaHtml();
}

function rpRender() {
    const { tarefa, job } = RP.dados, op = RP.opcoes || { teams: [], classifications: [] };
    const opc = (lista, atual) => ['<option value="">— todos —</option>', ...lista.map((v) => `<option value="${rpEsc(v)}" ${v === atual ? 'selected' : ''}>${rpEsc(v)}</option>`),
        ...(atual && !lista.includes(atual) ? [`<option value="${rpEsc(atual)}" selected>${rpEsc(atual)}</option>`] : [])].join('');
    document.getElementById('rpRoot').innerHTML = `
      <div class="config-card">
        <h3 class="config-card-title">Carga rápida de pendentes</h3>
        <p class="config-card-help">Deixa o Painel TV (e o Dashboard) <strong>quase ao vivo</strong>. A cada execução o Hub grava na hora só o essencial dos chamados <strong>abertos</strong> —
          status, responsável, prazo de SLA, serviço, urgência e clientes/organização — e deixa as <strong>ações e demais campos</strong> sendo preenchidos em segundo plano, sem atrasar a lista.</p>
        <div id="rpStatus" style="margin:10px 0 14px;font-size:14px">${rpStatusHtml()}</div>
        <div class="config-form-stack">
          <p class="config-card-help" style="margin:0"><b>Quer todos os pendentes?</b> Deixe serviço, equipe e classificação em "— todos —": o Hub puxa todos os chamados abertos, de qualquer serviço, equipe ou classificação. Escolha algo só se quiser restringir.</p>
          <label>Serviço (BU) — ex.: Agronegócio: pega os chamados do serviço, de qualquer equipe
            <select id="rpServico" class="config-input">${opc(op.services || [], tarefa?.service_first || '')}</select></label>
          <label>Equipe (opcional; combinada com o serviço, restringe mais)
            <select id="rpEquipe" class="config-input">${opc(op.teams || [], tarefa?.owner_team || '')}</select></label>
          <label>Classificação (só vale sozinha, sem equipe nem serviço; a classificação de chamados novos chega com os detalhes)
            <select id="rpClasse" class="config-input">${opc(op.classifications || [], tarefa?.classification || '')}</select></label>
          <label>Rodar a cada (minutos, mínimo 1)
            <input id="rpIntervalo" class="config-input" type="number" min="1" max="60" style="width:110px" value="${job?.interval_minutes || 1}"></label>
          <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="rpAtiva" ${job ? (job.enabled ? 'checked' : '') : 'checked'}> Ligada</label>
          <div>
            <button class="config-btn" type="button" onclick="rapidaSalvar()">${job ? 'Salvar' : 'Salvar e ligar'}</button>
            ${job ? `<button class="config-btn config-btn-muted" type="button" onclick="rapidaRodar()">Rodar agora</button>
            <button class="config-btn config-btn-muted" type="button" onclick="rapidaPararCarga()">Parar</button>` : ''}
            <span id="rpMsg" class="config-status"></span>
          </div>
        </div>
      </div>
      <div class="config-card">
        <h3 class="config-card-title">Detalhes em segundo plano</h3>
        <p class="config-card-help">O que a carga rápida deixou para depois: ações, campos personalizados e demais dados dos chamados abertos.</p>
        <div id="rpDetalhes">${rpDetalhesHtml()}</div>
        <div style="margin-top:10px"><button class="config-btn config-btn-muted" type="button" onclick="rapidaDetalhesAgora()">Buscar detalhes agora</button> <span id="rpDetMsg" class="config-status"></span></div>
      </div>
      <div class="config-card">
        <h3 class="config-card-title">Conferir com uma lista do Movidesk</h3>
        <p class="config-card-help">Exporte do Movidesk a lista de chamados pendentes (.xlsx com a coluna "Número", ou texto/CSV com os ids) e envie aqui. O Hub compara com o banco, confirma no Movidesk os chamados que sobram ou faltam e corrige.</p>
        <input type="file" id="rpLista" accept=".xlsx,.csv,.txt" class="config-input">
        <button class="config-btn" type="button" onclick="rapidaConferirLista()">Conferir</button>
        <span id="rpListaMsg" class="config-status"></span>
        <div id="rpListaRes" style="margin-top:10px;font-size:14px">${rpListaHtml()}</div>
      </div>
      <div class="config-card">
        <h3 class="config-card-title">Últimas execuções</h3>
        <div id="rpHistorico">${rpHistoricoHtml()}</div>
      </div>`;
}

async function rapidaSalvar() {
    const msg = document.getElementById('rpMsg');
    try {
        RP.dados = await rpApi('/crons/rapida', 'PUT', { service_first: document.getElementById('rpServico').value, owner_team: document.getElementById('rpEquipe').value, classification: document.getElementById('rpClasse').value,
            interval_minutes: Number(document.getElementById('rpIntervalo').value), enabled: document.getElementById('rpAtiva').checked });
        rpRender(); document.getElementById('rpMsg').className = 'config-status ok'; document.getElementById('rpMsg').textContent = 'Salvo.';
    } catch (e) { msg.className = 'config-status error'; msg.textContent = e.message; }
}
async function rapidaRodar() {
    const msg = document.getElementById('rpMsg'), id = RP.dados?.job?.id;
    try { await rpApi(`/crons/${id}/run`, 'POST', {}); msg.className = 'config-status ok'; msg.textContent = 'Execução iniciada…'; setTimeout(() => rapidaCarregar(true), 1500); }
    catch (e) { msg.className = 'config-status error'; msg.textContent = e.message; }
}
async function rapidaPararCarga() {
    const msg = document.getElementById('rpMsg'), id = RP.dados?.job?.id;
    try { await rpApi(`/crons/${id}/stop`, 'POST', {}); msg.className = 'config-status ok'; msg.textContent = 'Pedido de parada enviado.'; setTimeout(() => rapidaCarregar(true), 1500); }
    catch (e) { msg.className = 'config-status error'; msg.textContent = e.message; }
}

// ── Carga delta (só o que mudou, com ações) — GET/PUT /api/crons/delta (runDelta em movidesk-loader.js) ──────────
const DL = { dados: null };
async function deltaCarregar(silencioso = false) {
    const root = document.getElementById('dlRoot');
    if (!root) return;
    try {
        DL.dados = await rpApi('/crons/delta');
        if (!silencioso || !document.getElementById('dlIntervalo')) dlRender(); else dlAtualizarStatus();
    } catch (e) { root.innerHTML = `<div class="config-card"><p class="config-status error">${rpEsc(e.message)}</p></div>`; }
}

function dlStatusHtml() {
    const { job, config: c, rodando, fase, rapida } = DL.dados;
    if (!job) return '<span class="config-token-status config-token-status-off">Ainda não configurada</span> Clique em <b>Salvar e ligar</b>.';
    const FASE = { preparando: 'preparando', fetching: 'perguntando ao Movidesk o que mudou', saving: 'gravando', reconferindo: 'conferindo os abertos' };
    const badge = rodando || job.last_status === 'running' ? `<span class="config-token-status config-token-status-on">Rodando agora</span>${fase ? ` ${rpEsc(FASE[fase] || fase)}…` : ''}`
        : job.last_status === 'queued' ? '<span class="config-token-status config-token-status-off">Na fila</span> esperando outra carga terminar'
        : job.enabled ? '<span class="config-token-status config-token-status-on">Ligada</span>' : '<span class="config-token-status config-token-status-off">Desligada</span>';
    const e = c?.ultima_execucao, f = c?.ultima_conferencia;
    const atraso = c?.cursor_em ? Math.max(0, Math.round((Date.now() - new Date(c.cursor_em).getTime()) / 60000)) : null;
    const linhas = [
        `${badge} a cada <b>${job.interval_minutes} min</b> · última execução: <b>${rpHora(job.last_run_at)}</b>${job.last_status === 'error' ? ` · <span style="color:#c0392b">erro: ${rpEsc(job.last_error || '')}</span>` : ''}`,
        c?.cursor_em ? `Em dia com o Movidesk até <b>${rpHora(c.cursor_em)}</b>${atraso != null ? ` (há ${atraso} min)` : ''}` : 'Cursor: ainda não rodou (a primeira execução parte do chamado mais recente do banco).',
        e ? `Última rodada: <b>${e.listados}</b> mudaram no Movidesk · <b>${e.gravados}</b> gravados (status, responsável, prazo, clientes) · ${e.jaEmDia} já estavam em dia · <b>${e.segundos} s</b>` : '',
        dlDetalhesHtml(),
        f ? `Conferência dos abertos (${rpHora(c.ultima_conferencia_em)}): Movidesk <b>${f.abertosMovidesk}</b> × banco <b>${f.abertosBanco}</b> · <b>${f.enfileirados}</b> para regravar (faltando ${f.faltando}, divergentes ${f.divergentes}, abertos só no banco ${f.soNoBanco}) · ${f.segundos} s · a cada ${c.conferir_a_cada_min} min` : `Conferência dos abertos: a cada <b>${c?.conferir_a_cada_min || 30} min</b> (ainda não rodou).`,
    ];
    if (job.enabled && rapida?.enabled) linhas.push('<span style="color:#b45309">A carga rápida abaixo também está ligada e ocupa a fila por vários minutos a cada rodada — com o delta ligado ela não é mais necessária; desligue-a para o delta rodar no horário.</span>');
    return linhas.filter(Boolean).join('<br>');
}

function dlDetalhesHtml() {
    const d = DL.dados.detalhes;
    if (!d) return '';
    const txt = d.rodando ? `<b>gravando</b> — ${d.feitos} feitos, <b>${d.fila}</b> na fila` : (d.atrasados ? `<b>${d.atrasados}</b> aguardando a próxima rodada` : 'em dia');
    return `Detalhes em segundo plano (ações, campos): ${txt}${d.atrasados && d.rodando ? ` · ${d.atrasados} com detalhes atrasados no banco` : ''}${d.falhas ? ` · <span style="color:#c0392b">${d.falhas} falha(s) — ${rpEsc(d.ultimoErro || '')}</span>` : ''}${!d.rodando && d.terminadoEm ? ` · última: ${rpHora(d.terminadoEm)}` : ''}`;
}

function dlHistoricoHtml() {
    const h = DL.dados.historico;
    if (!h.length) return '<p class="config-card-help">Nenhuma execução ainda.</p>';
    const dur = (a, b) => (a && b ? `${Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000))} s` : '—');
    const st = { done: '✅ Concluída', error: '❌ Erro', running: '⏳ Rodando', cancelled: '⏹ Cancelada' };
    return `<div class="rolagem" style="max-height:240px;overflow:auto"><table class="pessoas-table"><thead><tr><th>Início</th><th>Duração</th><th>Regravados</th><th>Resultado</th></tr></thead><tbody>${h.map((r) =>
        `<tr><td>${rpHora(r.started_at)}</td><td>${dur(r.started_at, r.finished_at)}</td><td>${r.tickets_loaded ?? '—'}</td><td>${st[r.status] || rpEsc(r.status)}${r.error_msg ? `<br><small>${rpEsc(r.error_msg)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function dlAtualizarStatus() {
    const a = document.getElementById('dlStatus'), b = document.getElementById('dlHistorico');
    if (a) a.innerHTML = dlStatusHtml(); if (b) b.innerHTML = dlHistoricoHtml();
}

function dlRender() {
    const { job, config: c } = DL.dados;
    document.getElementById('dlRoot').innerHTML = `
      <div class="config-card">
        <h3 class="config-card-title">Carga delta — só o que mudou (recomendada)</h3>
        <p class="config-card-help">A cada execução o Hub pergunta ao Movidesk <strong>quais chamados mudaram</strong> desde a última vez (abertos ou encerrados) e grava
          <strong>na hora</strong> o essencial deles (status, responsável, prazo, clientes) — leva poucos segundos. As <strong>ações e campos</strong> desses chamados vêm logo em seguida,
          <strong>em segundo plano</strong>, sem segurar as outras cargas. De tempos em tempos confere todos os chamados abertos (inclusive os parados há meses) e corrige o que divergir.</p>
        <div id="dlStatus" style="margin:10px 0 14px;font-size:14px">${dlStatusHtml()}</div>
        <div class="config-form-stack">
          <label>Rodar a cada (minutos, mínimo 1)
            <input id="dlIntervalo" class="config-input" type="number" min="1" max="60" style="width:110px" value="${job?.interval_minutes || 2}"></label>
          <label>Conferir todos os abertos a cada (minutos, de 5 a 1440)
            <input id="dlConferir" class="config-input" type="number" min="5" max="1440" style="width:110px" value="${c?.conferir_a_cada_min || 30}"></label>
          <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="dlAtiva" ${job ? (job.enabled ? 'checked' : '') : 'checked'}> Ligada</label>
          <div>
            <button class="config-btn" type="button" onclick="deltaSalvar()">${job ? 'Salvar' : 'Salvar e ligar'}</button>
            ${job ? `<button class="config-btn config-btn-muted" type="button" onclick="deltaAcao('run')">Rodar agora</button>
            <button class="config-btn config-btn-muted" type="button" onclick="deltaAcao('conferir')">Conferir abertos agora</button>
            <button class="config-btn config-btn-muted" type="button" onclick="deltaAcao('stop')">Parar</button>` : ''}
            <span id="dlMsg" class="config-status"></span>
          </div>
          ${job ? `<div class="config-card-help" style="margin:0">Reprocessar o que mudou nas últimas
            <input id="dlHoras" class="config-input" type="number" min="1" max="720" style="width:80px;display:inline-block" value="24"> horas
            <button class="config-btn config-btn-muted" type="button" onclick="deltaRecuar()">Recuar</button> (vale na próxima execução)</div>` : ''}
        </div>
        <h4 style="margin:16px 0 8px">Últimas execuções</h4>
        <div id="dlHistorico">${dlHistoricoHtml()}</div>
      </div>`;
}

function dlMsg(texto, ok = true) { const m = document.getElementById('dlMsg'); if (m) { m.className = `config-status ${ok ? 'ok' : 'error'}`; m.textContent = texto; } }
async function deltaSalvar() {
    try {
        DL.dados = await rpApi('/crons/delta', 'PUT', { interval_minutes: Number(document.getElementById('dlIntervalo').value),
            conferir_a_cada_min: Number(document.getElementById('dlConferir').value), enabled: document.getElementById('dlAtiva').checked });
        dlRender(); dlMsg('Salvo.');
    } catch (e) { dlMsg(e.message, false); }
}
async function deltaAcao(acao) {
    const id = DL.dados?.job?.id;
    try {
        if (acao === 'conferir') { const r = await rpApi('/crons/delta/conferir', 'POST', {}); dlMsg(r.queued ? 'Na fila — roda quando a carga atual terminar.' : 'Conferência iniciada…'); }
        else if (acao === 'run') { const r = await rpApi(`/crons/${id}/run`, 'POST', {}); dlMsg(r.queued ? 'Na fila — roda quando a carga atual terminar.' : 'Execução iniciada…'); }
        else { await rpApi(`/crons/${id}/stop`, 'POST', {}); dlMsg('Pedido de parada enviado.'); }
        setTimeout(() => deltaCarregar(true), 1500);
    } catch (e) { dlMsg(e.message, false); }
}
async function deltaRecuar() {
    const horas = Number(document.getElementById('dlHoras').value);
    if (!confirm(`Reprocessar tudo o que mudou nas últimas ${horas} hora(s)? Pode levar alguns minutos na próxima execução.`)) return;
    try { DL.dados = await rpApi('/crons/delta/recuar', 'POST', { horas }); dlAtualizarStatus(); dlMsg('Cursor recuado — vale na próxima execução.'); }
    catch (e) { dlMsg(e.message, false); }
}
