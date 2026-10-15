// ── aparenciaConfig.js — Configurações → Aparência (só admin) ────────────────────────────────────────────
// Cor de destaque, tema padrão, fonte, cantos, escala da interface e menu (ordem/visibilidade) para o sistema inteiro, sem mexer em código.
// Cada mudança é pré-visualizada na hora (nesta tela); "Salvar" grava no servidor e as outras telas abertas atualizam sozinhas.
// GET/PUT /api/aparencia — a aplicação em si é feita por js/aparencia.js.
const AP_PADRAO = { cor: '', temaPadrao: '', fonte: 'manrope', escala: 100, raio: 'redondo', menu: [] };
const AP_CORES = [['#ff8a2b', 'Laranja (padrão)'], ['#2563eb', 'Azul'], ['#7c3aed', 'Roxo'], ['#16a34a', 'Verde'], ['#0891b2', 'Ciano'], ['#db2777', 'Rosa'], ['#dc2626', 'Vermelho'], ['#475569', 'Grafite']];
const AP_ABAS = { inicio: 'Início', dashboard: 'Dashboard', movidesk: 'Painel Geral', incidentes: 'Incidentes', reincidencias: 'Reincidências', chamados: 'Chamados', ouvidoria: 'Ouvidoria', gcc: 'GCC', melhorias: 'Melhorias', jira: 'Jira', configuracoes: 'Configurações' };
let _ap = JSON.parse(JSON.stringify(AP_PADRAO)), _apSalvo = null;

const apEsc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function apRotuloAba(v) {   // o nome que está no menu de verdade (o shell fica na janela de cima); senão, o nome fixo
    try {
        const b = window.top.document.querySelector(`.topbar-nav .sidebar-btn[data-view="${v}"] .sidebar-btn-label`);
        if (b && b.textContent.trim()) return b.textContent.trim();
    } catch (_) { /* outra origem: usa o fixo */ }
    return AP_ABAS[v] || v;
}

async function apCarregar() {
    setCfgStatus('apStatus', 'Carregando…', '');
    try {
        const res = await fetch('/api/aparencia', { cache: 'no-store' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Falha ao ler a aparência');
        _ap = d; _apSalvo = JSON.stringify(d);
        apDesenhar();
        setCfgStatus('apStatus', '', '');
    } catch (e) { setCfgStatus('apStatus', `Erro: ${e.message}`, 'error'); }
}

function apPrever() {
    if (window.HubAparencia) window.HubAparencia.aplicar(_ap);
    const alterado = JSON.stringify(_ap) !== _apSalvo;
    setCfgStatus('apStatus', alterado ? 'Pré-visualização: ainda não salva. Clique em "Salvar" para valer para todo mundo.' : '', alterado ? '' : '');
}

function apDesenhar() {
    const el = document.getElementById('apForm');
    if (!el) return;
    const cor = _ap.cor || '';
    el.innerHTML = `
      <div class="config-form-stack">
        <label class="config-card-help" style="margin:0">Cor de destaque</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          ${AP_CORES.map(([c, n]) => `<button type="button" title="${apEsc(n)}" aria-label="${apEsc(n)}" onclick="apCor('${c}')" style="width:30px;height:30px;border-radius:50%;border:3px solid ${(cor || '#ff8a2b') === c ? 'var(--text,#111)' : 'transparent'};background:${c};cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,.15)"></button>`).join('')}
          <input type="color" id="apCorLivre" value="${cor || '#ff8a2b'}" title="Outra cor" style="width:38px;height:32px;border:none;background:none;padding:0;cursor:pointer" oninput="apCor(this.value)">
          <button type="button" class="config-btn config-btn-muted" onclick="apCor('')">Padrão</button>
        </div>
        <label class="config-card-help" for="apTema" style="margin:10px 0 0">Tema padrão <span style="opacity:.7">(vale só para quem ainda não escolheu claro/escuro)</span></label>
        <select id="apTema" class="config-input" onchange="apSet('temaPadrao',this.value)">
          <option value="">Seguir a escolha de cada pessoa</option><option value="claro">Claro</option><option value="escuro">Escuro</option></select>
        <label class="config-card-help" for="apFonte" style="margin:10px 0 0">Fonte</label>
        <select id="apFonte" class="config-input" onchange="apSet('fonte',this.value)">
          <option value="manrope">Manrope (padrão)</option><option value="inter">Inter</option><option value="roboto">Roboto</option><option value="poppins">Poppins</option><option value="sistema">Fonte do sistema</option></select>
        <label class="config-card-help" for="apRaio" style="margin:10px 0 0">Cantos dos cartões e janelas</label>
        <select id="apRaio" class="config-input" onchange="apSet('raio',this.value)">
          <option value="redondo">Arredondados (padrão)</option><option value="medio">Médios</option><option value="reto">Retos</option></select>
        <label class="config-card-help" for="apEscala" style="margin:10px 0 0">Tamanho da interface <span style="opacity:.7">(zoom do sistema inteiro; ótimo para telas grandes ou pequenas)</span></label>
        <select id="apEscala" class="config-input" onchange="apSet('escala',Number(this.value))">
          ${[85, 90, 95, 100, 105, 110, 115].map((n) => `<option value="${n}">${n}%${n === 100 ? ' (padrão)' : ''}</option>`).join('')}</select>
        <label class="config-card-help" style="margin:14px 0 4px">Menu: ordem e quais abas aparecem <span style="opacity:.7">(isso vale para todos; o acesso por perfil continua em Configurações → Acesso)</span></label>
        <div id="apMenu" style="display:flex;flex-direction:column;gap:6px;max-width:420px">
          ${(_ap.menu || []).map((m, i) => `
            <div style="display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:8px;padding:6px 10px;background:var(--bg2,transparent)">
              <input type="checkbox" ${m.on !== false ? 'checked' : ''} ${m.v === 'configuracoes' ? 'disabled title="Configurações não pode ser escondida"' : ''} onchange="apMenuVisivel(${i},this.checked)" aria-label="Mostrar ${apEsc(apRotuloAba(m.v))}">
              <span style="flex:1;font-size:13px">${apEsc(apRotuloAba(m.v))}</span>
              <button type="button" class="config-btn config-btn-muted" style="padding:2px 9px" ${i === 0 ? 'disabled' : ''} onclick="apMenuMover(${i},-1)" aria-label="Subir">↑</button>
              <button type="button" class="config-btn config-btn-muted" style="padding:2px 9px" ${i === _ap.menu.length - 1 ? 'disabled' : ''} onclick="apMenuMover(${i},1)" aria-label="Descer">↓</button>
            </div>`).join('')}
        </div>
      </div>`;
    document.getElementById('apTema').value = _ap.temaPadrao || '';
    document.getElementById('apFonte').value = _ap.fonte || 'manrope';
    document.getElementById('apRaio').value = _ap.raio || 'redondo';
    document.getElementById('apEscala').value = String(_ap.escala || 100);
}

function apSet(k, v) { _ap[k] = v; apPrever(); }
function apCor(c) { _ap.cor = c === '#ff8a2b' ? '' : c; apDesenhar(); apPrever(); }
function apMenuVisivel(i, on) { _ap.menu[i].on = !!on; apPrever(); }
function apMenuMover(i, d) {
    const j = i + d; if (j < 0 || j >= _ap.menu.length) return;
    const t = _ap.menu[i]; _ap.menu[i] = _ap.menu[j]; _ap.menu[j] = t;
    apDesenhar(); apPrever();
}

async function apSalvar() {
    const btn = document.getElementById('apSalvar');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/aparencia', { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(_ap) });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Falha ao salvar');
        _ap = d; _apSalvo = JSON.stringify(d);
        if (window.HubAparencia) { window.HubAparencia.guardar(d); window.HubAparencia.aplicar(d); }
        apDesenhar();
        setCfgStatus('apStatus', 'Aparência salva. As outras telas abertas atualizam sozinhas; quem está logado pega no próximo carregamento.', 'ok');
    } catch (e) { setCfgStatus('apStatus', `Erro ao salvar: ${e.message}`, 'error'); }
    finally { if (btn) btn.disabled = false; }
}

function apRestaurar() {
    const menu = (_ap.menu || []).map((m) => m.v).sort((a, b) => Object.keys(AP_ABAS).indexOf(a) - Object.keys(AP_ABAS).indexOf(b)).map((v) => ({ v, on: true }));
    _ap = { ...JSON.parse(JSON.stringify(AP_PADRAO)), menu };
    apDesenhar(); apPrever();
    setCfgStatus('apStatus', 'Padrão restaurado na tela. Clique em "Salvar" para confirmar.', 'ok');
}
