// ── aparencia.js — aparência do sistema configurável (Configurações → Aparência) ─────────────────────────────
// Carregado no <head> de todas as telas (shell e abas). Aplica a configuração guardada em /api/aparencia SOBRE os tokens do Visual 2.0
// (css/v2.css): cor de destaque, fonte, cantos, escala da interface e menu (ordem/visibilidade). Sem mexer em código:
//   1) aplica de imediato o último valor guardado neste navegador (sem piscar);
//   2) busca o valor atual do servidor e reaplica se mudou;
//   3) quando o admin salva, as outras telas abertas atualizam sozinhas (evento 'storage').
// Nada do que vem do servidor é inserido como texto livre: cor = #rrggbb, o resto são chaves de listas fechadas (ver server/routes/aparencia.js).
(function () {
    var LS = 'hub_aparencia', ID = 'hub-aparencia-css', ID_FONTE = 'hub-aparencia-fonte';
    var FONTES = {
        manrope: { css: '"Manrope", system-ui, -apple-system, "Segoe UI", sans-serif', gf: 'Manrope:wght@400;500;600;700;800' },
        inter:   { css: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',   gf: 'Inter:wght@400;500;600;700;800' },
        roboto:  { css: '"Roboto", system-ui, -apple-system, "Segoe UI", sans-serif',  gf: 'Roboto:wght@400;500;700' },
        poppins: { css: '"Poppins", system-ui, -apple-system, "Segoe UI", sans-serif', gf: 'Poppins:wght@400;500;600;700' },
        sistema: { css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', gf: '' }
    };
    var RAIOS = { reto: ['6px', '8px', '6px'], medio: ['12px', '16px', '10px'] };   // [cartão, janela, botão]; "redondo" = o padrão do v2.css
    var CARTOES = '.chart-panel,.stat-card,.card,.panel,.cbox,.box,.kpi-tile,.summary-card,.data-panel,.config-card,.mel-card,.kpi,.tile,.imp-k,.bk-hero,.bk-sit';
    var JANELAS = '.modal-box,.modal,.gv,.ws-modal,.pm-modal';

    // ── cor ──
    function hex2hsl(h) {
        var r = parseInt(h.slice(1, 3), 16) / 255, g = parseInt(h.slice(3, 5), 16) / 255, b = parseInt(h.slice(5, 7), 16) / 255;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, s = 0, hh = 0;
        if (mx !== mn) {
            var d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
            hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh *= 60;
        }
        return [hh, s * 100, l * 100];
    }
    function hsl(h, s, l, a) { return 'hsl(' + Math.round(h) + ' ' + Math.round(Math.max(0, Math.min(100, s))) + '% ' + Math.round(Math.max(0, Math.min(100, l))) + '%' + (a != null ? ' / ' + a : '') + ')'; }
    function lum(h) {   // luminância relativa para escolher o texto sobre a cor (preto ou branco)
        var c = [1, 3, 5].map(function (i) { var v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function tokensCor(cor) {
        var t = hex2hsl(cor), H = t[0], S = Math.min(t[1], 92);
        var claro = {
            '--brand': cor, '--brand-hover': hsl(H, S, Math.min(t[2] + 6, 78)), '--brand-text': hsl(H, Math.min(S, 85), 30),
            '--brand-soft': hsl(H, Math.min(S, 90), 92), '--on-brand': lum(cor) > 0.4 ? '#1a1a1a' : '#ffffff',
            '--orange-fill': cor, '--orange': hsl(H, Math.min(S, 85), 36), '--orange-bg': hsl(H, Math.min(S, 90), 92), '--orange-bd': hsl(H, Math.min(S, 85), 36, 0.28),
            '--topbar-accent': hsl(H, Math.min(S, 85), 30), '--logo-color': cor
        };
        var escuro = {
            '--brand-text': hsl(H, Math.min(S, 95), 68), '--brand-soft': hsl(H, Math.min(S, 60), 12), '--orange': hsl(H, Math.min(S, 95), 66),
            '--orange-bg': hsl(H, Math.min(S, 60), 14), '--orange-bd': hsl(H, Math.min(S, 90), 66, 0.32), '--topbar-accent': hsl(H, Math.min(S, 95), 68)
        };
        return { claro: claro, escuro: escuro };
    }
    function decl(o) { return Object.keys(o).map(function (k) { return k + ':' + o[k]; }).join(';'); }

    function gerarCss(cfg) {
        var s = [], A = 'html[data-ui="v2"][data-aparencia]';
        if (cfg.cor && /^#[0-9a-f]{6}$/i.test(cfg.cor)) {
            var t = tokensCor(cfg.cor);
            s.push(A + '{' + decl(t.claro) + '}');
            s.push(A + '[data-theme="dark"],' + A + '.dark{' + decl(t.escuro) + '}');
        }
        var f = FONTES[cfg.fonte];
        if (f && cfg.fonte !== 'manrope') s.push(A + '{--v2-font:' + f.css + '}' + A + ' body,' + A + ' button,' + A + ' input,' + A + ' select,' + A + ' textarea{font-family:' + f.css + '}');
        var r = RAIOS[cfg.raio];
        if (r) s.push(A + '{--radius-lg:' + r[0] + ';--radius-xl:' + r[1] + '}' + A + ' :is(' + CARTOES + '){border-radius:' + r[0] + '!important}' +
            A + ' :is(' + JANELAS + '){border-radius:' + r[1] + '!important}' + A + ' :is(button,.btn,.config-btn,.ms-btn,select,input[type=text],input[type=search]){border-radius:' + r[2] + '!important}');
        (cfg.menu || []).forEach(function (m, i) {
            if (!/^[a-z]+$/.test(m.v)) return;
            s.push(A + ' .topbar-nav .sidebar-btn[data-view="' + m.v + '"]{order:' + (i + 1) + (m.on === false ? ';display:none!important' : '') + '}');
        });
        return s.join('\n');
    }

    function aplicar(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        var raiz = document.documentElement;
        raiz.setAttribute('data-aparencia', '1');
        var st = document.getElementById(ID);
        if (!st) { st = document.createElement('style'); st.id = ID; (document.head || raiz).appendChild(st); }
        st.textContent = gerarCss(cfg);
        // fonte: carrega do Google Fonts só quando escolhida (o CSP do Hub já libera fonts.googleapis.com / gstatic)
        var f = FONTES[cfg.fonte];
        var lk = document.getElementById(ID_FONTE);
        if (f && f.gf) {
            if (!lk) { lk = document.createElement('link'); lk.id = ID_FONTE; lk.rel = 'stylesheet'; (document.head || raiz).appendChild(lk); }
            var href = 'https://fonts.googleapis.com/css2?family=' + f.gf + '&display=swap';
            if (lk.getAttribute('href') !== href) lk.setAttribute('href', href);
        } else if (lk) lk.remove();
        // escala da interface: só no documento de cima (o shell). Escalar também cada aba embutida contaria duas vezes.
        if (window.top === window) raiz.style.zoom = cfg.escala && cfg.escala !== 100 ? String(cfg.escala / 100) : '';
        // tema padrão: só vale para quem nunca escolheu um tema neste navegador
        try {
            if (cfg.temaPadrao && !localStorage.getItem('theme')) raiz.setAttribute('data-theme', cfg.temaPadrao === 'escuro' ? 'dark' : 'light');
        } catch (_) { /* sem localStorage */ }
    }
    function lerLocal() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (_) { return null; } }
    function guardar(cfg) { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (_) { /* privado/sem espaço */ } }

    var local = lerLocal();
    if (local) aplicar(local);
    if (window.fetch) {
        fetch('/api/aparencia', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
            if (!cfg) return;
            if (JSON.stringify(cfg) !== JSON.stringify(local)) { guardar(cfg); aplicar(cfg); }
        }).catch(function () { /* sem servidor: fica com o guardado */ });
    }
    window.addEventListener('storage', function (e) {
        if (e.key !== LS) return;
        try { aplicar(JSON.parse(e.newValue || 'null')); } catch (_) { /* valor inválido */ }
    });
    // ── barras de rolagem: visíveis, finas e discretas em TODO o sistema (cards, gráficos, tabelas, listas, modais e a própria tela) ──
    // Antes cada tela escondia as barras (*{scrollbar-width:none}); aqui as propriedades padrão têm !important para valer sobre qualquer
    // regra local. A cor é um cinza translúcido (serve nos temas claro e escuro). Não vale para quem tem a classe .no-scrollbar (opt-out
    // pontual) nem para telas com html.sem-barras (modo TV, que rola sozinho).
    (function barras() {
        if (document.getElementById('hub-barras-css')) return;
        var st = document.createElement('style'); st.id = 'hub-barras-css';
        st.textContent =
            'html:not(.sem-barras) *:not(.no-scrollbar):not(body){scrollbar-width:thin!important;scrollbar-color:var(--hub-sb,rgba(120,128,150,.42)) transparent!important;-ms-overflow-style:auto!important}' +
            'html:not(.sem-barras) *:not(.no-scrollbar):not(body)::-webkit-scrollbar{display:block!important;width:8px!important;height:8px!important;background:transparent!important}' +
            'html:not(.sem-barras),html:not(.sem-barras) body{scrollbar-width:none!important}html:not(.sem-barras)::-webkit-scrollbar,html:not(.sem-barras) body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
            'html:not(.sem-barras) *:not(.no-scrollbar)::-webkit-scrollbar-track{background:transparent!important}' +
            'html:not(.sem-barras) *:not(.no-scrollbar)::-webkit-scrollbar-thumb{background:var(--hub-sb,rgba(120,128,150,.42))!important;border-radius:999px!important;border:2px solid transparent!important;background-clip:content-box!important}' +
            'html:not(.sem-barras) *:not(.no-scrollbar)::-webkit-scrollbar-thumb:hover{background:var(--hub-sb-hover,rgba(120,128,150,.75))!important;background-clip:content-box!important}' +
            'html:not(.sem-barras) *:not(.no-scrollbar)::-webkit-scrollbar-corner{background:transparent!important}';
        (document.head || document.documentElement).appendChild(st);
    })();

    // ── roda do mouse: rola SEMPRE a página; cards, gráficos e tabelas com barra própria só andam arrastando a barra ──
    // Regra do produto: a roda não "entra" no card (nem na vertical nem na horizontal). Ficam de fora (rolam com a roda): campos de texto,
    // listas suspensas/menus (elementos absolute/fixed, ex.: filtros) e modais. O Modo TV (html.sem-barras) não é alterado.
    document.addEventListener('wheel', function (e) {
        if (e.ctrlKey || e.shiftKey || e.defaultPrevented || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        if (document.documentElement.classList.contains('sem-barras')) return;
        var t = e.target, scrolls = [];
        if (!t || t.nodeType !== 1) return;
        if (t.closest('textarea,input,select,[contenteditable],[data-roda-propria]')) return;
        for (var el = t; el && el.nodeType === 1 && el !== document.body && el !== document.documentElement; el = el.parentElement) {
            var cs = getComputedStyle(el);
            // modal / lista suspensa: elemento fixo, ou absoluto que rola sozinho OU que contém uma lista com rolagem (ex.: menus de filtro e de colunas)
            if (cs.position === 'fixed' || (cs.position === 'absolute' && (scrolls.length || /(auto|scroll)/.test(cs.overflowY)))) return;
            if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) scrolls.push(el);
        }
        if (!scrolls.length) return; // nada com barra aqui: o navegador rola a página
        var dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
        var doc = document.scrollingElement || document.documentElement, docRola = doc.scrollHeight > doc.clientHeight + 1;
        var alvo = scrolls.length > 1 ? scrolls[scrolls.length - 1] : (docRola ? doc : null);
        if (!alvo) return; // a única barra é a da área principal da tela: segue nativo
        alvo.scrollTop += dy; e.preventDefault();
    }, { passive: false });

    window.HubAparencia = { aplicar: aplicar, guardar: guardar, FONTES: Object.keys(FONTES) };
})();
