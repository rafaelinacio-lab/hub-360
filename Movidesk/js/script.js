// ── script.js — Orquestrador principal ────────────────────────────────────
// Os módulos abaixo são carregados via <script> no index.html:
//   auth.js | dashboard.js | curadoria.js | pessoas.js | config.js

// Configuração da API
const API_BASE = `${window.location.origin}/api`;
const CURADORIA_API = `${API_BASE}/curadoria`;
const PESSOAS_API = `${API_BASE}/pessoas`;
let _currentUser = null;
let _appInitialized = false;
let _curadoriaLoaded = false;
let _curadoriaRows = [];
let _curadoriaFiltersReady = false;
let _usersCache = []; // Cache de usuários para lookup de email por nome
let _pessoasAllUsers = [];

const ENABLE_AUTO_LOAD_TICKETS = false;

const URL_PARAMS = new URLSearchParams(window.location.search);
const LEGACY_VIEW = URL_PARAMS.get('legacyView') || '';
const EMBED_MODE = !LEGACY_VIEW;
const EMBED_PAGE_ROUTES = {
    dashboard: 'pages/dashboard.html',
    chamados: 'pages/curadoria.html',
    configuracoes: 'pages/configuracoes.html',
    ouvidoria: 'pages/ouvidoria.html',
    gcc: 'pages/gcc.html',
    jira: 'pages/jira.html',
    movidesk: 'pages/geral.html',
    satisfacao: 'pages/satisfacao.html',
    chats: 'pages/chats.html',
    incidentes: 'pages/incidentes.html',
    reincidencias: 'pages/reincidencias.html',
    melhorias: 'pages/melhorias.html'
};

// ─── Transição entre abas: só a persiana do Visual 2.0 (js/modload.js).
// A porcentagem é o carregamento REAL da aba: cada página (iframe) informa o progresso das suas chamadas à API
// (js/ui-version.js → mensagem 'hub360:carga') e a persiana só abre quando os dados já estão na tela.
let _persianaAtiva = false, _persianaVigia = 0;
function persianaAbrir() { _persianaAtiva = false; clearTimeout(_persianaVigia); if (window.HubModload) window.HubModload.hide(); }
function playTabIconTransition(view) {
    if (!window.HubModload || !window.HubModload.show(view, 760, true)) return;
    _persianaAtiva = true;
    clearTimeout(_persianaVigia);
    _persianaVigia = setTimeout(persianaAbrir, 8000);   // vigia: se a página não avisar nada, não prende a tela
}
window.addEventListener('message', (ev) => {
    const frame = document.getElementById('embeddedPageFrame');
    if (!frame || ev.source !== frame.contentWindow || ev.origin !== location.origin) return;
    if (!ev.data || ev.data.tipo !== 'hub360:carga' || !_persianaAtiva) return;
    window.HubModload.progresso(Number(ev.data.pct) || 0);
    clearTimeout(_persianaVigia);
    if (ev.data.pronto) { window.HubModload.progresso(100); setTimeout(persianaAbrir, 60); }
    else _persianaVigia = setTimeout(persianaAbrir, 12000);
});

// ─── Bolha de hover que acompanha o mouse entre as abas do menu superior ───
function initTopbarHoverPill() {
    const nav = document.querySelector('.topbar-nav');
    const pill = document.getElementById('topbarHoverPill');
    if (!nav || !pill) return;

    nav.querySelectorAll('.sidebar-btn[data-view]').forEach((btn) => {
        btn.addEventListener('mouseenter', () => {
            pill.style.left = `${btn.offsetLeft}px`;
            pill.style.width = `${btn.offsetWidth}px`;
            pill.style.opacity = '1';
        });
    });

    nav.addEventListener('mouseleave', () => {
        pill.style.opacity = '0';
    });
}

function applyRuntimeLayoutMode() {
    if (LEGACY_VIEW) {
        document.body.classList.add('legacy-view-mode');
    } else {
        document.body.classList.add('embedded-shell-mode');
    }
}

function loadEmbeddedPage(view) {
    const frame = document.getElementById('embeddedPageFrame');
    const host = document.getElementById('embeddedPagesView');
    if (!frame || !host) return;

    host.style.display = 'block';

    // Normaliza a view para evitar fallback silencioso (ex: acentos, espaços)
    const normalizedView = (view || '').trim().toLowerCase();

    if (!EMBED_PAGE_ROUTES[normalizedView]) {
        console.warn(`[loadEmbeddedPage] View desconhecida: "${view}". Redirecionando para dashboard.`);
    }

    const src = EMBED_PAGE_ROUTES[normalizedView] || EMBED_PAGE_ROUTES.dashboard;
    if (frame.getAttribute('src') !== src) {
        document.body.classList.remove('nav-oculta');
        frame.setAttribute('src', src);
    } else if (typeof persianaAbrir === 'function') {
        setTimeout(persianaAbrir, 500);   // a página já estava carregada: nada a esperar
    }
}

// A página embutida avisa quando rolou pra baixo (esconder o menu) ou pra cima (mostrar).
window.addEventListener('message', (ev) => {
    const frame = document.getElementById('embeddedPageFrame');
    if (!frame || ev.source !== frame.contentWindow || ev.origin !== location.origin) return;
    if (!ev.data || ev.data.tipo !== 'hub360:menu-oculto') return;
    document.body.classList.toggle('nav-oculta', !!ev.data.oculto);
});
document.addEventListener('DOMContentLoaded', () => {
    const frame = document.getElementById('embeddedPageFrame');
    // Página nova carregada no iframe sempre começa com o menu visível
    if (frame) frame.addEventListener('load', () => document.body.classList.remove('nav-oculta'));
});

// ─── Contador de incidentes ativos na aba ───────────────────────────────────
async function atualizarBadgeIncidentes() {
    const btn = document.getElementById('navIncidentes');
    const badge = document.getElementById('navBadgeIncidentes');
    if (!btn || !badge || btn.style.display === 'none') return;
    try {
        const r = await fetch(`${API_BASE}/incidentes/metricas`, { headers: authHeaders() });
        if (!r.ok) return;
        const m = await r.json();
        const n = Number(m.totalAtivos) || 0;
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = n === 0;
        badge.classList.toggle('grave', (Number(m.gravesAtivos) || 0) > 0);
        badge.title = `${n} incidente${n === 1 ? '' : 's'} ativo${n === 1 ? '' : 's'}`
            + (m.gravesAtivos ? ` (${m.gravesAtivos} grave${m.gravesAtivos === 1 ? '' : 's'})` : '');
    } catch (_) { /* sem contador, a aba funciona igual */ }
}
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(atualizarBadgeIncidentes, 3000);   // depois das abas liberadas pelo perfil
    setInterval(atualizarBadgeIncidentes, 3 * 60 * 1000);
});

// ─── "Ir para…" (Ctrl+K): abas do menu e número de chamado ──────────────────
(function paletaIrPara() {
    let itens = [];
    let sel = 0;
    const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const el = (id) => document.getElementById(id);

    function abasVisiveis() {
        return [...document.querySelectorAll('.topbar-nav .sidebar-btn[data-view]')]
            .filter((b) => b.style.display !== 'none')
            .map((b) => ({
                view: b.dataset.view,
                nome: (b.querySelector('.sidebar-btn-label') || b).textContent.trim(),
                icone: b.querySelector('svg') ? b.querySelector('svg').outerHTML : '',
            }));
    }
    function montar() {
        const q = semAcento(el('navPaletaInput').value.trim());
        itens = abasVisiveis()
            .filter((a) => !q || semAcento(a.nome).includes(q))
            .map((a) => ({ tipo: 'aba', ...a }));
        if (/^\d{4,}$/.test(q)) {
            itens.unshift({ tipo: 'chamado', numero: q, nome: `Abrir o chamado #${q} no Movidesk`, icone: '' });
        }
        sel = Math.min(sel, Math.max(0, itens.length - 1));
        el('navPaletaLista').innerHTML = itens.length
            ? itens.map((i, n) => `<li role="option" data-n="${n}" class="${n === sel ? 'sel' : ''}">${i.icone}<span>${i.nome}</span>${i.tipo === 'chamado' ? '<small>nova aba</small>' : ''}</li>`).join('')
            : '<li style="cursor:default">Nada encontrado</li>';
    }
    function abrir() {
        const box = el('navPaleta');
        if (!box) return;
        box.hidden = false;
        el('navPaletaInput').value = '';
        sel = 0;
        montar();
        el('navPaletaInput').focus();
    }
    function fechar() { const box = el('navPaleta'); if (box) box.hidden = true; }
    function escolher(n) {
        const i = itens[n];
        if (!i) return;
        fechar();
        if (i.tipo === 'chamado') window.open(`https://viasoft.movidesk.com/Ticket/Edit/${i.numero}`, '_blank', 'noopener');
        else navigateTo(i.view);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const btn = el('navBuscaBtn');
        if (btn) btn.addEventListener('click', abrir);
        const box = el('navPaleta');
        if (!box) return;
        box.addEventListener('mousedown', (e) => { if (e.target === box) fechar(); });
        el('navPaletaInput').addEventListener('input', () => { sel = 0; montar(); });
        el('navPaletaLista').addEventListener('click', (e) => {
            const li = e.target.closest('li[data-n]');
            if (li) escolher(Number(li.dataset.n));
        });
        el('navPaletaInput').addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, itens.length - 1); montar(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); montar(); }
            else if (e.key === 'Enter') { e.preventDefault(); escolher(sel); }
        });
    });
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); abrir(); }
        else if (e.key === 'Escape' && el('navPaleta') && !el('navPaleta').hidden) fechar();
    });
    // Ctrl+K dentro da página embutida (iframe) também abre a paleta
    window.addEventListener('message', (ev) => {
        const frame = document.getElementById('embeddedPageFrame');
        if (!frame || ev.source !== frame.contentWindow || ev.origin !== location.origin) return;
        if (ev.data && ev.data.tipo === 'hub360:paleta') abrir();
    });
})();

// ─── Função auxiliar para gerar URL de foto de usuário ───────────────────────
function getPhotoUrl(email) {
    if (!email) return null;
    return `${API_BASE}/pessoas/foto/${encodeURIComponent(email)}`;
}

// ─── Função para buscar email de um usuário pelo nome ───────────────────────
// ─── Renderiza avatar do usuário logado na sidebar ───────────────────────────
function renderSidebarUser() {
    if (!_currentUser) return;
    const sidebarUser = document.getElementById('sidebarUser');
    if (!sidebarUser) return;
    const nome = _currentUser.name || _currentUser.nome || 'Usuário';
    const email = _currentUser.email || '';
    const avatar = createAvatarHTML(email, nome, _currentUser.picture || null);
    sidebarUser.innerHTML = `
        <div class="sidebar-user-avatar" title="${nome}${email ? ' (' + email + ')' : ''}">${avatar}</div>
    `;
}

async function getUserEmailByName(name) {
    if (!name) return null;
    
    // Tenta encontrar no cache
    const cached = _usersCache.find(u => u.name && u.name.toLowerCase() === name.toLowerCase());
    if (cached) return cached.email;
    
    // Se não encontrou no cache, tenta fazer fetch
    if (_usersCache.length === 0) {
        try {
            const response = await fetch(`${API_BASE}/pessoas`, {
                headers: authHeaders()
            });
            if (response.ok) {
                _usersCache = await response.json();
                // Tenta de novo
                const found = _usersCache.find(u => u.name && u.name.toLowerCase() === name.toLowerCase());
                return found?.email || null;
            }
        } catch (e) {
            console.error('Erro ao carregar usuários:', e);
        }
    }
    
    return null;
}

// ─── Função para criar HTML de avatar (foto ou fallback com iniciais) ───────
function createAvatarHTML(email, name, googlePicture) {
    const initials = (name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const photoUrl = getPhotoUrl(email);

    // Se tem email, tenta primeiro por email, depois por nome como fallback
    // Se não tem email mas tem nome, tenta buscar por nome
    let imageSrc = photoUrl || (name ? `${API_BASE}/pessoas/foto-por-nome/${encodeURIComponent(name)}` : null);
    // Sem foto oficial (pasta de TI) pra tentar, já usa a foto da conta Google
    // (quando disponível) direto, em vez de cair pras iniciais.
    if (!imageSrc && googlePicture) imageSrc = googlePicture;
    // Foto oficial da pasta de TI falhando (onerror) tenta a foto do Google
    // antes de desistir e mostrar as iniciais — ver avatarImgError abaixo.
    const fallback = (imageSrc !== googlePicture && googlePicture) ? googlePicture : '';

    return `
        <div class="avatar-container" title="${escapeHtml(name || '')}">
            <img
                ${imgSrcAttr(imageSrc || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')}
                alt="${escapeHtml(name || '')}"
                class="avatar-foto"
                data-fallback="${escapeHtml(fallback)}"
                data-fallback-tried="0"
                onerror="avatarImgError(this)"
                onload="this.parentElement.querySelector('.avatar-initials').style.display='none';"
            />
            <div class="avatar-initials">${initials}</div>
        </div>
    `;
}

// Encadeia o fallback de avatar: foto oficial (pasta de TI) → foto da conta
// Google → iniciais. Só avança um passo por vez (data-fallback-tried evita
// loop se a própria URL de fallback também falhar).
function avatarImgError(img) {
    const fallback = img.dataset.fallback;
    if (fallback && img.dataset.fallbackTried !== '1') {
        img.dataset.fallbackTried = '1';
        img.src = fallback;
        return;
    }
    img.style.display = 'none';
    // Duas classes de "iniciais" convivem no app: .avatar-initials (sidebar)
    // e .pt-avatar (tabela de Pessoas) — mesma função de fallback serve as duas.
    const initialsEl = img.parentElement.querySelector('.avatar-initials, .pt-avatar');
    if (initialsEl) initialsEl.style.display = 'flex';
}

function getTicketValue(ticket, camelKey, snakeKey, fallback = '') {
    if (!ticket) return fallback;
    if (ticket[camelKey] !== undefined && ticket[camelKey] !== null && ticket[camelKey] !== '') {
        return ticket[camelKey];
    }
    if (snakeKey && ticket[snakeKey] !== undefined && ticket[snakeKey] !== null && ticket[snakeKey] !== '') {
        return ticket[snakeKey];
    }
    return fallback;
}


// ── Navegação ────────────────────────────────────────────────────────────
let _cachedTickets = [];

// ─── Navegação entre Views ────────────────────────────────────────
function navigateTo(view) {
    // Normaliza para evitar bugs com acentos ou espaços vindos de data-view
    const normalizedView = (view || '').trim().toLowerCase();
    if (window.Telemetria) window.Telemetria.view(normalizedView);

    if (EMBED_MODE) {
        if (normalizedView === 'configuracoes' && !isCurrentUserAdmin()) {
            return;
        }

        const wasActive = document.querySelector(`.sidebar-btn[data-view="${normalizedView}"].active`);
        document.querySelectorAll('.sidebar-btn[data-view]').forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.sidebar-btn[data-view="${normalizedView}"]`);
        if (activeBtn) activeBtn.classList.add('active');

        if (!wasActive) playTabIconTransition(normalizedView);

        loadEmbeddedPage(normalizedView);
        localStorage.setItem('activeEmbeddedView', normalizedView);
        return;
    }

    const views = {
        dashboard: document.getElementById('dashboardView'),
        chamados: document.getElementById('curadoriaView'),
        configuracoes: document.getElementById('configuracoesView'),
        movidesk: document.getElementById('movideskView'),
    };

    if (normalizedView === 'configuracoes' && !isCurrentUserAdmin()) {
        const denied = document.getElementById('configAccessDenied');
        if (denied) denied.style.display = 'block';
        return;
    }

    const denied = document.getElementById('configAccessDenied');
    if (denied) denied.style.display = 'none';

    const wasActive = document.querySelector(`.sidebar-btn[data-view="${normalizedView}"].active`);
    document.querySelectorAll('.sidebar-btn[data-view]').forEach(b => b.classList.remove('active'));
    Object.values(views).forEach(v => { if (v) v.style.display = 'none'; });

    if (views[normalizedView]) views[normalizedView].style.display = 'block';
    const activeBtn = document.querySelector(`.sidebar-btn[data-view="${normalizedView}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    if (!wasActive) playTabIconTransition(normalizedView);

    if (normalizedView === 'dashboard' || normalizedView === 'movidesk') {
        fetchOpenTickets();
        startDashboardRefreshLoop();
    } else {
        stopDashboardRefreshLoop();
    }
    if (normalizedView === 'chamados') loadCuradoria();
    if (normalizedView === 'configuracoes') {
        loadMovideskTokenStatus();
        loadGptStatus();
        loadCategoriesConfig();
        loadScoreWeightsConfig();
        loadCuradoriaPendingCount();
        checkSurveySyncOnLoad();
        checkModuloSyncOnLoad();
        checkFullLoadOnLoad();
    }
}


// ===== FILTROS DO DASHBOARD =====
function applyDashboardFilters() {
    const container = document.getElementById('cardsContainer');
    if (!container) return;

    const statusFilter = document.getElementById('filterStatus')?.value?.trim() || '';
    const urgencyFilter = document.getElementById('filterUrgency')?.value?.trim() || '';
    const attendeeFilter = document.getElementById('filterAtendente')?.value?.trim() || '';
    const teamFilter = document.getElementById('filterEquipe')?.value?.trim() || '';
    const lastActionFilter = document.getElementById('filterLastAction')?.value?.trim() || '';
    const slaFilter = document.getElementById('filterSla')?.value?.trim() || '';
    const busca = (document.getElementById('filterBusca')?.value || '').trim().toLowerCase();

    if (!_cachedTickets || _cachedTickets.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; padding: 40px; text-align: center;"><p>Nenhum chamado encontrado.</p></div>';
        document.getElementById('filterCount').textContent = '';
        return;
    }

    let filtered = _cachedTickets.filter(ticket => {
        // Busca livre: nº, assunto, cliente ou atendente
        if (busca) {
            const palheiro = [
                ticket.id,
                getTicketValue(ticket, 'subject', 'subject', ''),
                getTicketValue(ticket, 'clientName', 'clientname', ''),
                getTicketValue(ticket, 'clientOrganization', 'clientorganization', ''),
                getTicketValue(ticket, 'ownerName', 'ownername', ''),
            ].join(' ').toLowerCase();
            if (!palheiro.includes(busca)) return false;
        }
        // Filtro por Status
        if (statusFilter) {
            const baseStatusRaw = getTicketValue(ticket, 'baseStatus', 'basestatus', '') || getTicketValue(ticket, 'status', 'status', '');
            const baseStatus = normalizeDashboardBaseStatus(baseStatusRaw);
            if (baseStatus !== statusFilter) return false;
        }

        // Filtro por Urgência
        if (urgencyFilter) {
            const urgency = getUrgencyFromSLA(getTicketValue(ticket, 'slaAgreementRule', 'slaagreementrule', ''));
            if (urgency.label !== urgencyFilter) return false;
        }

        // Filtro por Atendente
        if (attendeeFilter) {
            const ownerName = getTicketValue(ticket, 'ownerName', 'ownername', 'Sem atribuição');
            if (ownerName !== attendeeFilter) return false;
        }

        // Filtro por Equipe (owner_team)
        if (teamFilter) {
            const ownerTeam = getTicketValue(ticket, 'ownerTeam', 'owner_team', '');
            if (ownerTeam !== teamFilter) return false;
        }

        // Filtro por Última Ação
        if (lastActionFilter) {
            const lastActionOrigin = getTicketValue(ticket, 'lastActionOrigin', 'lastactionorigin', '');
            if (lastActionOrigin !== lastActionFilter) return false;
        }

        // Filtro por SLA
        if (slaFilter) {
            const isPaused = getTicketValue(ticket, 'slaSolutionDateIsPaused', 'slasolutiondateispaused', false) === 1 || getTicketValue(ticket, 'slaSolutionDateIsPaused', 'slasolutiondateispaused', false) === true;
            
            if (slaFilter === 'paused') {
                if (!isPaused) return false;
            } else {
                const slaSolutionDate = getTicketValue(ticket, 'slaSolutionDate', 'slasolutiondate', '');
                const slaSolutionTime = getTicketValue(ticket, 'slaSolutionTime', 'slasolutiontime', '');
                const createdDate = getTicketValue(ticket, 'createdDate', 'createddate', '');
                
                let deadline = null;
                if (slaSolutionDate) {
                    deadline = new Date(slaSolutionDate);
                } else if (isPaused && slaSolutionTime && createdDate) {
                    const created = new Date(createdDate);
                    deadline = new Date(created.getTime() + slaSolutionTime * 60000);
                }

                if (!deadline) return slaFilter !== 'overdue'; // Sem prazo = não é overdue

                const now = new Date();
                const isOverdue = now >= deadline;

                if (slaFilter === 'ontime' && isOverdue) return false;
                if (slaFilter === 'overdue' && !isOverdue) return false;
            }
        }

        return true;
    });

    renderTickets(filtered, container);
    updateSummaryCards(filtered);

    const countText = filtered.length === _cachedTickets.length
        ? `${filtered.length} chamado${filtered.length === 1 ? '' : 's'}`
        : `${filtered.length} de ${_cachedTickets.length}`;
    document.getElementById('filterCount').textContent = countText;
    syncQuickChips({ statusFilter, slaFilter, lastActionFilter, hasOther: !!(urgencyFilter || attendeeFilter || teamFilter || busca) });
}

// Destaca o filtro rápido que corresponde aos selects (e só esse).
function syncQuickChips({ statusFilter, slaFilter, lastActionFilter, hasOther }) {
    const ativo = hasOther ? '' :
        (slaFilter === 'overdue' && !statusFilter && !lastActionFilter) ? 'atrasados' :
        (lastActionFilter === 'Customer' && !statusFilter && !slaFilter) ? 'semretorno' :
        (statusFilter === 'New' && !slaFilter && !lastActionFilter) ? 'novos' :
        (slaFilter === 'paused' && !statusFilter && !lastActionFilter) ? 'pausa' :
        (!statusFilter && !slaFilter && !lastActionFilter) ? 'todos' : '';
    document.querySelectorAll('#quickChips .tk-chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.chip === ativo)));
}

function populateDashboardFilters() {
    if (!_cachedTickets || _cachedTickets.length === 0) return;

    // Coletar todos os atendentes únicos
    const attendees = new Set();
    const teams = new Set();
    _cachedTickets.forEach(ticket => {
        const owner = getTicketValue(ticket, 'ownerName', 'ownername', 'Sem atribuição');
        if (owner) attendees.add(owner);
        const team = getTicketValue(ticket, 'ownerTeam', 'owner_team', '');
        if (team) teams.add(team);
    });

    const attendeeSelect = document.getElementById('filterAtendente');
    if (attendeeSelect) {
        const currentValue = attendeeSelect.value;
        const options = ['<option value="">Todos os atendentes</option>'];
        Array.from(attendees).sort().forEach(name => {
            options.push(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
        });
        attendeeSelect.innerHTML = options.join('');
        attendeeSelect.value = currentValue;
    }

    const teamSelect = document.getElementById('filterEquipe');
    if (teamSelect) {
        const currentValue = teamSelect.value;
        const options = ['<option value="">Todas as equipes</option>'];
        Array.from(teams).sort().forEach(team => {
            options.push(`<option value="${escapeHtml(team)}">${escapeHtml(team)}</option>`);
        });
        teamSelect.innerHTML = options.join('');
        teamSelect.value = currentValue;
    }
}

function setupDashboardFilters() {
    const filterStatus = document.getElementById('filterStatus');
    const filterUrgency = document.getElementById('filterUrgency');
    const filterAtendente = document.getElementById('filterAtendente');
    const filterEquipe = document.getElementById('filterEquipe');
    const filterLastAction = document.getElementById('filterLastAction');
    const filterSla = document.getElementById('filterSla');
    const filterClear = document.getElementById('filterClear');

    if (filterStatus) filterStatus.addEventListener('change', applyDashboardFilters);
    if (filterUrgency) filterUrgency.addEventListener('change', applyDashboardFilters);
    if (filterAtendente) filterAtendente.addEventListener('change', applyDashboardFilters);
    if (filterEquipe) filterEquipe.addEventListener('change', applyDashboardFilters);
    if (filterLastAction) filterLastAction.addEventListener('change', applyDashboardFilters);
    if (filterSla) filterSla.addEventListener('change', applyDashboardFilters);

    // Busca, modo de visualização e filtros rápidos
    const busca = document.getElementById('filterBusca');
    if (busca) {
        let t = null;
        busca.addEventListener('input', () => { clearTimeout(t); t = setTimeout(applyDashboardFilters, 150); });
    }
    document.getElementById('viewLista')?.addEventListener('click', () => setDashView('lista'));
    document.getElementById('viewCards')?.addEventListener('click', () => setDashView('cards'));
    document.querySelectorAll('#quickChips .tk-chip').forEach(chip => chip.addEventListener('click', () => {
        const set = (el, v) => { if (el) el.value = v; };
        set(filterStatus, ''); set(filterSla, ''); set(filterLastAction, '');
        switch (chip.dataset.chip) {
            case 'atrasados': set(filterSla, 'overdue'); break;
            case 'semretorno': set(filterLastAction, 'Customer'); break;
            case 'novos': set(filterStatus, 'New'); break;
            case 'pausa': set(filterSla, 'paused'); break;
            default: break;
        }
        applyDashboardFilters();
    }));

    if (filterClear) {
        filterClear.addEventListener('click', () => {
            if (busca) busca.value = '';
            if (filterStatus) filterStatus.value = '';
            if (filterUrgency) filterUrgency.value = '';
            if (filterAtendente) filterAtendente.value = '';
            if (filterEquipe) filterEquipe.value = '';
            if (filterLastAction) filterLastAction.value = '';
            if (filterSla) filterSla.value = '';
            applyDashboardFilters();
        });
    }
}

function setupConfigEvents() {
    const saveTokenBtn = document.getElementById('cfgSaveMovideskToken');
    if (saveTokenBtn) saveTokenBtn.addEventListener('click', saveMovideskToken);

    const saveGptBtn = document.getElementById('cfgSaveGptApiKey');
    if (saveGptBtn) saveGptBtn.addEventListener('click', saveGptApiKey);

    const savePromptBtn = document.getElementById('cfgSaveGptPrompt');
    if (savePromptBtn) savePromptBtn.addEventListener('click', saveGptPrompt);

    const resetPromptBtn = document.getElementById('cfgResetGptPrompt');
    if (resetPromptBtn) resetPromptBtn.addEventListener('click', resetGptPromptToDefault);

    const saveDbBtn = document.getElementById('cfgSaveDbConfig');
    if (saveDbBtn) saveDbBtn.addEventListener('click', saveDbConfig);

    const reloadDbBtn = document.getElementById('cfgReloadDbConfig');
    if (reloadDbBtn) reloadDbBtn.addEventListener('click', loadDbConfig);

    // Curadoria Avançado
    const saveCuradoriaPromptAnaliseBtn = document.getElementById('cfgSaveCuradoriaPromptAnalise');
    if (saveCuradoriaPromptAnaliseBtn) saveCuradoriaPromptAnaliseBtn.addEventListener('click', saveCuradoriaPromptAnalise);

    const resetCuradoriaPromptAnaliseBtn = document.getElementById('cfgResetCuradoriaPromptAnalise');
    if (resetCuradoriaPromptAnaliseBtn) resetCuradoriaPromptAnaliseBtn.addEventListener('click', resetCuradoriaPromptAnaliseToDefault);

    const testCuradoriaPromptAnaliseBtn = document.getElementById('cfgTestCuradoriaPromptAnalise');
    if (testCuradoriaPromptAnaliseBtn) testCuradoriaPromptAnaliseBtn.addEventListener('click', testCuradoriaPromptAnalise);

    const saveCuradoriaPromptCompetenciasBtn = document.getElementById('cfgSaveCuradoriaPromptCompetencias');
    if (saveCuradoriaPromptCompetenciasBtn) saveCuradoriaPromptCompetenciasBtn.addEventListener('click', saveCuradoriaPromptCompetencias);

    const resetCuradoriaPromptCompetenciasBtn = document.getElementById('cfgResetCuradoriaPromptCompetencias');
    if (resetCuradoriaPromptCompetenciasBtn) resetCuradoriaPromptCompetenciasBtn.addEventListener('click', resetCuradoriaPromptCompetenciasToDefault);

    const saveCuradoriaPromptNarrativaBtn = document.getElementById('cfgSaveCuradoriaPromptNarrativa');
    if (saveCuradoriaPromptNarrativaBtn) saveCuradoriaPromptNarrativaBtn.addEventListener('click', saveCuradoriaPromptNarrativa);

    const resetCuradoriaPromptNarrativaBtn = document.getElementById('cfgResetCuradoriaPromptNarrativa');
    if (resetCuradoriaPromptNarrativaBtn) resetCuradoriaPromptNarrativaBtn.addEventListener('click', resetCuradoriaPromptNarrativaToDefault);

    const saveQueryListagemBtn = document.getElementById('cfgSaveQueryListagem');
    if (saveQueryListagemBtn) saveQueryListagemBtn.addEventListener('click', saveCuradoriaQueryConfig);

    const resetQueryListagemBtn = document.getElementById('cfgResetQueryListagem');
    if (resetQueryListagemBtn) resetQueryListagemBtn.addEventListener('click', resetCuradoriaQueryListagem);

    const saveQueryPendentesBtn = document.getElementById('cfgSaveQueryPendentes');
    if (saveQueryPendentesBtn) saveQueryPendentesBtn.addEventListener('click', saveCuradoriaQueryConfig);

    const resetQueryPendentesBtn = document.getElementById('cfgResetQueryPendentes');
    if (resetQueryPendentesBtn) resetQueryPendentesBtn.addEventListener('click', resetCuradoriaQueryPendentes);

    const saveMovideskCuradoriaBtn = document.getElementById('cfgSaveMovideskCuradoriaConfig');
    if (saveMovideskCuradoriaBtn) saveMovideskCuradoriaBtn.addEventListener('click', saveCuradoriaMovideskConfig);

    const resetMovideskCuradoriaBtn = document.getElementById('cfgResetMovideskCuradoriaConfig');
    if (resetMovideskCuradoriaBtn) resetMovideskCuradoriaBtn.addEventListener('click', resetCuradoriaMovideskConfigToDefault);

    const saveSlaThresholdsBtn = document.getElementById('cfgSaveSlaThresholds');
    if (saveSlaThresholdsBtn) saveSlaThresholdsBtn.addEventListener('click', saveSlaThresholds);

    const resetSlaThresholdsBtn = document.getElementById('cfgResetSlaThresholds');
    if (resetSlaThresholdsBtn) resetSlaThresholdsBtn.addEventListener('click', resetSlaThresholdsToDefault);

    const saveCuradoriaPromptSlaEstouroBtn = document.getElementById('cfgSaveCuradoriaPromptSlaEstouro');
    if (saveCuradoriaPromptSlaEstouroBtn) saveCuradoriaPromptSlaEstouroBtn.addEventListener('click', saveCuradoriaPromptSlaEstouro);

    const resetCuradoriaPromptSlaEstouroBtn = document.getElementById('cfgResetCuradoriaPromptSlaEstouro');
    if (resetCuradoriaPromptSlaEstouroBtn) resetCuradoriaPromptSlaEstouroBtn.addEventListener('click', resetCuradoriaPromptSlaEstouroToDefault);
}

// Inicializar quando a página carregar
document.addEventListener('DOMContentLoaded', async function() {
    applyRuntimeLayoutMode();

    const current = await loadCurrentUser();
    if (!current) {
        showLoginScreen();
        return;
    }

    hideLoginScreen();
    await initializeApp();
});

async function initializeApp() {
    if (_appInitialized) return;
    _appInitialized = true;
    
    // Limpar qualquer elemento duplicado de sincronização
    const syncElements = document.querySelectorAll('[id="syncStatusBubble"]');
    if (syncElements.length > 1) {
        for (let i = 1; i < syncElements.length; i++) {
            syncElements[i].remove();
        }
    }

    if (EMBED_MODE) {
        await applyRoleBasedNavigation();
        setupDarkMode();

        document.querySelectorAll('.sidebar-btn[data-view]').forEach(b => {
            b.addEventListener('click', () => navigateTo(b.dataset.view));
        });
        initTopbarHoverPill();

        const savedView = localStorage.getItem('activeEmbeddedView') || 'dashboard';
        const startView = (isCurrentUserGuest() || !EMBED_PAGE_ROUTES[savedView]) ? 'dashboard' : savedView;
        navigateTo(startView);

        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn && !logoutBtn.dataset.bound) {
            logoutBtn.addEventListener('click', logout);
            logoutBtn.dataset.bound = '1';
        }

        return;
    }

    if (LEGACY_VIEW) {
        await applyRoleBasedNavigation();
        setupDarkMode();
        setupDashboardFilters();
        setupConfigEvents();
        setupPessoasEvents();

        const toggleBtn = document.getElementById('toggleBtn');
        if (toggleBtn && !toggleBtn.dataset.bound) {
            toggleBtn.addEventListener('click', toggleCardsSection);
            toggleBtn.dataset.bound = '1';
        }

        document.querySelectorAll('.sidebar-btn[data-view]').forEach(b => {
            if (!b.dataset.bound) {
                b.addEventListener('click', () => navigateTo(b.dataset.view));
                b.dataset.bound = '1';
            }
        });

        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn && !logoutBtn.dataset.bound) {
            logoutBtn.addEventListener('click', logout);
            logoutBtn.dataset.bound = '1';
        }

        const view = LEGACY_VIEW && ['dashboard','chamados','configuracoes','movidesk'].includes(LEGACY_VIEW) ? LEGACY_VIEW : 'dashboard';
        navigateTo(view);
        return;
    }

    showLastSync();
    await applyRoleBasedNavigation();
    if (ENABLE_AUTO_LOAD_TICKETS) {
        fetchOpenTickets();
        startDashboardRefreshLoop();
    } else {
        updateSyncStatus('Modo manual: tickets nao carregados automaticamente.');
    }
    setupDarkMode();
    setupDashboardFilters();
    setupConfigEvents();
    loadGptPrompt();
    loadDbConfig();

    const toggleBtn = document.getElementById('toggleBtn');
    if (toggleBtn && !toggleBtn.dataset.bound) {
        toggleBtn.addEventListener('click', toggleCardsSection);
        toggleBtn.dataset.bound = '1';
    }

    document.querySelectorAll('.sidebar-btn[data-view]').forEach(b => {
        if (!b.dataset.bound) {
            b.addEventListener('click', () => navigateTo(b.dataset.view));
            b.dataset.bound = '1';
        }
    });

    setupPessoasEvents();

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn && !logoutBtn.dataset.bound) {
        logoutBtn.addEventListener('click', logout);
        logoutBtn.dataset.bound = '1';
    }
}

// ─── Dark Mode ────────────────────────────────────────────────────
function setupDarkMode() {
    const saved = localStorage.getItem('theme') || 'light';
    applyTheme(saved);
    const toggle = document.getElementById('darkModeToggle');
    if (!toggle) return;

    toggle.checked = saved === 'dark';

    if (toggle.dataset.bound) return;

    toggle.addEventListener('change', () => {
        const next = toggle.checked ? 'dark' : 'light';
        applyTheme(next);
        localStorage.setItem('theme', next);
    });

    toggle.dataset.bound = '1';
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}
