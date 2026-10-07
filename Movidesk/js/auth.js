
// ── auth.js — Token, sessão e navegação por role ──────────────────────────

function getAuthToken() {
    return localStorage.getItem('token') || '';
}

function authHeaders(extra = {}) {
    const token = getAuthToken();
    if (!token) return { ...extra };
    return {
        ...extra,
        Authorization: `Bearer ${token}`
    };
}

// ── Fotos protegidas ────────────────────────────────────────────────────
// /api/pessoas/foto* exige sessão, mas <img src> não manda o header
// Authorization. Imagens com data-auth-src são baixadas via fetch com o token
// e recebem um blob URL; se falhar, dispara "error" (o onerror do <img> segue
// o fallback normal: foto do Google → iniciais).
const _authImgCache = new Map(); // url -> Promise<blobUrl|null>
function isProtectedPhotoUrl(url) {
    return typeof url === 'string' && url.startsWith(`${window.location.origin}/api/pessoas/foto`);
}
// Atributo de origem da imagem: data-auth-src pras fotos protegidas, src pro resto.
function imgSrcAttr(url) {
    const esc = String(url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return isProtectedPhotoUrl(url) ? `data-auth-src="${esc}"` : `src="${esc}"`;
}
function loadAuthImage(img) {
    const url = img.getAttribute('data-auth-src');
    if (!url) return;
    img.removeAttribute('data-auth-src');
    let p = _authImgCache.get(url);
    if (!p) {
        p = fetch(url, { headers: authHeaders() })
            .then(r => (r.ok ? r.blob() : null))
            .then(b => (b ? URL.createObjectURL(b) : null))
            .catch(() => null);
        _authImgCache.set(url, p);
    }
    p.then(src => {
        if (src) img.src = src;
        else img.dispatchEvent(new Event('error'));
    });
}
function scanAuthImages(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches('img[data-auth-src]')) loadAuthImage(root);
    root.querySelectorAll('img[data-auth-src]').forEach(loadAuthImage);
}
new MutationObserver(muts => {
    muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) scanAuthImages(n); }));
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', () => scanAuthImages(document));

// Função para buscar tickets da API local

function isCurrentUserAdmin() {
    return String(_currentUser?.role || '').toLowerCase() === 'admin';
}

// "guest" = logou via SSO com um e-mail @dominio válido mas sem cadastro (ou
// sem perfil atribuído) em Pessoas — só pode ver a Dashboard (acompanhamento
// de chamados). Assim que um admin atribuir um perfil real em Pessoas, o
// próximo login já libera o restante do menu normalmente.
function isCurrentUserGuest() {
    return String(_currentUser?.role || '').toLowerCase() === 'guest';
}

async function loadCurrentUser() {
    const token = getAuthToken();
    if (!token) {
        try {
            const raw = localStorage.getItem('user');
            if (raw) _currentUser = JSON.parse(raw);
        } catch {}
        return _currentUser;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/me`, {
            headers: authHeaders()
        });
        if (!res.ok) return null;
        _currentUser = await res.json();
        renderSidebarUser();
        return _currentUser;
    } catch {
        try {
            const raw = localStorage.getItem('user');
            if (raw) _currentUser = JSON.parse(raw);
        } catch {}
        return _currentUser;
    }
}

// Abas cujo acesso é configurável em Configurações → Acesso (por perfil).
// "Pessoas" e "Configurações" ficam de fora de propósito — continuam
// restritas a admin sempre, não fazem parte dessa configuração.
const TAB_PERMISSION_BTN_BY_KEY = {
    dashboard: 'navDashboard', chamados: 'navChamados',
    ouvidoria: 'navOuvidoria', gcc: 'navGcc', jira: 'navJira',
    movidesk: 'navMovidesk', incidentes: 'navIncidentes', reincidencias: 'navReincidencias',
};

async function applyRoleBasedNavigation() {
    const cfgBtn = document.getElementById('navConfiguracoes');
    if (!cfgBtn) return;

    const admin = isCurrentUserAdmin();

    // Pessoas e Configurações: sempre admin-only, não editável na tela de Acesso.
    cfgBtn.style.display = admin ? 'flex' : 'none';

    // Botão "Sincronizar" da aba Movidesk: também admin-only, mesmo critério.
    const mdSyncBtn = document.getElementById('mdSyncDbBtn');
    if (mdSyncBtn) mdSyncBtn.style.display = admin ? '' : 'none';

    if (admin) {
        // Admin sempre vê todas as abas configuráveis, sem depender do que
        // está salvo (evita alguém se trancar fora da própria conta por engano).
        Object.values(TAB_PERMISSION_BTN_BY_KEY).forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) btn.style.display = 'flex';
        });
    } else {
        // Fallback otimista enquanto a config não carrega — guest sempre
        // parte do fallback restrito, mesmo se a chamada abaixo falhar.
        let allowed = isCurrentUserGuest()
            ? ['dashboard']
            : ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk', 'incidentes', 'reincidencias'];
        try {
            const res = await fetch(`${API_BASE}/config/tab-permissions`, { headers: authHeaders() });
            if (res.ok) {
                const data = await res.json();
                const role = String(_currentUser?.role || '').toLowerCase();
                if (data.permissions && Array.isArray(data.permissions[role])) {
                    allowed = data.permissions[role];
                }
            }
        } catch (e) { /* mantém o fallback acima */ }

        Object.entries(TAB_PERMISSION_BTN_BY_KEY).forEach(([key, id]) => {
            const btn = document.getElementById(id);
            if (btn) btn.style.display = allowed.includes(key) ? 'flex' : 'none';
        });
    }

    // Renderiza avatar do usuário logado ao trocar de usuário
    renderSidebarUser();
}

// ─────────────────────────────────────────────────────────────────
// ÁREA DE PESSOAS — CRUD (variáveis declaradas em script.js)
// ─────────────────────────────────────────────────────────────────

function showLoginScreen(message = '') {
    // Login está em página separada — redireciona
    window.location.replace('/login.html');
}

function hideLoginScreen() {
    // No-op: login agora é página separada
}

function setLoginError(message) {
    const err = document.getElementById('loginError');
    if (!err) return;
    err.textContent = message;
    err.style.display = message ? 'block' : 'none';
}

// Login em si acontece em login.html (SSO Google via Google Identity Services);
// esta página só consome a sessão já criada (token no localStorage).

async function logout() {
    try {
        await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            headers: authHeaders()
        });
    } catch {}
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    _currentUser = null;
    _appInitialized = false;
    showLoginScreen();
}
