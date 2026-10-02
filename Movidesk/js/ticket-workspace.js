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
        if (msg) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        const campo = (rotulo, valor, destaque) => `
            <div class="ws-info-item"><dt>${esc(rotulo)}</dt><dd${destaque ? ' class="ws-info-forte"' : ''} title="${esc(valor)}">${esc(valor)}</dd></div>`;
        return `
            <div class="ws-titulo-linha">
                <div class="ws-assunto" title="${esc(d.assunto)}">${esc(d.assunto)}</div>
                <span class="ws-chip">${esc(d.status)}</span>
            </div>
            <dl class="ws-info">
                ${campo('Responsável', d.responsavel?.nome || 'Não atribuído', true)}
                ${campo('Cliente', d.clientes[0] || '—', true)}
                ${campo('Equipe', d.equipe || '—')}
                ${campo('Serviço', d.servico || '—')}
                ${campo('Aberto em', fmt(d.criadoEm))}
                ${campo('Atualizado', d.atualizadoEm ? `${fmt(d.atualizadoEm)} · ${quandoRelativo(d.atualizadoEm)}` : '—')}
            </dl>`;
    }

    function renderToolbar(d) {
        const cont = { todas: d.acoes.length, cliente: 0, equipe: 0, interna: 0 };
        d.acoes.forEach(a => { cont[classeAcao(a)]++; });
        const chip = (k, r) => `<button type="button" class="ws-filtro" data-filtro="${k}" aria-pressed="${_ws.filtro === k}">${r} (${cont[k]})</button>`;
        return chip('todas', 'Todas') + chip('cliente', 'Cliente') + chip('equipe', 'Equipe → cliente') + chip('interna', 'Internas') +
            `<button type="button" class="ws-filtro ws-ordem" id="wsOrdem" aria-pressed="false">${_ws.ordem === 'recentes' ? '↓ Mais recentes primeiro' : '↑ Mais antigas primeiro'}</button>`;
    }

    function renderAnexos(a) {
        const imgs = (a.imagens || []).map((u, i) => `<button type="button" class="ws-img" data-u="${esc(u)}" aria-label="Ampliar imagem ${i + 1}"><span>Carregando imagem…</span></button>`).join('');
        const arqs = (a.anexos || []).map(x => `<a class="ws-anexo" href="#" data-u="${esc(x.path)}" data-n="${esc(x.nome)}" title="Abre o chamado no Movidesk para ver o anexo">📎 ${esc(x.nome)} ↗</a>`).join('');
        return (imgs || arqs) ? `<div class="ws-anexos">${imgs}${arqs}</div>` : '';
    }
    async function baixarArquivo(u, nome) {
        const resp = await fetch(`${API_BASE}/tickets/${_ws.id}/workspace/arquivo?u=${encodeURIComponent(u)}&n=${encodeURIComponent(nome || '')}`, { headers: authHeaders() });
        if (!resp.ok) { let m = `HTTP ${resp.status}`; try { m = (await resp.json()).error || m; } catch { /* sem corpo */ } throw new Error(m); }
        return resp.blob();
    }
    // Imagens vêm do servidor (com o token do Movidesk) e viram blob local; ao clicar, abrem ampliadas.
    function carregarImagens() {
        document.querySelectorAll('#wsConversa .ws-img[data-u]').forEach(async (b) => {
            const u = b.dataset.u; b.removeAttribute('data-u');
            try {
                const url = URL.createObjectURL(await baixarArquivo(u));
                b.innerHTML = `<img alt="Imagem do chamado" src="${url}">`; b.dataset.src = url;
            } catch (e) { b.innerHTML = `<span title="${esc(e.message)}">Imagem indisponível — abra no Movidesk</span>`; }
        });
    }
    document.addEventListener('click', async (e) => {
        const img = e.target.closest('#wsConversa .ws-img[data-src]');
        if (img) { window.open(img.dataset.src, '_blank', 'noopener'); return; }
        const link = e.target.closest('#wsConversa .ws-anexo');
        if (!link) return;
        e.preventDefault();
        // O Movidesk só entrega anexos identificados por código dentro dele: abre o chamado lá.
        if (/^[0-9a-f]{16,64}$/i.test(link.dataset.u || '')) { window.open(MOVIDESK_TICKET_URL + _ws.id, '_blank', 'noopener'); avisar(`O anexo "${link.dataset.n}" só abre dentro do Movidesk: abri o chamado lá.`); return; }
        try {
            const blob = await baixarArquivo(link.dataset.u, link.dataset.n);
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = link.dataset.n || 'arquivo'; a.click();
        } catch (err) { avisar(`Não consegui baixar o anexo: ${err.message}`, true); }
    });

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
                    ${renderAnexos(a)}
                </div>
            </div>`;
        }).join('');
    }

    // Ações rápidas de status: só as transições que fazem sentido a partir do status atual, com nomes claros.
    // Cada botão escolhe o status da empresa pelo "status base" do Movidesk (nada de digitar ou escolher na lista).
    function statusPorBase(op, base) { return ((op.status || []).find(x => x.baseStatus === base) || {}).status || null; }
    function botoesStatus(d, op) {
        const base = ((op.status || []).find(x => x.status === d.status) || {}).baseStatus;
        const B = (rotulo, base2, classe, dica) => { const st = statusPorBase(op, base2); return st ? `<button type="button" class="ws-btn ${classe || ''}" data-rapida="${esc(st)}" data-base="${base2}" title="${esc(dica)}">${rotulo}</button>` : ''; };
        if (base === 'New') return B('Iniciar atendimento', 'InAttendance', 'ws-btn-primario', 'Muda para ' + statusPorBase(op, 'InAttendance')) + B('Aguardando…', 'Stopped', '', 'Pausar o chamado (pede o motivo)') + B('Resolver', 'Resolved', '', 'Marcar como resolvido');
        if (base === 'InAttendance' || base === 'InProgress') return B('Aguardando…', 'Stopped', '', 'Pausar o chamado (pede o motivo)') + B('Resolver', 'Resolved', 'ws-btn-primario', 'Marcar como resolvido');
        if (base === 'Stopped') return B('Retomar atendimento', 'InAttendance', 'ws-btn-primario', 'Volta para ' + statusPorBase(op, 'InAttendance')) + B('Resolver', 'Resolved', '', 'Marcar como resolvido');
        if (base === 'Resolved' || base === 'Closed' || base === 'Canceled') return B('Reabrir (voltar ao atendimento)', 'InAttendance', 'ws-btn-primario', 'Reabre o chamado');
        return '';
    }
    function rapidaStatus(botao) {
        const status = botao.dataset.rapida;
        if (botao.dataset.base === 'Stopped') {           // pausar precisa do motivo: abre as opções já com o status escolhido
            const det = $('wsMaisStatus'); det.open = true; $('wsStatus').value = status; ajustarJustificativa();
            ($('wsJustificativaSel').style.display !== 'none' ? $('wsJustificativaSel') : $('wsJustificativa')).focus();
            return avisar('Escolha o motivo da espera e clique em “Alterar status”.');
        }
        $('wsStatus').value = status;
        alterarStatus();
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
                <div class="ws-ia" role="group" aria-label="Assistente de IA">
                    <select id="wsIaTom" aria-label="Tom da sugestão" title="Tom da sugestão de resposta">
                        <option value="padrao">Tom padrão</option><option value="empatico">Empático</option><option value="objetivo">Objetivo</option>
                    </select>
                    <button type="button" class="ws-btn ws-btn-ia" id="wsIaResposta" title="A IA escreve um rascunho de resposta ao cliente com base na conversa. Se já houver texto na caixa, ele é usado como base.">✨ Sugerir resposta</button>
                    <button type="button" class="ws-btn ws-btn-ia" id="wsIaCorrigir" title="Corrige ortografia, acentuação e pontuação sem mudar o que você quis dizer">Corrigir texto</button>
                </div>
                <textarea id="wsTexto" maxlength="20000" placeholder="Escreva aqui…" aria-label="Mensagem"></textarea>
                <div id="wsIaNota" class="ws-ia-nota" role="status"></div>
                <div class="ws-envio">
                    <select id="wsAcaoStatus" aria-label="Status do chamado ao enviar" title="Como no Movidesk: você pode mudar o status junto com a ação">
                        <option value="">Manter o status atual (${esc(d.status)})</option>${(op.status || []).filter(x => x.status !== d.status).map(x => `<option value="${esc(x.status)}">Mudar para: ${esc(x.status)}</option>`).join('')}
                    </select>
                    <button type="button" class="ws-btn ws-btn-primario" id="wsEnviar">Enviar</button>
                </div>
                <div id="wsAcaoJustBox" style="display:none">
                    <select id="wsAcaoJustSel" style="display:none;" aria-label="Justificativa do status"></select>
                    <input type="text" id="wsAcaoJust" placeholder="Justificativa" aria-label="Justificativa do status">
                </div>
            </div>
            <div class="ws-secao">
                <h4>Cliente</h4>
                <button type="button" class="ws-btn ws-btn-ia" id="wsIaCliente" title="Sentimento, risco de churn, histórico de chamados e recomendações">✨ Analisar cliente</button>
                <div id="wsIaClienteBox" class="ws-cli-box" aria-live="polite"></div>
            </div>
            <div class="ws-secao">
                <h4>Responsável</h4>
                <div class="ws-dica">Atual: <strong>${esc(d.responsavel ? d.responsavel.nome : 'ninguém')}</strong></div>
                <button type="button" class="ws-btn ws-btn-primario" id="wsAssumir" title="Passa o chamado para você, na sua equipe do Movidesk">Atribuir para mim</button>
                <details class="ws-mais">
                    <summary>Atribuir a outra pessoa</summary>
                    <select id="wsResp" aria-label="Novo responsável">${optsAg}</select>
                    <select id="wsEquipeResp" style="display:none;" aria-label="Equipe do chamado"></select>
                    <button type="button" class="ws-btn" id="wsAplicarResp">Atribuir</button>
                </details>
            </div>
            <div class="ws-secao">
                <h4>Status: ${esc(d.status)}</h4>
                <div class="ws-rapidas" id="wsRapidas">${botoesStatus(d, op)}</div>
                <details class="ws-mais" id="wsMaisStatus">
                    <summary>Escolher outro status</summary>
                    <select id="wsStatus" aria-label="Novo status">${optsStatus}</select>
                    <select id="wsJustificativaSel" style="display:none;" aria-label="Justificativa"></select>
                    <input type="text" id="wsJustificativa" placeholder="Justificativa (opcional)" aria-label="Justificativa">
                    <button type="button" class="ws-btn" id="wsAplicarStatus">Alterar status</button>
                </details>
            </div>
            <div class="ws-secao" id="wsIncidente" style="display:none;">
                <h4>Incidente</h4>
                <div id="wsIncBody"></div>
            </div>`;
    }

    function ligarEventos() {
        $('wsEnviar')?.addEventListener('click', enviarAcao);
        $('wsIaResposta')?.addEventListener('click', iaSugerirResposta);
        $('wsIaCorrigir')?.addEventListener('click', iaCorrigirTexto);
        $('wsIaCliente')?.addEventListener('click', iaAnalisarCliente);
        verificarIa();
        $('wsAplicarStatus')?.addEventListener('click', alterarStatus);
        $('wsRapidas')?.addEventListener('click', (e) => { const b = e.target.closest('[data-rapida]'); if (b) rapidaStatus(b); });
        $('wsAssumir')?.addEventListener('click', assumirChamado);
        $('wsAplicarResp')?.addEventListener('click', alterarResponsavel);
        $('wsResp')?.addEventListener('change', ajustarEquipeResponsavel);
        $('wsStatus')?.addEventListener('change', () => ajustarJustificativa());
        $('wsAcaoStatus')?.addEventListener('change', () => {
            $('wsAcaoJustBox').style.display = $('wsAcaoStatus').value ? '' : 'none';
            ajustarJustificativa('wsAcaoStatus', 'wsAcaoJustSel', 'wsAcaoJust');
        });
        ajustarJustificativa();
        document.querySelectorAll('input[name="wsTipo"]').forEach(r => r.addEventListener('change', () => {
            const publica = document.querySelector('input[name="wsTipo"]:checked')?.value === 'publica';
            $('wsDica').textContent = publica ? 'O cliente recebe esta mensagem.' : 'Só a equipe vê esta nota.';
        }));
    }

    // Justificativas que já existem no Movidesk para o status escolhido: vira uma lista para escolher.
    // Sem nenhuma conhecida, cai no campo de texto (obrigatório só para Parado/Cancelado).
    // Obrigatória só se o status é Parado/Cancelado e há justificativas cadastradas para ele (o servidor confere de novo).
    function exigeJustificativa(status, base) {
        const lista = ((_ws.opcoes && _ws.opcoes.justificativas) || {})[String(status).trim().toLowerCase()] || [];
        return ['Stopped', 'Canceled'].includes(base) && lista.length > 0;
    }
    function justificativaAtual(idSel = 'wsJustificativaSel', idTxt = 'wsJustificativa') {
        const sel = $(idSel);
        if (sel && sel.style.display !== 'none') return sel.value;
        return ($(idTxt)?.value || '').trim();
    }
    function ajustarJustificativa(idStatus = 'wsStatus', idSel = 'wsJustificativaSel', idTxt = 'wsJustificativa') {
        const sel = $(idSel), txt = $(idTxt);
        if (!sel || !txt) return;
        const status = $(idStatus).value;
        if (!status) { sel.style.display = 'none'; txt.style.display = 'none'; return; }
        const lista = ((_ws.opcoes && _ws.opcoes.justificativas) || {})[String(status).trim().toLowerCase()] || [];
        const base = ((_ws.opcoes.status || []).find(s => s.status === status) || {}).baseStatus;
        const obrigatoria = ['Stopped', 'Canceled'].includes(base) && lista.length > 0;
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
        carregarImagens();
        $('wsToolbar').querySelectorAll('[data-filtro]').forEach(b => b.addEventListener('click', () => { _ws.filtro = b.dataset.filtro; desenharTimeline(); }));
        $('wsOrdem')?.addEventListener('click', () => { _ws.ordem = _ws.ordem === 'recentes' ? 'antigas' : 'recentes'; desenharTimeline(); });
        const c = $('wsConversa');
        c.scrollTop = _ws.ordem === 'recentes' ? 0 : c.scrollHeight;
    }

    // ── IA embutida: sugestão de resposta, correção de texto e análise do cliente ──
    // Só gera RASCUNHOS: nada é enviado ao cliente até a pessoa revisar e clicar em Enviar.
    let _iaStatus = null;
    async function verificarIa() {
        if (_iaStatus === null) {
            try { _iaStatus = await chamar('/workspace/ia/status'); } catch { _iaStatus = { configurada: false }; }
        }
        const rec = _iaStatus.recursos || {};
        const regras = [['wsIaResposta', 'resposta'], ['wsIaCorrigir', 'corrigir'], ['wsIaCliente', 'cliente']];
        if (_iaStatus.tomPadrao && $('wsIaTom') && !$('wsIaTom').dataset.ajustado) { $('wsIaTom').value = _iaStatus.tomPadrao; $('wsIaTom').dataset.ajustado = '1'; }
        regras.forEach(([id, chave]) => {
            const b = $(id); if (!b) return;
            if (rec[chave] === false) { b.style.display = 'none'; if (chave === 'resposta' && $('wsIaTom')) $('wsIaTom').style.display = 'none'; return; }
            if (!_iaStatus.configurada) { b.disabled = true; b.title = 'A chave da IA ainda não foi configurada (Configurações → Inteligência Artificial).'; }
        });
        const grupo = document.querySelector('.ws-ia');
        if (grupo && rec.resposta === false && rec.corrigir === false) grupo.style.display = 'none';
    }
    async function comIa(botao, rotulo, fn) {
        if (_ws.enviando || botao.dataset.ocupado) return;
        botao.dataset.ocupado = '1';
        const original = botao.innerHTML;
        botao.disabled = true;
        botao.textContent = rotulo;
        avisar('');
        try { await fn(); } catch (e) { avisar(e.message, true); }
        finally { botao.disabled = false; botao.innerHTML = original; delete botao.dataset.ocupado; }
    }
    function listaHtml(titulo, itens) {
        return itens && itens.length ? `<div class="ws-ia-bloco"><strong>${esc(titulo)}</strong><ul>${itens.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '';
    }
    let _textoAntesDaIa = null;
    function mostrarNotaIa(html, desfazer) {
        const box = $('wsIaNota');
        box.innerHTML = html + (desfazer ? '<button type="button" class="ws-link" id="wsIaDesfazer">Desfazer</button>' : '');
        $('wsIaDesfazer')?.addEventListener('click', () => { $('wsTexto').value = _textoAntesDaIa || ''; box.innerHTML = ''; });
    }
    function iaSugerirResposta() {
        comIa($('wsIaResposta'), 'Pensando…', async () => {
            const atual = $('wsTexto').value.trim();
            const r = await chamar(`/${_ws.id}/workspace/ia/resposta`, { method: 'POST', body: JSON.stringify({ tom: $('wsIaTom').value, instrucao: atual }) });
            _textoAntesDaIa = $('wsTexto').value;
            $('wsTexto').value = r.resposta;
            const pub = document.querySelector('input[name="wsTipo"][value="publica"]');
            if (pub) { pub.checked = true; $('wsDica').textContent = 'O cliente recebe esta mensagem.'; }
            mostrarNotaIa(`<div class="ws-ia-aviso">Rascunho da IA — revise antes de enviar.</div>${listaHtml('Confira antes de enviar', r.pontosDeAtencao)}${listaHtml('Faltou no chamado', r.informacoesFaltantes)}`, atual.length > 0);
        });
    }
    function iaCorrigirTexto() {
        const original = $('wsTexto').value;
        if (!original.trim()) return avisar('Escreva o texto antes de pedir a correção.', true);
        comIa($('wsIaCorrigir'), 'Corrigindo…', async () => {
            const r = await chamar(`/${_ws.id}/workspace/ia/corrigir`, { method: 'POST', body: JSON.stringify({ texto: original }) });
            if (!r.mudou) { mostrarNotaIa('<div class="ws-ia-aviso ws-ia-ok">Nenhum erro encontrado.</div>', false); return; }
            _textoAntesDaIa = original;
            $('wsTexto').value = r.textoCorrigido;
            const mud = (r.alteracoes || []).map(a => `<li><s>${esc(a.de)}</s> → <b>${esc(a.para)}</b>${a.motivo ? ` <span class="ws-dica">(${esc(a.motivo)})</span>` : ''}</li>`).join('');
            mostrarNotaIa(`<div class="ws-ia-aviso ws-ia-ok">Texto corrigido.</div>${mud ? `<div class="ws-ia-bloco"><strong>O que mudou</strong><ul>${mud}</ul></div>` : ''}`, true);
        });
    }
    const COR = { positivo: 'ok', neutro: 'neutro', frustrado: 'alerta', irritado: 'ruim', baixo: 'ok', baixa: 'ok', medio: 'alerta', media: 'alerta', alto: 'ruim', alta: 'ruim' };
    const ROT = { media: 'média', medio: 'médio' };
    const pilula = (rotulo, valor) => `<span class="ws-pilula ws-pilula-${COR[valor] || 'neutro'}"><small>${esc(rotulo)}</small> ${esc(ROT[valor] || valor)}</span>`;
    function iaAnalisarCliente() {
        comIa($('wsIaCliente'), 'Analisando…', async () => {
            const r = await chamar(`/${_ws.id}/workspace/ia/cliente`, { method: 'POST' });
            const h = r.historico || {};
            const num = (v, suf = '') => (v == null ? '—' : v + suf);
            $('wsIaClienteBox').innerHTML = `
                <div class="ws-pilulas">${pilula('Sentimento', r.sentimento)}${pilula('Urgência', r.urgenciaPercebida)}${pilula('Risco de churn', r.riscoDeChurn)}</div>
                <p class="ws-cli-resumo">${esc(r.resumo)}</p>
                ${r.perfil ? `<p class="ws-dica"><b>Perfil:</b> ${esc(r.perfil)}</p>` : ''}
                ${listaHtml('Sinais', r.sinais)}${listaHtml('Recomendações', r.recomendacoes)}
                ${h.organizacao ? `<div class="ws-hist"><strong>${esc(h.organizacao)}</strong>
                    <div class="ws-hist-grid"><span><b>${num(h.tickets90d)}</b> chamados<br>90 dias</span><span><b>${num(h.tickets12m)}</b> chamados<br>12 meses</span><span><b>${num(h.abertosAgora)}</b> abertos<br>agora</span><span><b>${num(h.reabertos12m)}</b> reabertos<br>12 meses</span><span><b>${num(h.tempoMedioResolucaoH, ' h')}</b> resolução<br>média 90d</span><span><b>${num(h.tocouGcc12m)}</b> no GCC<br>12 meses</span></div></div>` : '<p class="ws-dica">Organização não identificada no banco — análise só pela conversa.</p>'}
                <p class="ws-dica">Análise gerada por IA a partir da conversa e do histórico; use como apoio.</p>`;
        });
    }

    // ── Incidente ligado a este chamado (ITIL): ver, vincular a um aberto ou abrir um novo ──
    async function chamarInc(caminho, opcoes = {}) {
        const resp = await fetch(`${API_BASE}/incidentes${caminho}`, { ...opcoes, headers: authHeaders(opcoes.body ? { 'Content-Type': 'application/json' } : {}) });
        const raw = await resp.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
        if (!resp.ok) { const e = new Error(data.error || `HTTP ${resp.status}`); e.status = resp.status; throw e; }
        return data;
    }
    function abrirIncidenteNaAba(id) {
        try {
            const shell = window.top;
            if (shell && typeof shell.navigateTo === 'function') {
                shell.navigateTo('incidentes');
                const frame = shell.document.getElementById('embeddedPageFrame');
                if (frame) frame.setAttribute('src', `pages/incidentes.html?id=${id}`);
                window.closeTicketWorkspace();
                return;
            }
        } catch (e) { /* cross-frame indisponível */ }
        window.open(`pages/incidentes.html?id=${id}`, '_blank');
    }
    async function carregarIncidente() {
        const box = $('wsIncidente'), body = $('wsIncBody');
        if (!box || !body) return;
        const idAtual = _ws.id;
        try {
            const r = await chamarInc(`/por-ticket/${idAtual}`);
            if (_ws.id !== idAtual) return;
            box.style.display = '';
            if (r.incidente) {
                const i = r.incidente;
                body.innerHTML = `<div><strong>${esc(i.codigo)}</strong> · P${i.prioridade} · ${esc(i.rotuloStatus)}</div>
                    <div class="ws-dica">${esc(i.titulo)}</div>
                    <button type="button" class="ws-btn" id="wsIncAbrir">Abrir o incidente</button>`;
                $('wsIncAbrir').addEventListener('click', () => abrirIncidenteNaAba(i.id));
                return;
            }
            const abertos = (await chamarInc('/?escopo=abertos').catch(() => ({ incidentes: [] }))).incidentes || [];
            body.innerHTML = `<p class="ws-dica">Este chamado não está ligado a nenhum incidente.</p>
                ${abertos.length ? `<select id="wsIncSel" aria-label="Incidente aberto"><option value="">Vincular a um incidente aberto…</option>${abertos.map(i => `<option value="${i.id}">${esc(i.codigo)} · P${i.prioridade} · ${esc(i.titulo.slice(0, 60))}</option>`).join('')}</select>
                <button type="button" class="ws-btn" id="wsIncVincular">Vincular</button>` : ''}
                <button type="button" class="ws-btn" id="wsIncNovo">Abrir novo incidente com este chamado</button>`;
            $('wsIncVincular')?.addEventListener('click', async () => {
                const inc = $('wsIncSel').value;
                if (!inc) return avisar('Escolha o incidente.', true);
                try { await chamarInc(`/${inc}/tickets`, { method: 'POST', body: JSON.stringify({ ticketIds: [idAtual] }) }); avisar('Chamado vinculado ao incidente.'); carregarIncidente(); }
                catch (e) { avisar(e.message, true); }
            });
            $('wsIncNovo').addEventListener('click', async () => {
                const titulo = prompt('Título do incidente (descreva o problema de serviço, não só este chamado):', (_ws.dados && _ws.dados.assunto) || '');
                if (!titulo) return;
                try {
                    const n = await chamarInc('/', { method: 'POST', body: JSON.stringify({ titulo, servico: (_ws.dados && _ws.dados.servico) || '', ticketIds: [idAtual] }) });
                    avisar(`Incidente ${n.incidente.codigo} aberto (P${n.incidente.prioridade}). Ajuste impacto e urgência na aba Incidentes.`);
                    carregarIncidente();
                } catch (e) { avisar(e.message, true); }
            });
        } catch (e) {
            box.style.display = 'none'; // sem acesso à aba Incidentes: não mostra a seção
        }
    }

    function desenhar() {
        const d = _ws.dados;
        $('wsTitulo').textContent = `Chamado #${d.id}`;
        $('wsCabecalho').innerHTML = renderCabecalho(d);
        $('wsControles').innerHTML = renderControles(d, _ws.opcoes || {});
        ligarEventos();
        desenharTimeline();
        carregarIncidente();
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
            // o servidor já gravou a mudança no banco: recarrega o Dashboard para o chamado mudar de coluna na hora
            if (typeof fetchOpenTickets === 'function') fetchOpenTickets().catch(() => {});
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
        const status = ($('wsAcaoStatus')?.value || '').trim();
        const justificativa = status ? justificativaAtual('wsAcaoJustSel', 'wsAcaoJust') : '';
        if (!texto) return avisar('Escreva a mensagem antes de enviar.', true);
        const base = status ? (_ws.opcoes.status || []).find(s => s.status === status)?.baseStatus : null;
        if (exigeJustificativa(status, base) && !justificativa) return avisar(`O status "${status}" exige uma justificativa.`, true);
        if (tipo === 'publica' && !confirm('Esta mensagem será enviada ao CLIENTE. Confirmar?')) return;
        if (['Resolved', 'Closed', 'Canceled'].includes(base) && !confirm(`Além de enviar a mensagem, mudar o chamado para "${status}"? O cliente pode ser notificado.`)) return;
        executar($('wsEnviar'), 'Enviando…', async () => {
            await chamar(`/${_ws.id}/workspace/acao`, { method: 'POST', body: JSON.stringify({ tipo, texto, status, justificativa }) });
            const msg = tipo === 'publica' ? 'Resposta enviada ao cliente' : 'Nota interna registrada';
            avisar(status ? `${msg} e status alterado para "${status}".` : `${msg}.`);
        });
    }

    function alterarStatus() {
        const status = $('wsStatus').value;
        const justificativa = justificativaAtual();
        if (status === _ws.dados.status) return avisar(`O chamado já está em "${status}". Escolha outro status na lista para alterar.`, true);
        const base = (_ws.opcoes.status || []).find(s => s.status === status)?.baseStatus;
        if (['Resolved', 'Closed', 'Canceled'].includes(base) && !confirm(`Mudar o chamado para "${status}"? O cliente pode ser notificado.`)) return;
        executar($('wsAplicarStatus'), 'Alterando…', async () => {
            await chamar(`/${_ws.id}/workspace/status`, { method: 'POST', body: JSON.stringify({ status, justificativa }) });
            avisar(`Status alterado para "${status}".`);
        });
    }

    function assumirChamado() {
        executar($('wsAssumir'), 'Atribuindo…', async () => {
            const equipe = $('wsEquipeResp') && $('wsEquipeResp').style.display !== 'none' ? $('wsEquipeResp').value : '';
            await chamar(`/${_ws.id}/workspace/responsavel`, { method: 'POST', body: JSON.stringify({ paraMim: true, equipe }) });
            avisar('Chamado atribuído para você.');
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
                if ($('wsAcaoStatus')?.value) ajustarJustificativa('wsAcaoStatus', 'wsAcaoJustSel', 'wsAcaoJust');
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
