// Hub 360 — transição entre abas: persiana editorial (visual em css/modload.css).
// HubModload.show(chave, ms) fecha a persiana sobre o conteúdo; HubModload.hide() abre de novo.
// Chaves = valor de data-view das abas (e as sub-abas do Movidesk: satisfacao, chats, paineltv).
(function () {
    var NAMES = { dashboard: 'Dashboard', movidesk: 'Movidesk', satisfacao: 'Satisfação', chats: 'Chats', paineltv: 'Painel TV', incidentes: 'Incidentes', reincidencias: 'Reincidências', chamados: 'Curadoria', ouvidoria: 'Ouvidoria', gcc: 'GCC', melhorias: 'Melhorias', jira: 'Jira', pessoas: 'Pessoas', configuracoes: 'Configurações' };
    var ACC = { dashboard: '#ff8a2b', movidesk: '#ff8a2b', satisfacao: '#f5a524', chats: '#22c55e', paineltv: '#8b5cf6', incidentes: '#ef4444', reincidencias: '#ec4899', chamados: '#3b82f6', ouvidoria: '#06b6d4', gcc: '#10b981', melhorias: '#eab308', jira: '#3b82f6', pessoas: '#6366f1', configuracoes: '#94a3b8' };
    var TAGS = { dashboard: 'Chamados ativos da sua equipe', movidesk: 'Painel geral de chamados e indicadores', satisfacao: 'O que os clientes estão achando', chats: 'Conversas e atendimentos por chat', paineltv: 'Indicadores para a tela da equipe', incidentes: 'Incidentes ativos e histórico', reincidencias: 'Problemas que voltam a acontecer', chamados: 'Curadoria e análise dos chamados', ouvidoria: 'Reclamações e tratativas', gcc: 'Gestão de clientes em risco', melhorias: 'Sugestões e melhorias do produto', jira: 'Backlog e demandas de desenvolvimento', pessoas: 'Equipe, verticais e acessos', configuracoes: 'Ajustes do sistema' };
    var GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>';
    var GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*';
    var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    var root = null, el = {};
    function iniciar() {
        root = document.getElementById('modload');
        if (!root) return false;
        el = { pct: document.getElementById('ml-deg'), fill: document.getElementById('ml-fill'), name: document.getElementById('ml-name'), tag: document.getElementById('ml-tag'), ico: document.getElementById('ml-ico') };
        return true;
    }

    // nome que "decodifica" letra a letra; uma chamada nova cancela a anterior
    var decodeId = 0;
    function decode(node, text) {
        var id = ++decodeId, t0 = performance.now();
        function tick(now) {
            if (id !== decodeId) return;
            var p = Math.min(1, (now - t0) / 520), n = Math.floor(p * text.length);
            node.textContent = p < 1 ? text.slice(0, n) + text.slice(n).replace(/\S/g, function () { return GLYPHS[Math.random() * GLYPHS.length | 0]; }) : text;
            if (p < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }

    // progresso: sobe com ease-out até 94% e espera o hide() para completar
    var running = false, raf = 0, last = 0, elapsed = 0, duration = 760, finishing = false, shown = 0, lastPct = -1, lastStage = -1;
    var externo = false, ext = 0;   // externo: a porcentagem vem do carregamento real da aba (HubModload.progresso)
    function paint() {
        el.fill.style.width = (shown * 100).toFixed(1) + '%';
        var pct = Math.round(shown * 100);
        if (pct !== lastPct) { lastPct = pct; el.pct.textContent = pct; }
        var s = shown > .999 ? 3 : Math.min(2, shown * 3 | 0);
        if (s !== lastStage) { lastStage = s; root.dataset.stage = s; }
    }
    function frame(now) {
        if (!running) return;
        var dt = Math.min(40, now - last || 16); last = now; elapsed += dt;
        var target = finishing ? 1 : (externo ? Math.min(.97, ext) : Math.min(.94, 1 - Math.pow(1 - Math.min(1, elapsed / duration), 2.4)));
        shown += (target - shown) * Math.min(1, dt / (finishing ? 60 : 110));
        if (finishing && shown > .999) { shown = 1; paint(); running = false; return; }
        paint(); raf = requestAnimationFrame(frame);
    }
    function run() { if (!running) { running = true; last = 0; raf = requestAnimationFrame(frame); } }
    function stop() { running = false; cancelAnimationFrame(raf); }

    // ícone: o mesmo da aba clicada no menu do topo
    function icone(key) {
        var svg = document.querySelector('.sidebar-btn[data-view="' + key + '"] svg');
        return svg ? svg.outerHTML : GRID;
    }

    var hideTimer = 0, safeTimer = 0;
    window.HubModload = {
        NAMES: NAMES,
        // porcentagem real: 0–100, só sobe; hide() completa quando os dados já estão na tela
        progresso: function (p) { if (externo) ext = Math.max(ext, Math.min(100, p) / 100); },
        show: function (key, ms, modoExterno) {
            if (!root && !iniciar()) return false;
            clearTimeout(hideTimer); clearTimeout(safeTimer);
            root.style.setProperty('--ml-acc', ACC[key] || '#ff8a2b');
            decode(el.name, NAMES[key] || key);
            el.tag.textContent = TAGS[key] || '';
            el.ico.innerHTML = icone(key);
            root.classList.remove('on', 'done');
            elapsed = 0; duration = reduced ? 120 : (ms || 760); finishing = false; shown = 0; lastPct = lastStage = -1;
            externo = !!modoExterno; ext = 0;
            paint(); run();
            void root.offsetWidth; root.classList.add('on');
            safeTimer = setTimeout(function () { window.HubModload.hide(); }, externo ? 12000 : 6000);   // nunca deixa a tela presa
            return true;
        },
        hide: function (cb) {
            if (!root) { if (cb) cb(); return; }
            clearTimeout(safeTimer);
            finishing = true; run(); root.classList.add('done');
            hideTimer = setTimeout(function () { root.classList.remove('on', 'done'); stop(); if (cb) cb(); }, reduced ? 60 : 480);
        }
    };
})();
