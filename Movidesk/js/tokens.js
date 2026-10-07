// Configurações → Tokens: controle central dos tokens/credenciais do Hub (somente admin).
// Servidor: /api/tokens (server/routes/tokens.js) · valores ficam criptografados no banco; sem valor lá, vale o .env.
const TK = { dados: null };
const tkEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function tkApi(caminho, metodo = 'GET', corpo) {
    const r = await fetch(`${API_BASE}${caminho}`, { method: metodo, headers: { ...authHeaders(), ...(corpo ? { 'Content-Type': 'application/json' } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
    return d;
}
const TK_FONTE = {
    banco: ['Salvo no Hub', '#10b981'], ambiente: ['Vindo do .env', '#f59e0b'], nenhuma: ['Não configurado', '#ef4444'],
    ilegivel: ['Ilegível — salve de novo', '#ef4444'],
};

async function tokensCarregar() {
    const root = document.getElementById('tkRoot');
    if (!root) return;
    try { TK.dados = await tkApi('/tokens'); tkRender(); }
    catch (e) { root.innerHTML = `<p class="config-status error">${tkEsc(e.message)}</p>`; }
}

function tkLinha(t) {
    const [rotFonte, cor] = TK_FONTE[t.fonte] || TK_FONTE.nenhuma;
    const id = `tk_${t.chave}`;
    const acoes = t.gerar
        ? `<button class="config-btn" type="button" onclick="tokensLinkTv()">Ver link da TV</button>
           <button class="config-btn config-btn-muted" type="button" onclick="tokensGerarTv()">Gerar nova chave</button>`
        : `<button class="config-btn" type="button" onclick="tokensSalvar('${t.chave}')">Salvar</button>
           ${t.testavel ? `<button class="config-btn config-btn-muted" type="button" onclick="tokensTestar('${t.chave}')">Testar</button>` : ''}
           ${t.fonte === 'banco' ? `<button class="config-btn config-btn-muted" type="button" onclick="tokensRemover('${t.chave}')" title="Apaga o valor salvo; volta a valer o .env, se houver">Remover</button>` : ''}`;
    return `<div style="padding:12px 0;border-top:1px solid var(--border)">
        <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b>${tkEsc(t.rotulo)}</b>
          <span style="font-size:12px;font-weight:800;color:${cor}">● ${rotFonte}</span>
          ${t.previa ? `<span style="font-size:12px;color:var(--t3)">atual: <code>${tkEsc(t.previa)}</code></span>` : ''}</div>
        <p class="config-card-help" style="margin:2px 0 8px">${tkEsc(t.ajuda)}</p>
        ${t.gerar ? '' : `<input id="${id}" class="config-input" type="${t.secreto ? 'password' : 'text'}" autocomplete="off" style="max-width:520px" placeholder="${t.secreto ? 'Cole o novo valor aqui (o atual nunca é mostrado)' : 'Valor'}" ${t.secreto ? '' : `value="${tkEsc(t.previa)}"`}>`}
        <div style="margin-top:8px">${acoes} <span id="${id}_msg" class="config-status"></span></div>
        <div id="${id}_link"></div></div>`;
}

function tkRender() {
    const grupos = {};
    TK.dados.tokens.forEach((t) => (grupos[t.grupo] = grupos[t.grupo] || []).push(t));
    document.getElementById('tkRoot').innerHTML = `
      <div class="config-card">
        <h3 class="config-card-title">Tokens e credenciais</h3>
        <p class="config-card-help">Troque aqui qualquer token do sistema, sem mexer em código nem reiniciar. Os valores ficam criptografados no banco e <b>nunca são exibidos</b> de volta — só os 4 últimos caracteres.
          Se um item não tiver valor salvo, o Hub usa o do <code>.env</code> do servidor (aparece como “Vindo do .env”). O que você salvar aqui passa a valer em até 30 segundos.</p>
        <p class="config-card-help" style="color:var(--t3)">${tkEsc(TK.dados.aviso)}</p>
      </div>` + Object.entries(grupos).map(([g, itens]) => `
      <div class="config-card"><h3 class="config-card-title">${tkEsc(g)}</h3>${itens.map(tkLinha).join('')}</div>`).join('');
}

function tkMsg(chave, texto, erro) {
    const el = document.getElementById(`tk_${chave}_msg`);
    if (el) { el.textContent = texto || ''; el.style.color = erro ? '#ef4444' : ''; }
}
async function tokensSalvar(chave) {
    const campo = document.getElementById(`tk_${chave}`);
    const valor = campo ? campo.value.trim() : '';
    if (!valor) return tkMsg(chave, 'Digite o novo valor.', true);
    tkMsg(chave, 'Salvando…');
    try { await tkApi(`/tokens/${chave}`, 'PUT', { valor }); await tokensCarregar(); tkMsg(chave, 'Salvo. Use “Testar” para conferir.'); }
    catch (e) { tkMsg(chave, e.message, true); }
}
async function tokensRemover(chave) {
    if (!confirm('Remover o valor salvo? O Hub volta a usar o do .env (se existir) e, sem ele, a função deixa de funcionar.')) return;
    try { await tkApi(`/tokens/${chave}`, 'DELETE'); await tokensCarregar(); } catch (e) { tkMsg(chave, e.message, true); }
}
async function tokensTestar(chave) {
    tkMsg(chave, 'Testando…');
    try { const r = await tkApi(`/tokens/${chave}/testar`, 'POST', {}); tkMsg(chave, (r.ok ? '✓ ' : '✗ ') + (r.mensagem || r.error || ''), !r.ok); }
    catch (e) { tkMsg(chave, e.message, true); }
}
function tkMostrarLink(chaveTv) {
    const url = `${location.origin}/pages/painel-tv.html?k=${chaveTv}`;
    document.getElementById('tk_painel_tv_chave_link').innerHTML = `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><input class="config-input" readonly style="max-width:640px" value="${tkEsc(url)}" onclick="this.select()">
        <button class="config-btn config-btn-muted" type="button" onclick="navigator.clipboard.writeText('${tkEsc(url)}').then(()=>tkMsg('painel_tv_chave','Link copiado.'))">Copiar</button></div>`;
}
async function tokensLinkTv() {
    try { tkMostrarLink((await tkApi('/geral/tv-chave')).chave); } catch (e) { tkMsg('painel_tv_chave', e.message, true); }
}
async function tokensGerarTv() {
    if (!confirm('Gerar uma nova chave? O link atual das TVs deixa de funcionar e as TVs precisam abrir o novo link.')) return;
    try { const c = (await tkApi('/geral/tv-chave', 'POST', {})).chave; await tokensCarregar(); tkMostrarLink(c); tkMsg('painel_tv_chave', 'Nova chave gerada. Atualize o link nas TVs.'); }
    catch (e) { tkMsg('painel_tv_chave', e.message, true); }
}
