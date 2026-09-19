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
    pessoas: 'pages/pessoas.html',
    configuracoes: 'pages/configuracoes.html',
    ouvidoria: 'pages/ouvidoria.html',
    gcc: 'pages/gcc.html',
    jira: 'pages/jira.html',
    movidesk: 'pages/movidesk.html'
};

// ─── Animação de transição: ícone da aba clicada "voa" até o centro do
// conteúdo, pulsa com um anel de destaque e desaparece revelando a página.
// Fundo opaco cobre TUDO por baixo (aba antiga + nova carregando) até a
// animação terminar — só então o overlay some e revela o conteúdo.
const TAB_FX_FADE_IN  = 180;  // overlay vira opaco
const TAB_FX_HOLD_END = 1500; // overlay começa a sumir
const TAB_FX_TOTAL    = 1900; // overlay totalmente transparente de novo

function playTabIconTransition(view) {
    const main = document.querySelector('.main-content');
    if (!main) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const mainRect = main.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.className = 'tab-fx-overlay';
    overlay.style.left = `${mainRect.left}px`;
    overlay.style.top = `${mainRect.top}px`;
    overlay.style.width = `${mainRect.width}px`;
    overlay.style.height = `${mainRect.height}px`;
    document.body.appendChild(overlay);

    overlay.animate(
        [
            { opacity: 0, offset: 0 },
            { opacity: 1, offset: TAB_FX_FADE_IN / TAB_FX_TOTAL },
            { opacity: 1, offset: TAB_FX_HOLD_END / TAB_FX_TOTAL },
            { opacity: 0, offset: 1 },
        ],
        { duration: TAB_FX_TOTAL, easing: 'ease', fill: 'forwards' }
    );

    if (view === 'gcc') {
        playGccArrowDraw(mainRect);
    } else {
        playIconFly(view, mainRect);
    }

    setTimeout(() => overlay.remove(), TAB_FX_TOTAL + 80);
}

// Voo genérico do ícone da aba clicada até o centro da tela.
function playIconFly(view, mainRect) {
    const btn = document.querySelector(`.sidebar-btn[data-view="${view}"]`);
    const svg = btn && btn.querySelector('svg');
    if (!svg) return;

    const startRect = svg.getBoundingClientRect();
    const cx = mainRect.left + mainRect.width / 2;
    const cy = mainRect.top + mainRect.height / 2;
    const startCx = startRect.left + startRect.width / 2;
    const startCy = startRect.top + startRect.height / 2;
    const dx = cx - startCx;
    const dy = cy - startCy;
    const bigScale = 92 / startRect.width;
    const delay = TAB_FX_FADE_IN;

    const ring = document.createElement('div');
    ring.className = 'tab-fx-ring';
    ring.style.left = `${cx}px`;
    ring.style.top = `${cy}px`;
    ring.style.opacity = '0';

    const icon = document.createElement('div');
    icon.className = 'tab-fx-icon';
    icon.innerHTML = svg.outerHTML;
    icon.style.left = `${startRect.left}px`;
    icon.style.top = `${startRect.top}px`;
    icon.style.width = `${startRect.width}px`;
    icon.style.height = `${startRect.height}px`;
    icon.style.opacity = '0';

    document.body.appendChild(ring);
    document.body.appendChild(icon);

    ring.animate(
        [
            { transform: 'translate(-50%,-50%) scale(0)', opacity: 0.5, offset: 0 },
            { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.35, offset: 0.4 },
            { transform: 'translate(-50%,-50%) scale(2.6)', opacity: 0, offset: 1 },
        ],
        { duration: 900, delay, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }
    );

    icon.animate(
        [
            { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1, offset: 0 },
            { transform: `translate(${dx}px,${dy}px) scale(${bigScale}) rotate(-10deg)`, opacity: 1, offset: 0.45 },
            { transform: `translate(${dx}px,${dy}px) scale(${bigScale * 1.1}) rotate(4deg)`, opacity: 1, offset: 0.68 },
            { transform: `translate(${dx}px,${dy}px) scale(${bigScale}) rotate(0deg)`, opacity: 1, offset: 0.85 },
            { transform: `translate(${dx}px,${dy}px) scale(${bigScale * 0.5}) rotate(8deg)`, opacity: 0, offset: 1 },
        ],
        { duration: 1000, delay, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }
    );

    setTimeout(() => { ring.remove(); icon.remove(); }, TAB_FX_TOTAL + 80);
}

// GCC: a setinha de queda (trending down) é desenhada traço a traço no
// centro da tela, em vez de voar — pedido explícito pra essa aba.
function playGccArrowDraw(mainRect) {
    const cx = mainRect.left + mainRect.width / 2;
    const cy = mainRect.top + mainRect.height / 2;
    const size = 120;
    const delay = TAB_FX_FADE_IN;

    const wrap = document.createElement('div');
    wrap.className = 'tab-fx-draw';
    wrap.style.left = `${cx - size / 2}px`;
    wrap.style.top = `${cy - size / 2}px`;
    wrap.style.width = `${size}px`;
    wrap.style.height = `${size}px`;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');

    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', 'M10 22 L38 46 L58 30 L88 64');
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M88 40 L88 64 L64 64');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', '88');
    dot.setAttribute('cy', '64');
    dot.setAttribute('r', '0');

    svg.appendChild(line);
    svg.appendChild(arrow);
    svg.appendChild(dot);
    wrap.appendChild(svg);
    document.body.appendChild(wrap);

    const lineLen = line.getTotalLength();
    const arrowLen = arrow.getTotalLength();
    line.style.strokeDasharray = String(lineLen);
    line.style.strokeDashoffset = String(lineLen);
    arrow.style.strokeDasharray = String(arrowLen);
    arrow.style.strokeDashoffset = String(arrowLen);

    line.animate(
        [{ strokeDashoffset: lineLen }, { strokeDashoffset: 0 }],
        { duration: 600, delay, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
    );
    arrow.animate(
        [{ strokeDashoffset: arrowLen }, { strokeDashoffset: 0 }],
        { duration: 280, delay: delay + 600, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
    );
    dot.animate(
        [{ r: 0, opacity: 0.9 }, { r: 6, opacity: 0 }],
        { duration: 400, delay: delay + 880, easing: 'ease-out', fill: 'forwards' }
    );

    setTimeout(() => wrap.remove(), TAB_FX_TOTAL + 80);
}

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
        frame.setAttribute('src', src);
    }
}

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
                src="${imageSrc || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}"
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
        pessoas:   document.getElementById('pessoasView'),
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
    if (normalizedView === 'pessoas') pessoasLoad();
    if (normalizedView === 'chamados') loadCuradoria();
    if (normalizedView === 'configuracoes') {
        loadMovideskTokenStatus();
        loadAdminStats();
        loadGptStatus();
        loadLastSyncedAt();
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

    if (!_cachedTickets || _cachedTickets.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; padding: 40px; text-align: center;"><p>Nenhum chamado encontrado.</p></div>';
        document.getElementById('filterCount').textContent = '';
        return;
    }

    let filtered = _cachedTickets.filter(ticket => {
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
        ? '' 
        : `${filtered.length} de ${_cachedTickets.length}`;
    document.getElementById('filterCount').textContent = countText;
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

    if (filterClear) {
        filterClear.addEventListener('click', () => {
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

    const reloadBtn = document.getElementById('cfgReloadStats');
    if (reloadBtn) reloadBtn.addEventListener('click', loadAdminStats);

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

    const saveMovideskCondBtn = document.getElementById('cfgSaveMovideskConditions');
    if (saveMovideskCondBtn) saveMovideskCondBtn.addEventListener('click', saveMovideskConditions);

    const resetMovideskCondBtn = document.getElementById('cfgResetMovideskConditions');
    if (resetMovideskCondBtn) resetMovideskCondBtn.addEventListener('click', resetMovideskConditions);

    const addTeamConditionBtn = document.getElementById('cfgAddTeamCondition');
    if (addTeamConditionBtn) addTeamConditionBtn.addEventListener('click', addTeamCondition);

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

    const loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', loginSubmit);

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

        const view = LEGACY_VIEW && ['dashboard','chamados','pessoas','configuracoes','movidesk'].includes(LEGACY_VIEW) ? LEGACY_VIEW : 'dashboard';
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
    loadMovideskConditions();
    loadLastSyncedAt();

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
