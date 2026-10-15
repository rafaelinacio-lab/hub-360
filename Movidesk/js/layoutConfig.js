// ── layoutConfig.js — Configurações → Layout das abas (só admin) ─────────────────────────────────────────────
// Lista as abas cujo layout dos cards pode ser mudado e abre cada uma em modo de edição (arrastar, largura, altura, ocultar), feito por js/layout.js
// dentro da própria aba. GET/PUT /api/layout. Para ligar outra aba: marcar os cards com data-card, chamar HubLayout.iniciar na aba, incluir
// a aba em ABAS de server/routes/layout.js e na lista abaixo.
const LAYOUT_ABAS = [{ aba: 'geral', view: 'movidesk', rotulo: 'Painel Geral' }];

async function layoutCfgCarregar() {
    const el = document.getElementById('layoutLista'); if (!el) return;
    setCfgStatus('layoutStatus', 'Carregando…', '');
    try {
        const tok = localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('sessionToken') || '';
        const r = await fetch('/api/layout', { headers: { Authorization: `Bearer ${tok}` }, cache: 'no-store' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Falha ao ler o layout');
        el.innerHTML = LAYOUT_ABAS.map((a) => {
            const l = d[a.aba], n = l ? Object.keys(l.cartoes || {}).length : 0;
            const estado = l ? `Personalizado${n ? ` (${n} card${n === 1 ? '' : 's'} com tamanho/ocultar ajustado${n === 1 ? '' : 's'})` : ' (ordem alterada)'}` : 'Layout padrão';
            return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border,#e5e3de);flex-wrap:wrap">
                <div style="flex:1;min-width:200px"><b>${a.rotulo}</b><div class="config-card-help" style="margin:2px 0 0">${estado}</div></div>
                <button class="config-btn" type="button" onclick="layoutCfgEditar('${a.aba}')">Editar layout</button>
                <button class="config-btn config-btn-muted" type="button" onclick="layoutCfgRestaurar('${a.aba}')" ${l ? '' : 'disabled'}>Restaurar padrão</button>
            </div>`;
        }).join('');
        setCfgStatus('layoutStatus', '', '');
    } catch (e) { setCfgStatus('layoutStatus', `Erro: ${e.message}`, 'error'); }
}

function layoutCfgEditar(aba) {
    const a = LAYOUT_ABAS.find((x) => x.aba === aba); if (!a) return;
    const top = window.top || window;
    if (typeof top.hubEditarLayout === 'function') top.hubEditarLayout(a.view);
    else setCfgStatus('layoutStatus', 'Abra a aba pelo menu e use o modo de edição por lá.', 'error');
}

async function layoutCfgRestaurar(aba) {
    if (!confirm('Voltar esta aba ao layout padrão para todos os usuários?')) return;
    try {
        const tok = localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('sessionToken') || '';
        const r = await fetch('/api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ aba, layout: {} }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Falha ao restaurar');
        try { localStorage.setItem('hub_layout', JSON.stringify(d)); } catch (_) { /* sem armazenamento */ }
        layoutCfgCarregar();
    } catch (e) { setCfgStatus('layoutStatus', `Erro: ${e.message}`, 'error'); }
}
