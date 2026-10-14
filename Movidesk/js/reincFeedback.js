// ── reincFeedback.js — Configurações → Feedback das reincidências (só admin) ───────────────────────────────
// Lista o que as pessoas marcaram nas Reincidências ("não procede" + o porquê; opcionalmente também os "procede"), com a foto do veredito da IA
// naquele momento. Serve de material para ajustar/treinar as análises. GET /api/reincidencias/feedback (admin).
let _rfItens = [];
const rfEsc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rfData = (d) => { try { return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch (_) { return ''; } };

async function rfCarregar() {
    const box = document.getElementById('rfLista');
    if (!box) return;
    const todos = document.getElementById('rfTodos')?.checked ? '1' : '0';
    const q = (document.getElementById('rfBusca')?.value || '').trim();
    setCfgStatus('rfStatus', 'Carregando…', '');
    try {
        const res = await fetch(`${API_BASE}/reincidencias/feedback?todos=${todos}&q=${encodeURIComponent(q)}`, { headers: authHeaders() });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Falha ao ler o feedback');
        _rfItens = d.itens || [];
        setCfgStatus('rfStatus', `${d.naoProcede} marcada(s) como "não procede" e ${d.procede} como "procede" no total · mostrando ${_rfItens.length}.`, 'ok');
        rfDesenhar();
    } catch (e) {
        setCfgStatus('rfStatus', `Erro: ${e.message}`, 'error');
        box.innerHTML = '';
    }
}

function rfDesenhar() {
    const box = document.getElementById('rfLista');
    if (!_rfItens.length) { box.innerHTML = '<p class="config-card-help" style="margin:8px 0">Nenhuma marcação ainda. Elas aparecem aqui quando alguém marca uma reincidência como "não procede" (em Reincidências → abrir a lista de chamados).</p>'; return; }
    box.innerHTML = _rfItens.map((x) => `
      <div class="rf-item" style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:0 0 10px;background:var(--bg2,transparent)">
        <div style="display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;font-size:12px;color:var(--text3,#888)">
          <b style="color:${x.procede ? '#16a34a' : '#dc2626'};font-size:12px">${x.procede ? '👍 Procede' : '👎 Não procede'}</b>
          <a href="https://viasoft.movidesk.com/Ticket/Edit/${rfEsc(x.ticket_id)}" target="_blank" rel="noopener">#${rfEsc(x.ticket_id)}</a>
          ${x.anterior_id ? `<span>← <a href="https://viasoft.movidesk.com/Ticket/Edit/${rfEsc(x.anterior_id)}" target="_blank" rel="noopener">#${rfEsc(x.anterior_id)}</a>${x.dias_entre != null ? ` (+${rfEsc(Number(x.dias_entre).toLocaleString('pt-BR', { maximumFractionDigits: 1 }))} d)` : ''}</span>` : ''}
          <span>${rfEsc(x.cliente || 'cliente não identificado')}${x.equipe ? ` · ${rfEsc(x.equipe)}` : ''}</span>
          <span style="margin-left:auto">${rfEsc(x.usuario_nome || x.usuario_email || '—')} · ${rfEsc(rfData(x.atualizado_em))}</span>
        </div>
        <div style="margin-top:6px;font-size:13px"><b>${rfEsc(x.assunto || '(sem assunto)')}</b><br><span style="color:var(--text3,#888)">anterior: ${rfEsc(x.anterior_assunto || '(sem assunto)')}</span></div>
        <div style="margin-top:8px;font-size:12.5px"><span style="color:var(--text3,#888)">O que a IA disse${x.confianca ? ` (confiança ${rfEsc(x.confianca)})` : ''}:</span> ${rfEsc(x.explicacao_ia || '—')}</div>
        ${x.comentario ? `<div style="margin-top:6px;padding:8px 10px;border-left:3px solid ${x.procede ? '#16a34a' : '#dc2626'};background:rgba(127,127,127,.08);border-radius:6px;font-size:13px"><b>${x.procede ? 'Comentário' : 'Por que não procede'}:</b> ${rfEsc(x.comentario)}</div>` : ''}
      </div>`).join('');
}

function rfExportar() {
    if (!_rfItens.length) return;
    const cols = [['atualizado_em', 'Data'], ['procede', 'Procede'], ['ticket_id', 'Chamado'], ['anterior_id', 'Chamado anterior'], ['dias_entre', 'Dias entre'], ['cliente', 'Cliente'], ['equipe', 'Equipe'],
        ['assunto', 'Assunto'], ['anterior_assunto', 'Assunto anterior'], ['confianca', 'Confiança da IA'], ['explicacao_ia', 'Explicação da IA'], ['comentario', 'Comentário'], ['usuario_nome', 'Pessoa'], ['usuario_email', 'E-mail']];
    const cel = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const linhas = [cols.map((c) => cel(c[1])).join(',')].concat(_rfItens.map((x) => cols.map(([k]) => cel(k === 'procede' ? (x.procede ? 'sim' : 'não') : x[k])).join(',')));
    const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `feedback-reincidencias-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
let _rfTimer = null;
function rfBuscaDigitou() { clearTimeout(_rfTimer); _rfTimer = setTimeout(rfCarregar, 400); }
