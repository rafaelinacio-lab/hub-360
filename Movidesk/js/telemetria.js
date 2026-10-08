// ── telemetria.js — uso do Hub 360: quem, o quê, quando e quantos cliques ───
// Incluído no shell (index.html) e em cada página (pages/*.html). Envia lotes
// para POST /api/telemetria/eventos; o usuário é identificado pelo servidor
// (sessão), nunca por este script.
//
// Privacidade: registra apenas o RÓTULO de botões/links/abas (ex.: "Exportar",
// "Limpar filtros"), nunca o que foi digitado, valores de campos nem conteúdo de
// linhas/tabelas. Números longos no rótulo (ex.: nº de chamado) viram "#".
(function () {
    'use strict';
    if (window.__telemetriaAtiva) return;
    window.__telemetriaAtiva = true;

    const URL_API = `${location.origin}/api/telemetria/eventos`;
    const params = new URLSearchParams(location.search);
    const ehTopo = window.top === window;
    const arquivo = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
    const legacy = params.get('legacyView') || '';
    const pagina = legacy ? `${arquivo}:${legacy}` : arquivo;
    let abaTopo = '';                                    // definida pelo shell via Telemetria.view()

    function token() { try { return localStorage.getItem('token') || ''; } catch (_) { return ''; } }
    function sessao() {
        try {
            let s = sessionStorage.getItem('hub_tel_sessao');
            if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('hub_tel_sessao', s); }
            return s;
        } catch (_) { return 'sem-sessao'; }
    }
    function abaAtual() {
        if (abaTopo) return abaTopo;
        if (legacy) return legacy;
        try { return localStorage.getItem('activeEmbeddedView') || arquivo; } catch (_) { return arquivo; }
    }

    const fila = [];
    function registrar(ev) {
        if (!token()) return;                             // sem login (ex.: tela de login) não registra
        ev.t = Date.now();
        ev.aba = ev.aba || abaAtual();
        ev.pagina = pagina;
        fila.push(ev);
        if (fila.length >= 80) enviar();
    }
    function enviar() {
        if (!fila.length || !token()) return;
        const lote = fila.splice(0, 100);
        try {
            fetch(URL_API, {
                method: 'POST',
                keepalive: true,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ sessao: sessao(), eventos: lote }),
            }).catch(() => {});
        } catch (_) { /* telemetria nunca atrapalha a tela */ }
    }
    setInterval(enviar, 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') enviar(); });
    window.addEventListener('pagehide', enviar);

    // ── rótulo do controle clicado (sem conteúdo digitado) ──────────────────
    const ALVOS = 'button,a,[role="button"],[role="tab"],summary,label,select,canvas,'
        + 'input[type="checkbox"],input[type="radio"],input[type="button"],input[type="submit"],'
        + 'tr[onclick],.clickable,[onclick]';
    function texto(el) {
        const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
            .replace(/\s+/g, ' ').trim().replace(/\d{4,}/g, '#');
        return t.length > 0 && t.length <= 60 ? t : '';
    }
    function descrever(origem) {
        const el = origem && origem.closest ? origem.closest(ALVOS) : null;
        if (!el) return 'área da página';
        if (el.matches('canvas')) return `gráfico ${el.id || ''}`.trim();
        if (el.matches('tr,.clickable')) {
            const pai = el.closest('[id]');
            return `linha clicável${pai ? ` em #${pai.id}` : ''}`;
        }
        // campos de formulário: só o identificador (o textContent de um select lista todas as opções)
        const campo = el.matches('select,input') ? el : (el.matches('label') ? el.querySelector('select,input,textarea') : null);
        if (campo) return (campo.getAttribute('aria-label') || campo.getAttribute('title') || campo.id || campo.name || 'campo').slice(0, 80);
        return (texto(el) || el.dataset.view || el.id || (el.className && String(el.className).split(' ')[0]) || el.tagName.toLowerCase()).slice(0, 80);
    }
    document.addEventListener('click', (e) => {
        try { registrar({ tipo: 'click', alvo: descrever(e.target) }); } catch (_) { /* ignora */ }
    }, true);

    // ── tempo de uso ativo: aba visível, com foco aqui (não em iframe filho) e interação recente ──
    let ultimaInteracao = Date.now();
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((n) =>
        document.addEventListener(n, () => { ultimaInteracao = Date.now(); }, { passive: true, capture: true }));
    let ultimoMove = 0;
    document.addEventListener('mousemove', () => {
        const agora = Date.now();
        if (agora - ultimoMove > 2000) { ultimoMove = agora; ultimaInteracao = agora; }
    }, { passive: true });
    setInterval(() => {
        const foco = document.hasFocus() && !(document.activeElement && document.activeElement.tagName === 'IFRAME');
        if (document.visibilityState === 'visible' && foco && Date.now() - ultimaInteracao < 60000) {
            registrar({ tipo: 'ativo', seg: 30 });
        }
    }, 30000);

    // ── tela carregada ──────────────────────────────────────────────────────
    const aoCarregar = () => registrar({ tipo: 'pagina' });
    if (document.readyState === 'complete') aoCarregar(); else window.addEventListener('load', aoCarregar);

    // ── API usada pelo shell ao trocar de aba do menu ───────────────────────
    window.Telemetria = {
        view(aba) {
            if (!ehTopo) return;
            abaTopo = aba;
            registrar({ tipo: 'view', aba });
        },
    };
})();
