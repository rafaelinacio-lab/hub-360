// Ordenação por coluna em qualquer <table> com <thead>: clique no cabeçalho alterna
// crescente → decrescente → ordem original. Funciona também em tabelas redesenhadas por JS
// (a ordem escolhida é reaplicada). Para não ordenar uma tabela, use data-no-sort; cabeçalhos que
// já têm ordenação própria (th.sortable, onclick) são respeitados e ignorados.
(function () {
    if (window.__ordenarTabelas) return;
    window.__ordenarTabelas = true;

    var css = document.createElement('style');
    css.textContent =
        'th.ord-th{cursor:pointer;user-select:none;white-space:nowrap}' +
        'th.ord-th:hover{color:var(--t1,var(--text,inherit))}' +
        'th.ord-th::after{content:"↕";margin-left:6px;font-size:10px;opacity:.28}' +
        'th.ord-th[aria-sort="ascending"]::after{content:"▲";opacity:.9}' +
        'th.ord-th[aria-sort="descending"]::after{content:"▼";opacity:.9}' +
        'th.ord-th.num,th.ord-th.n{text-align:right}';
    (document.head || document.documentElement).appendChild(css);

    var UNID = '(?:%|h|hs|pp|min|m|d|dias?|dia|x)?';
    var RE_NUM = new RegExp('^[+\\-−]?#?\\s*(\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:,(\\d+))?\\s*' + UNID + '$', 'i');
    var RE_DATA = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ ,]+(\d{2}):(\d{2}))?/;

    function texto(td) {
        if (!td) return '';
        var d = td.getAttribute('data-sort');
        return (d != null ? d : td.textContent).replace(/\s+/g, ' ').trim();
    }
    function numero(t) {
        if (t === '' || t === '—' || t === '-') return null;
        var m = RE_NUM.exec(t);
        if (!m) return null;
        var v = parseFloat(m[1].replace(/\./g, '') + (m[2] ? '.' + m[2] : ''));
        return /^[\-−]/.test(t) ? -v : v;
    }
    function data(t) {
        var m = RE_DATA.exec(t);
        return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime() : null;
    }
    function ordenavel(th) {
        return th.tagName === 'TH' && th.textContent.trim() !== '' && th.colSpan === 1 &&
            !th.classList.contains('sortable') && !th.hasAttribute('onclick') && !th.hasAttribute('data-no-sort');
    }
    function marcar(root) {
        (root || document).querySelectorAll('table').forEach(function (tb) {
            if (tb.hasAttribute('data-no-sort') || !tb.tHead || !tb.tBodies.length) return;
            tb.tHead.querySelectorAll('th').forEach(function (th) {
                if (ordenavel(th)) th.classList.add('ord-th');
            });
        });
    }

    function ordenar(tb, col, dir) {
        var corpo = tb.tBodies[0];
        var linhas = Array.prototype.slice.call(corpo.rows);
        linhas.forEach(function (tr, i) { if (tr.__i0 == null) tr.__i0 = i; });
        var dados = linhas.filter(function (tr) {
            return tr.cells.length > col && !tr.classList.contains('empty-row') && !(tr.cells.length === 1 && tr.cells[0].colSpan > 1);
        });
        var fixas = linhas.filter(function (tr) { return dados.indexOf(tr) < 0; });
        if (dir === 0) {
            dados.sort(function (a, b) { return a.__i0 - b.__i0; });
        } else {
            var vals = dados.map(function (tr) { return texto(tr.cells[col]); });
            var cheios = vals.filter(function (v) { return v !== '' && v !== '—' && v !== '-'; });
            var todosNum = cheios.length > 0 && cheios.every(function (v) { return numero(v) != null; });
            var todosData = !todosNum && cheios.length > 0 && cheios.every(function (v) { return data(v) != null; });
            var chave = dados.map(function (tr, i) {
                var v = vals[i];
                var k = todosNum ? numero(v) : todosData ? data(v) : v.toLocaleLowerCase('pt-BR');
                return { tr: tr, k: k, vazio: (todosNum || todosData) ? k == null : v === '' || v === '—' || v === '-' };
            });
            var col_ = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
            chave.sort(function (a, b) {
                if (a.vazio !== b.vazio) return a.vazio ? 1 : -1;     // vazios sempre no fim
                if (a.vazio) return a.tr.__i0 - b.tr.__i0;
                var c = (todosNum || todosData) ? a.k - b.k : col_.compare(a.k, b.k);
                return c ? c * dir : a.tr.__i0 - b.tr.__i0;
            });
            dados = chave.map(function (x) { return x.tr; });
        }
        ignorar = true;
        dados.concat(fixas).forEach(function (tr) { corpo.appendChild(tr); });
        if (obs) obs.takeRecords();
        ignorar = false;
    }
    function indicar(tb, col, dir) {
        tb.tHead.querySelectorAll('th').forEach(function (th, i) {
            if (th.classList.contains('ord-th')) th.setAttribute('aria-sort', i === col && dir ? (dir > 0 ? 'ascending' : 'descending') : 'none');
        });
    }

    document.addEventListener('click', function (e) {
        var th = e.target.closest && e.target.closest('th.ord-th');
        if (!th) return;
        var tb = th.closest('table'); if (!tb || !tb.tHead) return;
        var col = th.cellIndex, est = tb.__ord || { col: -1, dir: 0 };
        var dir = est.col === col ? (est.dir === 1 ? -1 : est.dir === -1 ? 0 : 1) : 1;
        tb.__ord = { col: col, dir: dir };
        indicar(tb, col, dir);
        ordenar(tb, col, dir);
    });

    // tabelas redesenhadas por JS: marca os cabeçalhos novos e reaplica a ordem escolhida
    var ignorar = false, pend = false, obs = null;
    function varrer() {
        pend = false;
        marcar(document);
        document.querySelectorAll('table').forEach(function (tb) {
            var o = tb.__ord;
            if (!o || !o.dir || !tb.tHead || !tb.tBodies.length) return;
            var ths = tb.tHead.querySelectorAll('th');
            if (!ths[o.col] || !ths[o.col].classList.contains('ord-th')) return;
            indicar(tb, o.col, o.dir);
            var corpo = tb.tBodies[0];
            if (corpo.__ord_n !== corpo.rows.length || corpo.__ord_c !== o.col + ':' + o.dir || corpo.__sujo) { corpo.__sujo = false; ordenar(tb, o.col, o.dir); }
            corpo.__ord_n = corpo.rows.length; corpo.__ord_c = o.col + ':' + o.dir;
        });
    }
    function agendar() { if (!pend) { pend = true; requestAnimationFrame(varrer); } }
    function iniciar() {
        marcar(document);
        if (!window.MutationObserver) return;
        obs = new MutationObserver(function (ms) {
            if (ignorar) return;
            ms.forEach(function (m) {
                var tb = m.target.closest ? m.target.closest('table') : null;
                if (tb && tb.__ord && tb.tBodies[0]) tb.tBodies[0].__sujo = true;
            });
            agendar();
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
