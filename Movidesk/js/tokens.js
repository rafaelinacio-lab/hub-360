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
        ? `<button class="config-btn" type="button" onclick="tokensVerChave('${t.chave}')">${t.tipoGerar === 'tv' ? 'Ver link da TV' : 'Ver chave'}</button>
           <button class="config-btn config-btn-muted" type="button" onclick="tokensGerarChave('${t.chave}')">Gerar nova chave</button>`
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
function tkMostrarChave(t, chave) {
    const el = document.getElementById(`tk_${t.chave}_link`);
    const valor = t.tipoGerar === 'tv' ? `${location.origin}/pages/painel-tv.html?k=${chave}` : chave;
    const dica = t.tipoGerar === 'extrator' ? `<p class="config-card-help">No <code>Jira/.env</code> do servidor: <code>HUB_URL=${tkEsc(location.origin)}</code> e <code>HUB_EXTRATOR_KEY=${tkEsc(chave)}</code>. O extrator passa a buscar o endereço, e-mail e token do Jira daqui.</p>` : '';
    el.innerHTML = `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><input class="config-input" readonly style="max-width:640px" value="${tkEsc(valor)}" onclick="this.select()">
        <button class="config-btn config-btn-muted" type="button" onclick="navigator.clipboard.writeText(this.previousElementSibling.value).then(()=>tkMsg('${t.chave}','Copiado.'))">Copiar</button></div>${dica}`;
}
const tkItem = (chave) => TK.dados.tokens.find((x) => x.chave === chave);
async function tokensVerChave(chave) {
    const t = tkItem(chave);
    try { tkMostrarChave(t, (await tkApi(t.rota)).chave); } catch (e) { tkMsg(chave, e.message, true); }
}
async function tokensGerarChave(chave) {
    const t = tkItem(chave);
    if (!confirm(t.tipoGerar === 'tv' ? 'Gerar uma nova chave? O link atual das TVs deixa de funcionar e as TVs precisam abrir o novo link.' : 'Gerar uma nova chave? O extrator do Jira deixa de funcionar até você atualizar o HUB_EXTRATOR_KEY no Jira/.env.')) return;
    try { const c = (await tkApi(t.rota, 'POST', {})).chave; await tokensCarregar(); tkMostrarChave(t, c); tkMsg(chave, 'Nova chave gerada.'); }
    catch (e) { tkMsg(chave, e.message, true); }
}
