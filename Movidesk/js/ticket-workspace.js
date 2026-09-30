// Central do chamado: conversa + interação com o Movidesk sem sair do Hub.
// O servidor (routes/ticket-workspace.js) lê e escreve direto na API do Movidesk.
(function () {
    const MOVIDESK_TICKET_URL = 'https://viasoft.movidesk.com/Ticket/Edit/';
    let _ws = { id: null, dados: null, opcoes: null, enviando: false };

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

    function renderConversa(acoes) {
        if (!acoes.length) return '<div class="ws-vazio">Sem ações neste chamado.</div>';
        return acoes.map(a => `
            <div class="ws-acao ${a.tipo === 'interna' ? 'ws-interna' : 'ws-publica'}">
                <div class="ws-acao-topo">
                    <strong>${esc(a.autor)}</strong>
                    <span class="ws-tag">${a.tipo === 'interna' ? 'Nota interna' : 'Resposta ao cliente'}</span>
                    <span class="ws-data">${fmt(a.criadoEm)}</span>
                </div>
                <div class="ws-acao-texto">${esc(a.texto).replace(/\n/g, '<br>') || '<em>(sem texto)</em>'}</div>
            </div>`).join('');
    }

    function renderCabecalho(d) {
        return `
            <div class="ws-assunto">${esc(d.assunto)}</div>
            <div class="ws-meta">
                <span class="ws-chip">${esc(d.status)}</span>
                <span>Responsável: <strong>${esc(d.responsavel?.nome || 'Não atribuído')}</strong></span>
                ${d.clientes.length ? `<span>Cliente: <strong>${esc(d.clientes[0])}</strong></span>` : ''}
                ${d.equipe ? `<span>Equipe: ${esc(d.equipe)}</span>` : ''}
                <span>Aberto em ${fmt(d.criadoEm)}</span>
            </div>`;
    }

    function renderControles(d, op) {
        if (!d.podeInteragir) {
            return '<div class="ws-somente-leitura">Seu perfil pode acompanhar o chamado, mas não interagir com ele.</div>';
        }
        const optsStatus = (op.status || []).map(s => `<option value="${esc(s.status)}" ${s.status === d.status ? 'selected' : ''}>${esc(s.status)}</option>`).join('');
        const optsAg = ['<option value="">Escolher…</option>'].concat((op.agentes || []).map(a => `<option value="${esc(a.id)}" ${d.responsavel && a.id === d.responsavel.id ? 'selected' : ''}>${esc(a.nome)}</option>`)).join('');
        return `
            <div class="ws-composer">
                <div class="ws-tipos">
                    <label><input type="radio" name="wsTipo" value="interna" checked> Nota interna <small>(só a equipe vê)</small></label>
                    <label><input type="radio" name="wsTipo" value="publica"> Responder ao cliente <small>(o cliente recebe)</small></label>
                </div>
                <textarea id="wsTexto" rows="4" maxlength="20000" placeholder="Escreva aqui…"></textarea>
                <div class="ws-linha">
                    <button type="button" class="pm-btn pm-btn-save" id="wsEnviar">Enviar</button>
                </div>
            </div>
            <div class="ws-acoes-rapidas">
                <div class="ws-campo">
                    <label for="wsStatus">Status</label>
                    <select id="wsStatus">${optsStatus}</select>
                    <input type="text" id="wsJustificativa" placeholder="Justificativa (obrigatória para Parado/Cancelado)">
                    <button type="button" class="pm-btn pm-btn-cancel" id="wsAplicarStatus">Alterar status</button>
                </div>
                <div class="ws-campo">
                    <label for="wsResp">Responsável</label>
                    <select id="wsResp">${optsAg}</select>
                    <button type="button" class="pm-btn pm-btn-cancel" id="wsAplicarResp">Atribuir</button>
                </div>
            </div>`;
    }

    function ligarEventos() {
        $('wsEnviar')?.addEventListener('click', enviarAcao);
        $('wsAplicarStatus')?.addEventListener('click', alterarStatus);
        $('wsAplicarResp')?.addEventListener('click', alterarResponsavel);
    }

    function desenhar() {
        const d = _ws.dados;
        $('wsTitulo').textContent = `Chamado #${d.id}`;
        $('wsCabecalho').innerHTML = renderCabecalho(d);
        $('wsConversa').innerHTML = renderConversa(d.acoes);
        $('wsControles').innerHTML = renderControles(d, _ws.opcoes || {});
        ligarEventos();
        const c = $('wsConversa');
        if (c) c.scrollTop = c.scrollHeight;
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
        const justificativa = $('wsJustificativa').value.trim();
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
            await chamar(`/${_ws.id}/workspace/responsavel`, { method: 'POST', body: JSON.stringify({ responsavelId }) });
            avisar('Responsável alterado.');
        });
    }

    window.openTicketWorkspace = async function (ticketId) {
        const modal = $('ticketWorkspaceModal');
        if (!modal) { window.open(MOVIDESK_TICKET_URL + ticketId, '_blank'); return; }
        _ws = { id: Number(ticketId), dados: null, opcoes: null, enviando: false };
        $('wsTitulo').textContent = `Chamado #${ticketId}`;
        $('wsCabecalho').innerHTML = '';
        $('wsConversa').innerHTML = '<div class="ws-vazio">Carregando conversa do Movidesk…</div>';
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
