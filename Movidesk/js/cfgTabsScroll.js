// ── cfgTabsScroll.js — rolagem da barra de abas de Configurações ───────────────────────────────────────────────
// A barra tem mais abas do que cabem na largura e a barra de rolagem fica escondida; em máquinas sem rolagem horizontal no mouse
// as últimas abas ficavam inalcançáveis. Aqui a barra passa a rolar por: roda do mouse (a rolagem vertical sobre ela vira horizontal),
// arrastar com o mouse/dedo, setas nas pontas (só aparecem quando há mais para ver) e centralização automática da aba ativa.
(function () {
    function iniciar() {
        const tabs = document.querySelector('.cfg-tabs');
        if (!tabs || (tabs.parentElement && tabs.parentElement.classList.contains('cfg-tabs-wrap'))) return;
        const wrap = document.createElement('div');
        wrap.className = 'cfg-tabs-wrap';
        tabs.parentNode.insertBefore(wrap, tabs);
        wrap.appendChild(tabs);
        const seta = (cls, rotulo, txt) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'cfg-tabs-seta ' + cls; b.setAttribute('aria-label', rotulo); b.textContent = txt; return b; };
        const esq = seta('esq', 'Ver abas anteriores', '‹'), dir = seta('dir', 'Ver mais abas', '›');
        wrap.appendChild(esq); wrap.appendChild(dir);

        const atualizar = () => {
            wrap.classList.toggle('tem-esq', tabs.scrollLeft > 2);
            wrap.classList.toggle('tem-dir', tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 2);
        };
        const passo = () => Math.max(160, Math.round(tabs.clientWidth * 0.6));
        esq.addEventListener('click', () => tabs.scrollBy({ left: -passo() }));
        dir.addEventListener('click', () => tabs.scrollBy({ left: passo() }));
        tabs.addEventListener('scroll', atualizar, { passive: true });

        // roda do mouse: a rolagem vertical sobre a barra anda para os lados (só quando há para onde ir)
        tabs.addEventListener('wheel', (e) => {
            if (tabs.scrollWidth <= tabs.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            const max = tabs.scrollWidth - tabs.clientWidth;
            if ((e.deltaY < 0 && tabs.scrollLeft <= 0) || (e.deltaY > 0 && tabs.scrollLeft >= max)) return;   // nas pontas deixa a página rolar
            e.preventDefault();
            tabs.scrollBy({ left: e.deltaY, behavior: 'auto' });
        }, { passive: false });

        // arrastar (mouse e toque); um arrasto de mais de 5 px não conta como clique na aba
        let x0 = 0, s0 = 0, ativo = false, moveu = false;
        tabs.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; ativo = true; moveu = false; x0 = e.clientX; s0 = tabs.scrollLeft; });
        window.addEventListener('pointermove', (e) => {
            if (!ativo) return;
            const dx = e.clientX - x0;
            if (!moveu && Math.abs(dx) > 5) { moveu = true; tabs.classList.add('arrastando'); }
            if (moveu) tabs.scrollLeft = s0 - dx;
        });
        const soltar = () => { if (!ativo) return; ativo = false; if (moveu) setTimeout(() => tabs.classList.remove('arrastando'), 0); };
        window.addEventListener('pointerup', soltar);
        window.addEventListener('pointercancel', soltar);

        // aba ativa sempre visível (inclusive quando ela é trocada por código)
        const centralizar = () => {
            const a = tabs.querySelector('.cfg-tab-active');
            if (!a || !tabs.clientWidth) return;
            const alvo = a.offsetLeft - (tabs.clientWidth - a.offsetWidth) / 2;
            tabs.scrollTo({ left: Math.max(0, alvo) });
        };
        // só reage à troca de aba (classe do botão), não às classes que a própria barra ganha ao arrastar
        try { new MutationObserver((muts) => { if (muts.some((m) => m.target.classList && m.target.classList.contains('cfg-tab-btn'))) centralizar(); }).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] }); } catch (_) { /* sem observer */ }
        try { new ResizeObserver(atualizar).observe(tabs); } catch (_) { window.addEventListener('resize', atualizar); }
        atualizar();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
