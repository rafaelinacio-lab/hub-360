// Dashboard → "Conferir com o Movidesk": compara os chamados mostrados com o status real e, se a pessoa quiser,
// corrige o banco. Cobre o caso de chamados encerrados no Movidesk que o cron nunca mais trouxe.
(function () {
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const MOTIVO = { encerrado: 'encerrado no Movidesk', status: 'status diferente', equipe: 'equipe diferente', nao_encontrado: 'não encontrado no Movidesk' };

    function painel() {
        let el = document.getElementById('confPainel');
        if (!el) {
            el = document.createElement('div'); el.id = 'confPainel'; el.setAttribute('role', 'status');
            const ref = document.getElementById('cardsContainer') || document.getElementById('btnConferir');
            ref.parentNode.insertBefore(el, ref);
        }
        return el;
    }
    async function chamar(aplicar) {
        const ids = (window._cachedTickets || (typeof _cachedTickets !== 'undefined' ? _cachedTickets : [])).map((t) => t.id).filter(Boolean);
        const r = await fetch(`${API_BASE}/dashboard-conferencia`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, aplicar }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
        return d;
    }
    const MOTIVO_FALTA = { nao_carregado: 'ainda não está no banco (o cron não trouxe)', sem_classificacao: 'sem Classificação de Ticket', outra_classificacao: 'classificação diferente de Suporte Técnico', status_antigo: 'status desatualizado no banco', outro: 'motivo não identificado' };
    function tabelaResumo(r) {
        if (!r) return '';
        const sts = [...new Set([...Object.keys(r.movidesk.porStatus), ...Object.keys(r.painel.porStatus)])].sort();
        return `<table style="border-collapse:collapse;margin:6px 0;font-size:12.5px"><thead><tr><th style="text-align:left;padding:2px 14px 2px 0">Status</th><th style="padding:2px 10px">Movidesk</th><th style="padding:2px 10px">Painel</th></tr></thead><tbody>${sts.map((k) => {
            const a = r.movidesk.porStatus[k] || 0, b = r.painel.porStatus[k] || 0;
            return `<tr style="${a !== b ? 'color:#b45309;font-weight:600' : ''}"><td style="padding:2px 14px 2px 0">${esc(k)}</td><td style="text-align:center">${a}</td><td style="text-align:center">${b}</td></tr>`;
        }).join('')}<tr style="border-top:1px solid var(--border);font-weight:700"><td style="padding:2px 14px 2px 0">Total</td><td style="text-align:center">${r.movidesk.total}</td><td style="text-align:center">${r.painel.total}</td></tr></tbody></table><div style="font-size:11.5px;opacity:.7">Equipe conferida: ${esc(r.equipe)}</div>`;
    }
    function blocoFaltando(d) {
        if (!d.faltando || !d.faltando.length) return '';
        return `<h4 style="margin-top:10px">${d.faltando.length} chamado(s) abertos no Movidesk que o painel não mostra</h4><div class="conf-lista">${d.faltando.map((x) => `<div class="conf-lin"><strong>#${x.id}</strong><span title="${esc(x.assunto)}">${esc((x.assunto || '').slice(0, 70))} <em>— ${MOTIVO_FALTA[x.motivo] || x.motivo}${x.classificacao ? ` (${esc(x.classificacao)})` : ''}</em></span><span class="de-para">${esc(x.status)}</span></div>`).join('')}</div>`;
    }
    function mostrar(d, aplicado) {
        const el = painel(); const n = d.divergencias.length;
        const falhas = d.falhas.length ? `<div style="color:#b45309">Não consegui consultar ${d.falhas.length} chamado(s): ${d.falhas.slice(0, 5).map((f) => `#${f.id}`).join(', ')}${d.falhas.length > 5 ? '…' : ''}.</div>` : '';
        if (aplicado) {
            el.className = 'conf-painel ok';
            el.innerHTML = `<h4>Banco corrigido</h4><div>${d.aplicados} chamado(s) atualizado(s) a partir do Movidesk. O painel já foi recarregado.</div>${falhas}<div class="conf-acoes"><button type="button" class="tk-conferir" data-fechar>Fechar</button></div>`;
        } else if (!n) {
            el.className = 'conf-painel ok';
            el.innerHTML = `<h4>${(d.faltando || []).length ? 'Status conferidos, mas faltam chamados' : 'Tudo certo'}</h4><div>${d.verificados} chamado(s) conferidos: o status no painel é o mesmo do Movidesk.</div>${tabelaResumo(d.resumo)}${blocoFaltando(d)}${falhas}<div class="conf-acoes"><button type="button" class="tk-conferir" data-fechar>Fechar</button></div>`;
        } else {
            el.className = 'conf-painel dif';
            el.innerHTML = `<h4>${n} de ${d.verificados} chamado(s) diferentes do Movidesk</h4>
              <div class="conf-lista">${d.divergencias.map((x) => `<div class="conf-lin"><strong>#${x.id}</strong><span title="${esc(x.assunto)}">${esc((x.assunto || '').slice(0, 70))} <em>— ${MOTIVO[x.motivo] || x.motivo}</em></span>
                <span class="de-para">${esc(x.banco.status || '—')} → ${esc(x.movidesk ? x.movidesk.status : '—')}</span></div>`).join('')}</div>${tabelaResumo(d.resumo)}${blocoFaltando(d)}${falhas}
              <div class="conf-acoes"><button type="button" class="tk-conferir" data-aplicar>Corrigir o painel (${d.divergencias.filter((x) => x.movidesk).length})</button><button type="button" class="tk-conferir" data-fechar>Fechar</button></div>`;
        }
    }
    async function executar(aplicar) {
        const b = document.getElementById('btnConferir'); const t = b.textContent;
        b.disabled = true; b.textContent = 'Conferindo…';
        try {
            const d = await chamar(aplicar);
            mostrar(d, aplicar);
            if (aplicar && typeof fetchOpenTickets === 'function') await fetchOpenTickets();
        } catch (e) { const el = painel(); el.className = 'conf-painel dif'; el.innerHTML = `<h4>Não foi possível conferir</h4><div>${esc(e.message)}</div><div class="conf-acoes"><button type="button" class="tk-conferir" data-fechar>Fechar</button></div>`; }
        b.disabled = false; b.textContent = t;
    }
    document.addEventListener('click', (e) => {
        if (e.target.closest('#btnConferir')) return executar(false);
        const p = e.target.closest('#confPainel'); if (!p) return;
        if (e.target.closest('[data-aplicar]')) { if (confirm('Atualizar no banco o status destes chamados com o que está no Movidesk?')) executar(true); }
        if (e.target.closest('[data-fechar]')) p.remove();
    });
})();
