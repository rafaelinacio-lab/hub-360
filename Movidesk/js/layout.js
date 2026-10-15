// ── layout.js — layout dos cards de uma aba (ordem, largura, altura, ocultar), configurável pelo admin ─────────
// Carregado nas abas que têm cartões marcados com data-card="id" data-titulo="Nome" dentro de um contêiner (ex.: #geral-dash do Painel Geral).
//   HubLayout.iniciar('geral', '#geral-dash')   aplica o layout guardado (GET /api/layout) e, se o admin abriu a aba em modo de edição
//                                                (?editarLayout=1, vindo de Configurações → Layout das abas), liga a edição na própria tela:
//                                                arrastar para mudar a ordem, largura (1/4 … total), altura e ocultar. Salvar vale para todos.
// Sem layout salvo a aba fica exatamente como era. Contêiner vira uma grade de 60 colunas (divide certo em 1/2, 1/3, 1/4, 1/5, 1/6); as linhas antigas (.hrow) e a grade dos KPIs (.kpi-grid) passam a display:contents
// e cada cartão é um item da grade (order + grid-column). Nada do que vem do servidor é inserido como HTML: só ids de lista fechada.
(function () {
    var LS = 'hub_layout', ID_CSS = 'hub-layout-css';
    var LARG = [[10, '1/6'], [12, '1/5'], [15, '1/4'], [20, '1/3'], [24, '2/5'], [30, '1/2'], [36, '3/5'], [40, '2/3'], [48, '4/5'], [60, 'Total']];   // em 60 avos da linha
    var ALT = [['auto', 'Altura: auto'], ['p', 'Baixa'], ['m', 'Média'], ['g', 'Alta']];
    var estado = { aba: null, raiz: null, salvo: null, editando: false, ed: null, arrastando: null };

    function css() {
        if (document.getElementById(ID_CSS)) return;
        var s = document.createElement('style'); s.id = ID_CSS;
        s.textContent =
            '.hub-layout{display:grid!important;grid-template-columns:repeat(60,minmax(0,1fr));column-gap:0;row-gap:14px;align-items:stretch;width:auto!important;margin-left:-7px!important;margin-right:-7px!important}' +   // sem gap de coluna (60 colunas de gap estourariam telas estreitas): o respiro vem da margem de 7px de cada card
            'html .hub-layout.hub-layout.hub-layout .kpi-grid.k9{display:contents}' +      // os KPIs viram cards soltos da grade (mais específico que o .kpi-grid do v2.css)
            'html .hub-layout .hrow:not([style*="none"]){display:contents}' +   // mais específico que html[data-ui=v2] .hrow; linha escondida por style=display:none continua escondida
            
            '.hub-layout>:not([data-card]):not(.hrow){grid-column:1/-1;order:-1}' +
            '.hub-layout [data-card]{margin:0 7px!important;min-width:0}' +
            '.hub-layout [data-card].hub-h-p{max-height:260px;overflow:auto}' +
            '.hub-layout [data-card].hub-h-m{max-height:420px;overflow:auto}' +
            '.hub-layout [data-card].hub-h-g{max-height:640px;overflow:auto}' +
            '.hub-layout [data-card].hub-oculto{display:none!important}' +
            '@media (max-width:1000px){.hub-layout [data-card]:not([data-card^="kpi-"]){grid-column:1/-1!important}.hub-layout [data-card^="kpi-"]{grid-column:span 20!important}}' +
            '@media (max-width:700px){.hub-layout [data-card^="kpi-"]{grid-column:span 30!important}.hub-layout [data-card="kpi-sla"]{grid-column:1/-1!important}}' +
            '@media (max-width:460px){.hub-layout [data-card^="kpi-"]{grid-column:1/-1!important}}' +
            'body.hub-editando .hub-layout [data-card].hub-oculto{display:block!important;opacity:.4;outline:2px dashed var(--border-hi,#999)}' +
            'body.hub-editando .hub-layout [data-card]{position:relative;outline:1px dashed var(--border-hi,#aaa);outline-offset:-1px}' +
            '.hub-ed{position:relative;z-index:20;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 10px;' +
            'background:var(--surface-mid,#f3f3f3);color:var(--t1,#222);border:1px solid var(--border-hi,#bbb);border-radius:10px;padding:5px 8px;font:600 12px system-ui,sans-serif}' +
            '.hub-ed button,.hub-ed select{font:inherit;font-size:12px;border:1px solid var(--border,#ccc);background:var(--surface-mid,#f6f6f6);color:inherit;border-radius:7px;padding:3px 7px;cursor:pointer}' +
            '.hub-ed .hub-nome{flex:1;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t2,#555);padding:0 4px}' +
            '[data-card].hub-arrastando{opacity:.35}' +
            '[data-card].hub-alvo-antes{box-shadow:inset 6px 0 0 var(--orange,#e85d04)}' +
            '[data-card].hub-alvo-depois{box-shadow:inset -6px 0 0 var(--orange,#e85d04)}' +
            '.hub-barra{position:sticky;top:0;z-index:60;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:var(--orange,#e85d04);color:#fff;font:600 13px system-ui,sans-serif}' +
            '.hub-barra span{flex:1;min-width:240px;font-weight:500}.hub-barra button{font:inherit;font-weight:700;border:0;border-radius:8px;padding:6px 14px;cursor:pointer;background:#fff;color:#222}' +
            '.hub-barra button.sec{background:rgba(255,255,255,.22);color:#fff}';
        document.head.appendChild(s);
    }

    function lerLS() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (_) { return {}; } }
    function gravarLS(v) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch (_) { /* sem armazenamento */ } }
    function tok() { return localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('sessionToken') || ''; }
    function cartoes() { return estado.raiz ? Array.prototype.slice.call(estado.raiz.querySelectorAll('[data-card]')) : []; }
    function idDe(el) { return el.getAttribute('data-card'); }

    // largura padrão = como a linha antiga (.hrow c-N) dividia: 1 cartão = total, 2 = 1/2, 3 = 1/3
    function larguraPadrao(el) {
        var id = idDe(el);
        if (id === 'kpi-sla') return 24;               // o SLA ocupa 2 de 5, como no padrão (5 por linha; 9 KPIs + o SLA dobrado = 2 linhas de 5)
        if (/^kpi-/.test(id)) return 12;
        var linha = el.parentElement, n = linha && /\bhrow\b/.test(linha.className) ? linha.querySelectorAll(':scope > [data-card]').length : 1;
        return n >= 4 ? 15 : n === 3 ? 20 : n === 2 ? 30 : 60;
    }
    // largura guardada em 60 avos (w); layouts antigos guardavam em 12 avos (l) e são convertidos
    function largura(c, el) { return c.w || (c.l ? c.l * 5 : larguraPadrao(el)); }
    function vazio(l) { return !l || (!(l.ordem && l.ordem.length) && !(l.cartoes && Object.keys(l.cartoes).length)); }

    function limpar() {
        if (!estado.raiz) return;
        estado.raiz.classList.remove('hub-layout');
        cartoes().forEach(function (el) { el.style.order = ''; el.style.gridColumn = ''; el.classList.remove('hub-h-p', 'hub-h-m', 'hub-h-g', 'hub-oculto'); });
    }

    // layout = { ordem:[ids], cartoes:{id:{l,h,o}} }
    function aplicar(layout) {
        if (!estado.raiz) return;
        if (vazio(layout) && !estado.editando) { limpar(); return; }
        layout = layout || { ordem: [], cartoes: {} };
        var els = cartoes(), porId = {}; els.forEach(function (e) { porId[idDe(e)] = e; });
        var seq = (layout.ordem || []).filter(function (id) { return porId[id]; });
        // card que não está na ordem salva (novo, ou antes agrupado em outro id, como os KPIs) entra logo depois do card que o precede na página, não no fim
        els.forEach(function (e, i) {
            var id = idDe(e); if (seq.indexOf(id) >= 0) return;
            var prev = i ? seq.indexOf(idDe(els[i - 1])) : -1;
            seq.splice(prev + 1, 0, id);
        });
        estado.raiz.classList.add('hub-layout');
        seq.forEach(function (id, i) {
            var el = porId[id], c = (layout.cartoes || {})[id] || {};
            el.style.order = String(i);
            el.style.gridColumn = 'span ' + largura(c, el);
            el.classList.toggle('hub-h-p', c.h === 'p'); el.classList.toggle('hub-h-m', c.h === 'm'); el.classList.toggle('hub-h-g', c.h === 'g');
            el.classList.toggle('hub-oculto', c.o === true);
        });
    }

    // ── edição ──
    function ordemAtual() {
        return cartoes().sort(function (a, b) { return (parseInt(a.style.order, 10) || 0) - (parseInt(b.style.order, 10) || 0); }).map(idDe);
    }
    function copiar(l) { return JSON.parse(JSON.stringify(l || { ordem: [], cartoes: {} })); }
    function cfgCartao(id) { var c = estado.ed.cartoes[id] || (estado.ed.cartoes[id] = {}); return c; }

    function mover(id, alvoId, antes) {
        var o = estado.ed.ordem.filter(function (x) { return x !== id; });
        var i = o.indexOf(alvoId); if (i < 0) o.push(id); else o.splice(antes ? i : i + 1, 0, id);
        estado.ed.ordem = o; aplicar(estado.ed);
    }
    function limparAlvos() { cartoes().forEach(function (e) { e.classList.remove('hub-alvo-antes', 'hub-alvo-depois'); }); }

    function controles(el) {
        var id = idDe(el), cfg = function () { return estado.ed.cartoes[id] || {}; };
        var box = document.createElement('div'); box.className = 'hub-ed';
        var nome = document.createElement('span'); nome.className = 'hub-nome'; nome.textContent = el.getAttribute('data-titulo') || id; nome.title = nome.textContent; box.appendChild(nome);
        var mv = document.createElement('span'); mv.className = 'hub-mover'; mv.setAttribute('role', 'button'); mv.draggable = true; mv.textContent = '⠿ Mover'; mv.title = 'Arraste para mudar a posição';
        mv.style.cssText = 'cursor:grab;border:1px solid var(--border,#ccc);background:var(--surface-mid,#f6f6f6);border-radius:7px;padding:3px 7px;user-select:none';
        mv.addEventListener('dragstart', function (e) {
            estado.arrastando = id; el.classList.add('hub-arrastando');
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); e.dataTransfer.setDragImage(el, 20, 20); } catch (_) { /* navegador sem dataTransfer */ }
        });
        mv.addEventListener('dragend', function () { el.classList.remove('hub-arrastando'); estado.arrastando = null; limparAlvos(); });
        box.appendChild(mv);
        {
            var sl = document.createElement('select'); sl.title = 'Largura'; sl.setAttribute('aria-label', 'Largura do card');
            LARG.forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = 'Largura: ' + p[1]; sl.appendChild(o); });
            sl.value = String(largura(cfg(), el));
            sl.addEventListener('change', function () { var c = cfgCartao(id); delete c.l; c.w = Number(sl.value); aplicar(estado.ed); });
            box.appendChild(sl);
        }
        var ehKpi = /^kpi-/.test(id);
        var sh = document.createElement('select'); sh.title = 'Altura'; sh.setAttribute('aria-label', 'Altura do card');
        ALT.forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[0] === 'auto' ? p[1] : 'Altura: ' + p[1]; sh.appendChild(o); });
        sh.value = cfg().h || 'auto';
        sh.addEventListener('change', function () { var c = cfgCartao(id); if (sh.value === 'auto') delete c.h; else c.h = sh.value; aplicar(estado.ed); });
        if (!ehKpi) box.appendChild(sh);   // KPI tem altura fixa (todos da linha iguais)
        var oc = document.createElement('button'); oc.type = 'button';
        var rot = function () { oc.textContent = cfg().o ? 'Mostrar' : 'Ocultar'; };
        oc.addEventListener('click', function () { var c = cfgCartao(id); if (c.o) delete c.o; else c.o = true; rot(); aplicar(estado.ed); });
        rot(); box.appendChild(oc);
        el.insertBefore(box, el.firstChild);
        el.addEventListener('dragover', function (e) {
            if (!estado.arrastando || estado.arrastando === id) return;
            e.preventDefault(); limparAlvos();
            var r = el.getBoundingClientRect(), larg = r.width > (estado.raiz.clientWidth * 0.8);
            var antes = larg ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
            el.classList.add(antes ? 'hub-alvo-antes' : 'hub-alvo-depois'); el._hubAntes = antes;
        });
        el.addEventListener('drop', function (e) {
            if (!estado.arrastando || estado.arrastando === id) return;
            e.preventDefault(); var antes = el._hubAntes !== false; limparAlvos(); mover(estado.arrastando, id, antes);
        });
    }

    function barra() {
        var b = document.createElement('div'); b.className = 'hub-barra'; b.id = 'hub-barra';
        var t = document.createElement('span');
        t.textContent = 'Editando o layout desta aba: arraste pelo “⠿ Mover”, escolha largura e altura de cada card ou oculte o que não quer ver. Vale para todos os usuários depois de salvar. Cards de visões específicas só aparecem quando você troca de visão.';
        b.appendChild(t);
        [['Salvar', salvar, ''], ['Cancelar', function () { sair(true); }, 'sec'], ['Restaurar padrão', restaurar, 'sec']].forEach(function (x) {
            var bt = document.createElement('button'); bt.type = 'button'; bt.textContent = x[0]; if (x[2]) bt.className = x[2]; bt.addEventListener('click', x[1]); b.appendChild(bt);
        });
        document.body.insertBefore(b, document.body.firstChild);
    }

    function aviso(msg) {
        var t = document.getElementById('hub-barra'); if (!t) return;
        t.firstChild.textContent = msg;
    }

    function entrarEdicao() {
        estado.editando = true; estado.ed = copiar(estado.salvo); estado.ed.ordem = ordemAtual();
        if (!estado.raiz.classList.contains('hub-layout')) aplicar(estado.ed);   // sem layout salvo: monta a grade com os padrões
        document.body.classList.add('hub-editando');
        aplicar(estado.ed); barra(); cartoes().forEach(controles);
    }

    function sair(descartar) {
        estado.editando = false; estado.ed = null; document.body.classList.remove('hub-editando');
        var b = document.getElementById('hub-barra'); if (b) b.remove();
        cartoes().forEach(function (el) { Array.prototype.slice.call(el.querySelectorAll(':scope > .hub-ed')).forEach(function (x) { x.remove(); }); });
        try { history.replaceState(null, '', location.pathname); } catch (_) { /* sem history */ }
        if (descartar) aplicar(estado.salvo);
    }

    function enviar(layout) {
        return fetch('/api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: JSON.stringify({ aba: estado.aba, layout: layout }) })
            .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Falha ao salvar'); return d; }); });
    }
    function salvar() {
        var l = { ordem: estado.ed.ordem.slice(), cartoes: estado.ed.cartoes };
        aviso('Salvando…');
        enviar(l).then(function (todos) {
            gravarLS(todos); estado.salvo = todos[estado.aba] || null; sair(false); aplicar(estado.salvo);
        }).catch(function (e) { aviso('Erro ao salvar: ' + e.message); });
    }
    function restaurar() {
        if (!window.confirm('Voltar esta aba ao layout padrão para todos os usuários?')) return;
        aviso('Restaurando…');
        enviar({}).then(function (todos) { gravarLS(todos); estado.salvo = null; sair(false); limpar(); })
            .catch(function (e) { aviso('Erro ao restaurar: ' + e.message); });
    }

    function ehAdmin() {
        return fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + tok() }, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
            .then(function (m) { return !!m && m.role === 'admin'; }).catch(function () { return false; });
    }

    function iniciar(aba, seletor) {
        function go() {
            estado.aba = aba; estado.raiz = document.querySelector(seletor); if (!estado.raiz) return;
            css();
            estado.salvo = lerLS()[aba] || null; aplicar(estado.salvo);          // do navegador, sem piscar
            fetch('/api/layout', { headers: { Authorization: 'Bearer ' + tok() }, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (todos) {
                if (!todos) return;
                var novo = todos[aba] || null;
                if (JSON.stringify(novo) !== JSON.stringify(estado.salvo) && !estado.editando) { estado.salvo = novo; aplicar(novo); }
                gravarLS(todos);
            }).catch(function () { /* mantém o do navegador */ });
            if (/[?&]editarLayout=1\b/.test(location.search)) ehAdmin().then(function (ok) { if (ok) entrarEdicao(); });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    }
    window.HubLayout = { iniciar: iniciar };
})();
