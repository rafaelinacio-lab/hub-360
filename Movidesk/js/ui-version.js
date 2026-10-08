// Visual 2.0 é o padrão do Hub 360: marca o <html> para ativar css/v2.css e css/sem-animacao.css.
document.documentElement.setAttribute('data-ui', 'v2');

// Gráficos (Chart.js) sem animação: assim que a biblioteca é carregada, desliga as animações padrão.
(function () {
    var guardado;
    try {
        Object.defineProperty(window, 'Chart', {
            configurable: true,
            get: function () { return guardado; },
            set: function (v) {
                guardado = v;
                try { if (v && v.defaults) { v.defaults.animation = false; v.defaults.transitions = { active: { animation: { duration: 0 } } }; } } catch (e) {}
            }
        });
    } catch (e) {}
})();

// ─── Medidor de carregamento da aba (só dentro do iframe do shell) ───
// Mede o carregamento REAL: documento + chamadas à /api (bytes recebidos quando o servidor informa o tamanho,
// senão por chamada concluída). Avisa o shell com a porcentagem e, quando tudo terminou e a tela já foi
// desenhada, com `pronto`. O shell usa isso na persiana de transição.
(function () {
    if (window.parent === window || !window.fetch || window.__hubSemMedidor) return;
    var QUIETO_MS = 250, LIMITE_MS = 25000, JANELA_MS = 700;   // só entram na espera as chamadas feitas logo que a página abre
    // Enquanto os dados da abertura não chegam, cada card mostra "Carregando dados…" (css/v2.css: .hub-load).
    var CARDS = '.chart-panel,.stat-card,.card,.panel,.box,.kpi-tile,.summary-card,.dashboard-sidebar,.sla-hero,.bk-hero,.bk-sit,.kb-col,.tl-chart,.mel-card,.kpi,.tile';
    var raiz = document.documentElement, obs = null, marcando = 0;
    raiz.classList.add('hub-carregando');
    function marcarCards() {
        marcando = 0;
        if (!document.body) return;
        document.querySelectorAll(CARDS).forEach(function (el) {
            if (el.closest('.hub-load') || el.querySelector(':scope > .hub-load')) return;
            if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return;       // escondido
            if (el.offsetHeight < 56 || el.offsetWidth < 90) return;                          // pequeno demais para a mensagem
            if (getComputedStyle(el).position === 'static') el.classList.add('hub-rel');
            var d = document.createElement('div'); d.className = 'hub-load'; d.textContent = 'Carregando dados…'; d.setAttribute('role', 'status');
            el.appendChild(d);
        });
    }
    function agendarMarca() { if (!marcando) marcando = requestAnimationFrame(marcarCards); }
    function limparCards() {
        if (obs) { obs.disconnect(); obs = null; }
        cancelAnimationFrame(marcando); marcando = 0;
        raiz.classList.remove('hub-carregando');
        document.querySelectorAll('.hub-load').forEach(function (n) { n.remove(); });
        document.querySelectorAll('.hub-rel').forEach(function (n) { n.classList.remove('hub-rel'); });
    }
    document.addEventListener('DOMContentLoaded', function () {
        marcarCards();
        try { obs = new MutationObserver(agendarMarca); obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    });
    var reqs = [], docPct = 0, ultimo = 0, pronto = false, carregou = false, quietoTimer = 0, t0 = Date.now(), tLoad = 0;

    function post(pct, fim) { try { window.parent.postMessage({ tipo: 'hub360:carga', pct: Math.round(pct), pronto: !!fim }, location.origin); } catch (e) {} }
    function pctAtual() {
        var p = docPct;                                    // 0–20: carregando o documento
        if (reqs.length) {
            var soma = 0;
            reqs.forEach(function (r) { soma += r.fim ? 1 : (r.total ? Math.min(.95, r.lido / r.total) : 0); });
            p = 20 + 75 * (soma / reqs.length);            // 20–95: chamadas à API
        } else if (carregou) p = 60;
        return Math.max(ultimo, Math.min(95, p));
    }
    function atualizar() { if (pronto) return; ultimo = pctAtual(); post(ultimo, false); agendar(); }
    function pendentes() { return reqs.some(function (r) { return !r.fim; }); }
    function agendar() {
        clearTimeout(quietoTimer);
        quietoTimer = setTimeout(function () {
            if (pronto || !carregou || pendentes()) return;
            // dois quadros: dá tempo de a tela ser desenhada com os dados
            requestAnimationFrame(function () { requestAnimationFrame(function () {
                if (pronto || pendentes()) return;
                pronto = true; post(100, true); limparCards();
            }); });
        }, QUIETO_MS);
    }
    setTimeout(function () { if (!pronto) { pronto = true; post(100, true); limparCards(); } }, LIMITE_MS);

    document.addEventListener('DOMContentLoaded', function () { docPct = Math.max(docPct, 10); atualizar(); });
    window.addEventListener('load', function () { carregou = true; tLoad = Date.now(); docPct = 20; atualizar(); });
    post(0, false);

    var original = window.fetch;
    window.fetch = function (entrada, init) {
        var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';
        var promessa = original.apply(this, arguments);
        if (pronto || url.indexOf('/api/') < 0) return promessa;
        if (carregou && Date.now() - tLoad > JANELA_MS) return promessa;   // chamada tardia (cálculos extras): não segura a abertura
        var r = { fim: false, lido: 0, total: 0 };
        reqs.push(r); atualizar();
        var terminar = function () { if (!r.fim) { r.fim = true; atualizar(); } };
        promessa.then(function (resp) {
            r.total = Number(resp.headers.get('X-Hub-Tamanho')) || 0;
            if (r.total > 200000 && resp.body && resp.clone) {      // grande: acompanha os bytes numa cópia
                try {
                    var leitor = resp.clone().body.getReader();
                    (function ler() { leitor.read().then(function (x) {
                        if (x.done) return;
                        r.lido += x.value.length; atualizar(); ler();
                    }).catch(function () {}); })();
                } catch (e) {}
            }
            // conclui quando o corpo é consumido (json/text), ou em 1,5 s se ninguém o ler
            ['json', 'text', 'blob', 'arrayBuffer'].forEach(function (m) {
                var f = resp[m]; if (typeof f !== 'function') return;
                resp[m] = function () { return f.apply(resp, arguments).then(function (v) { terminar(); return v; }, function (e) { terminar(); throw e; }); };
            });
            setTimeout(terminar, 60000);
        }, terminar);
        return promessa;
    };
})();

// ─── Última atualização da aba ───
// Etiqueta discreta no canto inferior direito com a data e a hora em que os DADOS da aba foram atualizados de verdade
// (fim da última carga do Movidesk que a alimenta, arquivos do extrator do Jira ou última gravação do Hub), lida de
// GET /api/frescor/<aba>. Não é a hora em que o navegador buscou. Só em abas com conteúdo próprio: o shell (index.html)
// e as molduras de iframe não mostram; Painel TV e Chats têm indicador próprio.
(function () {
    if (!window.fetch || window.__hubSemUltAtu) return;
    var m = location.pathname.match(/\/pages\/([a-z0-9-]+)\.html$/);
    var aba = m && m[1];
    if (!aba || aba === 'chats' || aba === 'painel-tv') return;
    var el = null, css = null;

    function texto(d) {
        try {
            return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (e) { return d.toLocaleString('pt-BR'); }
    }
    function mostrar(msg, dica) {
        if (!document.body || document.querySelector('iframe')) return;      // moldura de iframe: quem mostra é a tela interna
        if (!el) {
            css = document.createElement('style');
            css.textContent = '.hub-ultatu{position:fixed;right:12px;bottom:8px;z-index:40;padding:3px 10px;border-radius:999px;font:600 11px/1.4 Manrope,system-ui,sans-serif;'
                + 'color:var(--t3,#675e54);background:var(--surface-mid,var(--bg2,#faf8f5));border:1px solid var(--border-hi,var(--border,#cfc7bc));opacity:.92;white-space:nowrap}'
                + '@media print{.hub-ultatu{display:none}}';
            document.head.appendChild(css);
            el = document.createElement('div'); el.className = 'hub-ultatu'; el.setAttribute('role', 'status');
            document.body.appendChild(el);
        }
        el.textContent = msg; el.title = dica || '';
    }
    function token() { try { return localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('sessionToken') || ''; } catch (e) { return ''; } }
    function ler() {
        var t = token(); if (!t) return;
        fetch('/api/frescor/' + aba, { headers: { Authorization: 'Bearer ' + t } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (!d) return;
                if (d.atualizadoEm) mostrar('Dados atualizados em ' + texto(new Date(d.atualizadoEm)), d.fonte);
                else mostrar('Dados atualizados em: sem registro', d.fonte);
            })
            .catch(function () {});
    }
    // espera a abertura da aba terminar (o medidor acima só conta chamadas feitas logo que a página abre) e depois renova a cada minuto
    window.addEventListener('load', function () { setTimeout(function () { ler(); setInterval(ler, 60 * 1000); }, 1500); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && el) ler(); });
})();
