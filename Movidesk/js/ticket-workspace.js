// Central do chamado: conversa + interação com o Movidesk sem sair do Hub.
// O servidor (routes/ticket-workspace.js) lê e escreve direto na API do Movidesk.
(function () {
    const MOVIDESK_TICKET_URL = 'https://viasoft.movidesk.com/Ticket/Edit/';
    let _ws = { id: null, dados: null, opcoes: null, enviando: false, filtro: 'todas', ordem: 'recentes' };

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmt = (v) => v ? new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    async function chamar(caminho, opcoes = {}) {
        const resp = await fetch(`${API_BASE}/tickets${caminho}`, {
            ...opcoes,
            headers: authHeaders(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
        });
        const raw = await resp.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
    }

    function avisar(msg, erro) {
        const el = $('wsAviso');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'ws-aviso' + (msg ? (erro ? ' ws-aviso-erro' : ' ws-aviso-ok') : '');
        if (msg && !erro) setTimeout(() => { if (el.textContent === msg) avisar(''); }, 4000);
    }

    // cliente = resposta pública de um cliente; equipe = resposta pública de um agente; interna = nota
    function classeAcao(a) {
        if (a.tipo === 'interna') return 'interna';
        return a.autorPerfil === 2 ? 'cliente' : 'equipe';
    }
    const ROTULO_CLASSE = { interna: 'Nota interna', cliente: 'Cliente', equipe: 'Resposta ao cliente' };

    function quandoRelativo(v) {
        if (!v) return '';
        const min = Math.round((Date.now() - new Date(v).getTime()) / 60000);
        if (min < 1) return 'agora';
        if (min < 60) return `há ${min} min`;
        if (min < 60 * 24) return `há ${Math.floor(min / 60)} h`;
        return `há ${Math.floor(min / 1440)} d`;
    }

    function renderCabecalho(d) {
        return `
            <div class="ws-assunto">${esc(d.assunto)}</div>
            <div class="ws-meta">
                <span class="ws-chip">${esc(d.status)}</span>
                <span>Responsável: <strong>${esc(d.responsavel?.nome || 'Não atribuído')}</strong></span>
                ${d.clientes.length ? `<span>Cliente: <strong>${esc(d.clientes[0])}</strong></span>` : ''}
                ${d.equipe ? `<span>Equipe: <strong>${esc(d.equipe)}</strong></span>` : ''}
                ${d.servico ? `<span>Serviço: ${esc(d.servico)}</span>` : ''}
                <span>Aberto em ${fmt(d.criadoEm)}</span>
            </div>`;
    }

    function renderToolbar(d) {
        const cont = { todas: d.acoes.length, cliente: 0, equipe: 0, interna: 0 };
        d.acoes.forEach(a => { cont[classeAcao(a)]++; });
        const chip = (k, r) => `<button type="button" class="ws-filtro" data-filtro="${k}" aria-pressed="${_ws.filtro === k}">${r} (${cont[k]})</button>`;
        return chip('todas', 'Todas') + chip('cliente', 'Cliente') + chip('equipe', 'Equipe → cliente') + chip('interna', 'Internas') +
            `<button type="button" class="ws-filtro ws-ordem" id="wsOrdem" aria-pressed="false">${_ws.ordem === 'recentes' ? '↓ Mais recentes primeiro' : '↑ Mais antigas primeiro'}</button>`;
    }

    function renderTimeline(d) {
        let itens = d.acoes.filter(a => _ws.filtro === 'todas' || classeAcao(a) === _ws.filtro);
        if (_ws.ordem === 'recentes') itens = itens.slice().reverse();
        if (!itens.length) return '<div class="ws-vazio">Nenhuma ação neste filtro.</div>';
        return itens.map(a => {
            const c = classeAcao(a);
            return `
            <div class="ws-item ws-${c}">
                <span class="ws-dot" aria-hidden="true"></span>
                <div class="ws-card">
                    <div class="ws-acao-topo">
                        <strong>${esc(a.autor)}</strong>
                        <span class="ws-tag">${ROTULO_CLASSE[c]}</span>
                        <span class="ws-data" title="${fmt(a.criadoEm)}">${fmt(a.criadoEm)} · ${quandoRelativo(a.criadoEm)}</span>
                    </div>
                    <div class="ws-acao-texto">${esc(a.texto).replace(/\n/g, '<br>') || '<em>(sem texto)</em>'}</div>
                </div>
            </div>`;
        }).join('');
    }

    function renderControles(d, op) {
        if (!d.podeInteragir) {
            return '<div class="ws-somente-leitura">Seu perfil pode acompanhar o chamado, mas não interagir com ele.</div>';
        }
        const optsStatus = (op.status || []).map(s => `<option value="${esc(s.status)}" ${s.status === d.status ? 'selected' : ''}>${esc(s.status)}</option>`).join('');
        const optsAg = ['<option value="">Escolher…</option>'].concat((op.agentes || []).map(a => `<option value="${esc(a.id)}" ${d.responsavel && a.id === d.responsavel.id ? 'selected' : ''}>${esc(a.nome)}</option>`)).join('');
        return `
            <div class="ws-secao">
                <h4>Responder</h4>
                <div class="ws-segmentos" role="radiogroup" aria-label="Tipo de mensagem">
                    <label><input type="radio" name="wsTipo" value="interna" checked> Nota interna</label>
                    <label><input type="radio" name="wsTipo" value="publica"> Ao cliente</label>
                </div>
                <p class="ws-dica" id="wsDica">Só a equipe vê esta nota.</p>
                <textarea id="wsTexto" maxlength="20000" placeholder="Escreva aqui…" aria-label="Mensagem"></textarea>
                <button type="button" class="ws-btn ws-btn-primario" id="wsEnviar">Enviar</button>
            </div>
            <div class="ws-secao">
                <h4>Status</h4>
                <select id="wsStatus" aria-label="Novo status">${optsStatus}</select>
                <select id="wsJustificativaSel" style="display:none;" aria-label="Justificativa"></select>
                <input type="text" id="wsJustificativa" placeholder="Justificativa (obrigatória para Parado/Cancelado)" aria-label="Justificativa">
                <button type="button" class="ws-btn" id="wsAplicarStatus">Alterar status</button>
            </div>
            <div class="ws-secao">
                <h4>Responsável</h4>
                <select id="wsResp" aria-label="Novo responsável">${optsAg}</select>
                <select id="wsEquipeResp" style="display:none;" aria-label="Equipe do chamado"></select>
                <button type="button" class="ws-btn" id="wsAplicarResp">Atribuir</button>
            </div>`;
    }

    function ligarEventos() {
        $('wsEnviar')?.addEventListener('click', enviarAcao);
        $('wsAplicarStatus')?.addEventListener('click', alterarStatus);
        $('wsAplicarResp')?.addEventListener('click', alterarResponsavel);
        $('wsResp')?.addEventListener('change', ajustarEquipeResponsavel);
        $('wsStatus')?.addEventListener('change', ajustarJustificativa);
        ajustarJustificativa();
        document.querySelectorAll('input[name="wsTipo"]').forEach(r => r.addEventListener('change', () => {
            const publica = document.querySelector('input[name="wsTipo"]:checked')?.value === 'publica';
            $('wsDica').textContent = publica ? 'O cliente recebe esta mensagem.' : 'Só a equipe vê esta nota.';
        }));
    }

    // Justificativas que já existem no Movidesk para o status escolhido: vira uma lista para escolher.
    // Sem nenhuma conhecida, cai no campo de texto (obrigatório só para Parado/Cancelado).
    function justificativaAtual() {
        const sel = $('wsJustificativaSel');
        if (sel && sel.style.display !== 'none') return sel.value;
        return ($('wsJustificativa')?.value || '').trim();
    }
    function ajustarJustificativa() {
        const sel = $('wsJustificativaSel'), txt = $('wsJustificativa');
        if (!sel || !txt) return;
        const status = $('wsStatus').value;
        const lista = ((_ws.opcoes && _ws.opcoes.justificativas) || {})[String(status).trim().toLowerCase()] || [];
        const base = ((_ws.opcoes.status || []).find(s => s.status === status) || {}).baseStatus;
        const obrigatoria = ['Stopped', 'Canceled'].includes(base);
        if (lista.length) {
            sel.innerHTML = (obrigatoria ? '<option value="">Escolha a justificativa…</option>' : '<option value="">Sem justificativa</option>') +
                lista.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
            sel.style.display = '';
            txt.style.display = 'none';
        } else {
            sel.style.display = 'none';
            sel.innerHTML = '';
            txt.style.display = '';
            txt.placeholder = obrigatoria ? 'Justificativa (obrigatória)' : 'Justificativa (opcional)';
        }
    }

    // Se o novo responsável está em mais de uma equipe, o Movidesk exige escolher a do chamado.
    function ajustarEquipeResponsavel() {
        const sel = $('wsEquipeResp');
        if (!sel) return;
        const ag = (_ws.opcoes.agentes || []).find(a => a.id === $('wsResp').value);
        const equipes = ag && ag.equipes ? ag.equipes : [];
        if (equipes.length > 1) {
            const atual = _ws.dados && _ws.dados.equipe;
            sel.innerHTML = equipes.map(e => `<option value="${esc(e)}" ${e === atual ? 'selected' : ''}>Equipe: ${esc(e)}</option>`).join('');
            sel.style.display = '';
        } else {
            sel.style.display = 'none';
            sel.innerHTML = '';
        }
    }

    function desenharTimeline() {
        const d = _ws.dados;
        $('wsToolbar').innerHTML = renderToolbar(d);
        $('wsConversa').innerHTML = renderTimeline(d);
        $('wsToolbar').querySelectorAll('[data-filtro]').forEach(b => b.addEventListener('click', () => { _ws.filtro = b.dataset.filtro; desenharTimeline(); }));
        $('wsOrdem')?.addEventListener('click', () => { _ws.ordem = _ws.ordem === 'recentes' ? 'antigas' : 'recentes'; desenharTimeline(); });
        const c = $('wsConversa');
        c.scrollTop = _ws.ordem === 'recentes' ? 0 : c.scrollHeight;
    }

    function desenhar() {
        const d = _ws.dados;
        $('wsTitulo').textContent = `Chamado #${d.id}`;
        $('wsCabecalho').innerHTML = renderCabecalho(d);
        $('wsControles').innerHTML = renderControles(d, _ws.opcoes || {});
        ligarEventos();
        desenharTimeline();
    }

    async function carregar() {
        const d = await chamar(`/${_ws.id}/workspace`);
        _ws.dados = d;
        desenhar();
    }

    async function executar(botao, rotulo, fn) {
        if (_ws.enviando) return;
        _ws.enviando = true;
        const texto = botao.textContent;
        botao.disabled = true;
        botao.textContent = rotulo;
        avisar('');
        try {
            await fn();
            await carregar();
        } catch (e) {
            avisar(e.message, true);
            botao.disabled = false;
            botao.textContent = texto;
        } finally {
            _ws.enviando = false;
        }
    }

    function enviarAcao() {
        const tipo = document.querySelector('input[name="wsTipo"]:checked')?.value;
        const texto = $('wsTexto').value.trim();
        if (!texto) return avisar('Escreva a mensagem antes de enviar.', true);
        if (tipo === 'publica' && !confirm('Esta mensagem será enviada ao CLIENTE. Confirmar?')) return;
        executar($('wsEnviar'), 'Enviando…', async () => {
            await chamar(`/${_ws.id}/workspace/acao`, { method: 'POST', body: JSON.stringify({ tipo, texto }) });
            avisar(tipo === 'publica' ? 'Resposta enviada ao cliente.' : 'Nota interna registrada.');
        });
    }

    function alterarStatus() {
        const status = $('wsStatus').value;
        const justificativa = justificativaAtual();
        if (status === _ws.dados.status) return avisar('O chamado já está com esse status.', true);
        const base = (_ws.opcoes.status || []).find(s => s.status === status)?.baseStatus;
        if (['Resolved', 'Closed', 'Canceled'].includes(base) && !confirm(`Mudar o chamado para "${status}"? O cliente pode ser notificado.`)) return;
        executar($('wsAplicarStatus'), 'Alterando…', async () => {
            await chamar(`/${_ws.id}/workspace/status`, { method: 'POST', body: JSON.stringify({ status, justificativa }) });
            avisar(`Status alterado para "${status}".`);
        });
    }

    function alterarResponsavel() {
        const responsavelId = $('wsResp').value;
        if (!responsavelId) return avisar('Escolha o novo responsável.', true);
        if (_ws.dados.responsavel && responsavelId === _ws.dados.responsavel.id) return avisar('Esse já é o responsável.', true);
        executar($('wsAplicarResp'), 'Atribuindo…', async () => {
            const equipe = $('wsEquipeResp') && $('wsEquipeResp').style.display !== 'none' ? $('wsEquipeResp').value : '';
            await chamar(`/${_ws.id}/workspace/responsavel`, { method: 'POST', body: JSON.stringify({ responsavelId, equipe }) });
            avisar('Responsável alterado.');
        });
    }

    window.openTicketWorkspace = async function (ticketId) {
        const modal = $('ticketWorkspaceModal');
        if (!modal) { window.open(MOVIDESK_TICKET_URL + ticketId, '_blank'); return; }
        _ws = { id: Number(ticketId), dados: null, opcoes: null, enviando: false, filtro: 'todas', ordem: 'recentes' };
        $('wsTitulo').textContent = `Chamado #${ticketId}`;
        $('wsCabecalho').innerHTML = '';
        $('wsToolbar').innerHTML = '';
        $('wsConversa').innerHTML = '<div class="ws-vazio">Carregando a linha do tempo do Movidesk…</div>';
        $('wsControles').innerHTML = '';
        avisar('');
        modal.style.display = 'flex';
        try {
            const [opcoes] = await Promise.all([
                chamar('/workspace/opcoes').catch(() => ({ status: [], agentes: [] })),
                (async () => { _ws.dados = await chamar(`/${_ws.id}/workspace`); })(),
            ]);
            _ws.opcoes = opcoes;
            desenhar();
            // Justificativas em segundo plano: o modal já está usável; o campo vira lista quando chegam.
            chamar(`/workspace/justificativas?tipo=${encodeURIComponent((_ws.dados && _ws.dados.tipoTicket) || '')}`).then((r) => {
                if (_ws.id !== Number(ticketId)) return;
                _ws.opcoes.justificativas = r.justificativas || {};
                ajustarJustificativa();
            }).catch(() => { /* sem lista: continua o campo de texto */ });
        } catch (e) {
            $('wsConversa').innerHTML = `<div class="ws-vazio ws-erro">Não consegui carregar o chamado: ${esc(e.message)}</div>`;
        }
    };

    window.closeTicketWorkspace = function () {
        const modal = $('ticketWorkspaceModal');
        if (modal) modal.style.display = 'none';
    };

    document.addEventListener('DOMContentLoaded', () => {
        $('wsFechar')?.addEventListener('click', window.closeTicketWorkspace);
        $('ticketWorkspaceModal')?.addEventListener('click', (e) => { if (e.target.id === 'ticketWorkspaceModal') window.closeTicketWorkspace(); });
        $('wsAbrirMovidesk')?.addEventListener('click', () => { if (_ws.id) window.open(MOVIDESK_TICKET_URL + _ws.id, '_blank'); });
        $('wsAnalise')?.addEventListener('click', () => { if (_ws.id && typeof handleCardClick === 'function') handleCardClick(_ws.id); });
    });
})();
