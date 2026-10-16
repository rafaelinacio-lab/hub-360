// Exportação de dados dos painéis (CSV, XLSX, PDF): só para admin e para quem tem a vertical "Sistemas Internos" em Pessoas.
// Carregado no <head> das abas que exportam. Os botões ficam ESCONDIDOS até confirmar a permissão (sem piscar) e as funções de
// exportação viram "não faz nada" para quem não pode — assim nem um botão esquecido nem o console exportam.
// Observação: é controle de tela. Os dados exibidos continuam os mesmos que a pessoa já enxerga no painel.
(function () {
    var BOTOES = [
        '[onclick*="openExportModal"]', '[onclick*="exportarCsv"]', '[onclick*="ddCsv"]', '[onclick*="exportCuradoriaCsv"]',
        '[onclick*="exportOwnerReportPdf"]', '[onclick*="exportAllOwnersPdf"]', '#detail-modal-export', '#risco-modal-export', '#export-modal', '.so-exportar'
    ];
    var FUNCOES = ['openExportModal', 'runExport', 'exportXlsx', 'exportarCsv', 'ddCsv', 'exportCuradoriaCsv', 'exportOwnerReportPdf', 'exportAllOwnersPdf'];
    var norm = function (t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase(); };
    var html = document.documentElement, pode = false;

    var st = document.createElement('style');
    st.textContent = 'html:not(.pode-exportar) ' + BOTOES.join(',html:not(.pode-exportar) ') + '{display:none!important}';
    (document.head || html).appendChild(st);

    function permitido(u) {
        if (!u) return false;
        if (norm(u.role) === 'admin') return true;
        return String(u.vertical || '').split(/[;,]/).some(function (v) { return norm(v) === 'sistemas internos'; });
    }
    function aplicar(u) {
        pode = permitido(u);
        html.classList.toggle('pode-exportar', pode);
        try { sessionStorage.setItem('hub_pode_exportar', pode ? '1' : '0'); } catch (e) { /* sem storage: segue */ }
    }
    try { if (sessionStorage.getItem('hub_pode_exportar') === '1') html.classList.add('pode-exportar'), pode = true; } catch (e) { /* nada */ }

    // Guarda as funções quando a página terminar de definir (as páginas as declaram em <script> próprio).
    function guardar() {
        FUNCOES.forEach(function (n) {
            var f = window[n];
            if (typeof f !== 'function' || f.__guardada) return;
            var g = function () { if (!pode) return undefined; return f.apply(this, arguments); };
            g.__guardada = true; window[n] = g;
        });
    }
    document.addEventListener('DOMContentLoaded', guardar);
    window.addEventListener('load', guardar);

    var token = ''; try { token = localStorage.getItem('token') || ''; } catch (e) { /* nada */ }
    if (!token) return;   // sem login (ex.: Painel TV público): fica escondido
    fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (u) { aplicar(u); })
        .catch(function () { /* falhou: mantém o estado atual (escondido, se nunca confirmou) */ });
})();
