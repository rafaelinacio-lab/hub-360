
// ── dashboard.js — Tickets, sparklines, SLA cards e sincronização ─────────

// Cache separado dos tickets "ativos" (_cachedTickets, usado pelo Dashboard).
// A aba Movidesk agora tem filtro de status e mostra também os chamados já
// fechados/resolvidos/cancelados — por isso busca à parte, com ?scope=all,
// sem afetar os cards/contadores do Dashboard (que continuam só com ativos).
let _cachedMovideskTickets = [];

async function fetchMovideskTickets() {
    const response = await fetch(`${API_BASE}/tickets?scope=all`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`Erro na API: ${response.status}`);
    _cachedMovideskTickets = await response.json();
}

// Equipe do usuário logado: o Dashboard mostra por padrão só os chamados da(s) equipe(s)
// dele. Admin e supervisor podem alternar para "Todas as equipes" (lembrado no navegador).
let _escopoEquipeIniciado = false;
async function carregarEscopoEquipe() {
    const info = document.getElementById('escopoEquipeInfo');
    const sel = document.getElementById('filterEscopoEquipe');
    if (!info || !sel) return;
    let quer = 'minha';
    try { quer = localStorage.getItem('dashEscopoEquipe') === 'todas' ? 'todas' : 'minha'; } catch (e) { /* sem storage */ }
    try {
        const r = await fetch(`${API_BASE}/tickets/minha-equipe?equipe=${quer}`, { headers: authHeaders() });
        if (!r.ok) return;
        const d = await r.json();
        sel.style.display = d.podeVerTodas ? '' : 'none';
        sel.value = d.podeVerTodas ? quer : 'minha';
        if (!d.equipes.length) {
            info.textContent = 'Equipe não identificada — mostrando todos os chamados';
        } else if (d.filtrando) {
            info.textContent = `Equipe: ${d.equipes.join(', ')}`;
        } else {
            info.textContent = 'Todas as equipes';
        }
        info.style.display = '';
    } catch (e) { /* mantém o padrão do servidor */ }
    if (!_escopoEquipeIniciado) {
        _escopoEquipeIniciado = true;
        sel.addEventListener('change', () => {
            try { localStorage.setItem('dashEscopoEquipe', sel.value); } catch (e) { /* sem storage */ }
            fetchOpenTickets();
        });
    }
}

async function fetchOpenTickets() {
    const container = document.getElementById('cardsContainer');
    if (!container) return;
    
    try {
        await carregarEscopoEquipe();
        const escopoSel = document.getElementById('filterEscopoEquipe');
        const pedeTodas = escopoSel && escopoSel.style.display !== 'none' && escopoSel.value === 'todas';
        // Buscar tickets ativos
        const activeResponse = await fetch(`${API_BASE}/tickets${pedeTodas ? '?equipe=todas' : ''}`, {
            headers: authHeaders()
        });
        
        if (!activeResponse.ok) {
            throw new Error(`Erro na API: ${activeResponse.status}`);
        }
        
        const tickets = await activeResponse.json();
        
        _cachedTickets = tickets;

        try {
            populateDashboardFilters();
        } catch (filtersError) {
            console.error('Erro ao popular filtros da dashboard:', filtersError);
        }

        // Renderiza já respeitando busca, chips e filtros ativos — assim a renovação automática
        // (a cada 2 min) não "desfaz" o que o usuário filtrou.
        try {
            if (typeof applyDashboardFilters === 'function') applyDashboardFilters();
            else { renderTickets(tickets, container); updateSummaryCards(tickets); }
        } catch (summaryError) {
            console.error('Erro ao atualizar a dashboard:', summaryError);
            renderTickets(tickets, container);
        }

        try {
            await fetchMovideskTickets();
            populateMovideskFilters(_cachedMovideskTickets);
            applyMovideskFilters();
        } catch (movideskError) {
            console.error('Erro ao atualizar KPIs da aba Movidesk:', movideskError);
        }

        const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        localStorage.setItem('lastSyncTime', hora);
        updateSyncStatus(`⏰ Atualizado em ${hora} · renova a cada 2 min`);
        
    } catch (error) {
        console.error('Erro ao buscar chamados:', error);
        container.innerHTML = `
            <div style="grid-column: 1/-1; padding: 40px; text-align: center;">
                <p style="color: #e74c3c; font-size: 16px;">
                    Erro ao carregar chamados. Verifique se o servidor está rodando.
                </p>
                <p style="color: #95a5a6; font-size: 14px; margin-top: 10px;">
                    ${error.message}
                </p>
                <p style="color: #95a5a6; font-size: 12px; margin-top: 10px;">
                    Execute: <code style="background: #f5f5f5; padding: 2px 6px; border-radius: 3px;">npm start</code>
                </p>
            </div>
        `;
    }
}

// Renderiza sparkline em canvas
function drawSparkline(canvasId, data, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.clearRect(0, 0, width, height);
    
    if (!data || data.length === 0) return;
    
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    ctx.beginPath();
    
    data.forEach((value, index) => {
        const x = (index / (data.length - 1)) * width;
        const y = height - ((value - min) / range) * (height - 4) - 2;
        
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    
    ctx.stroke();
}

// Renderiza gráfico donut em SVG
function drawDonut(circleId, percentage, color) {
    const circle = document.getElementById(circleId);
    if (!circle) return;
    
    const circumference = 2 * Math.PI * 30; // raio = 30
    const offset = circumference - (percentage / 100) * circumference;
    
    circle.setAttribute('stroke', color);
    circle.setAttribute('stroke-dasharray', circumference);
    circle.setAttribute('stroke-dashoffset', offset);
}

// Status "encerrados" — pra esses, comparar o prazo do SLA com "agora" não
// faz sentido (um chamado fechado há meses sempre pareceria "fora do prazo").
// Usa a última atualização do chamado como aproximação de quando ele foi
// efetivamente encerrado, só pra decidir dentro/fora do prazo desses casos.
const MOVIDESK_CLOSED_BASE_STATUSES = new Set(['Closed', 'Resolved', 'Canceled']);

// Calcula contagens + listas de chamados por KPI (status/SLA/sem retorno) —
// função pura, sem tocar em DOM, pra poder ser reaproveitada tanto pela
// Dashboard (sempre com todos os tickets ativos) quanto pela aba Movidesk
// (chamados ativos + encerrados, já filtrados pelos selects de status/
// equipe/responsável/serviço/etc).
function computeKpiCounts(tickets) {
    const counts = { New: 0, InAttendance: 0, Stopped: 0, onTime: 0, overdue: 0 };
    const kpiLists = { New: [], InAttendance: [], Stopped: [], Total: [], onTime: [], overdue: [], noAgentResponse: [] };

    (tickets || []).forEach(t => {
        const baseStatusRaw = getTicketValue(t, 'baseStatus', 'basestatus', '') || getTicketValue(t, 'status', 'status', '');
        const baseStatus = normalizeDashboardBaseStatus(baseStatusRaw);
        if (counts[baseStatus] !== undefined) counts[baseStatus]++;
        if (kpiLists[baseStatus]) kpiLists[baseStatus].push(t);
        kpiLists.Total.push(t);

        // "Sem retorno do agente" — a última ação no chamado foi do cliente,
        // ou seja, o agente ainda não respondeu de volta (aba Movidesk).
        const lastActionOrigin = getTicketValue(t, 'lastActionOrigin', 'lastactionorigin', '');
        if (lastActionOrigin === 'Customer') kpiLists.noAgentResponse.push(t);

        // Contar SLA
        const slaSolutionDateIsPaused = getTicketValue(t, 'slaSolutionDateIsPaused', 'slasolutiondateispaused', false);
        const slaSolutionDate = getTicketValue(t, 'slaSolutionDate', 'slasolutiondate', '');
        const slaSolutionTime = getTicketValue(t, 'slaSolutionTime', 'slasolutiontime', '');
        const createdDate = getTicketValue(t, 'createdDate', 'createddate', '');

        const isClosed = MOVIDESK_CLOSED_BASE_STATUSES.has(baseStatusRaw);
        const lastUpdate = getTicketValue(t, 'lastUpdate', 'lastupdate', '') || getTicketValue(t, 'lastActionDate', 'lastactiondate', '');
        const referenceNow = (isClosed && lastUpdate) ? new Date(lastUpdate) : new Date();

        if (slaSolutionDateIsPaused !== 1 && slaSolutionDateIsPaused !== true && slaSolutionDate) {
            const deadline = new Date(slaSolutionDate);
            if (referenceNow < deadline) {
                counts.onTime++;
                kpiLists.onTime.push(t);
            } else {
                counts.overdue++;
                kpiLists.overdue.push(t);
            }
        } else if (slaSolutionDateIsPaused && slaSolutionTime && createdDate) {
            const created = new Date(createdDate);
            const deadline = new Date(created.getTime() + slaSolutionTime * 60000);
            if (referenceNow < deadline) {
                counts.onTime++;
                kpiLists.onTime.push(t);
            } else {
                counts.overdue++;
                kpiLists.overdue.push(t);
            }
        }
    });

    return { counts, kpiLists };
}

// Atualiza os cards de resumo por status e SLA (Dashboard)
function updateSummaryCards(tickets) {
    const { counts, kpiLists } = computeKpiCounts(tickets);

    window._dashboardKpiLists = kpiLists;

    const total = counts.New + counts.InAttendance + counts.Stopped;
    document.getElementById('countNew').textContent = counts.New;
    document.getElementById('countInAttendance').textContent = counts.InAttendance;
    document.getElementById('countStopped').textContent = counts.Stopped;
    document.getElementById('countTotal').textContent = total;
    document.getElementById('countOnTime').textContent = counts.onTime;
    document.getElementById('countOverdue').textContent = counts.overdue;

    // Barra de saúde do SLA + percentuais (números reais dos chamados em tela)
    const totalTk = (tickets || []).length;
    const pct = (n) => (totalTk > 0 ? (n / totalTk) * 100 : 0);
    const outros = Math.max(0, totalTk - counts.onTime - counts.overdue);
    const setW = (id, v) => { const el = document.getElementById(id); if (el) el.style.width = v.toFixed(2) + '%'; };
    setW('slaBarOk', pct(counts.onTime));
    setW('slaBarOther', pct(outros));
    setW('slaBarLate', pct(counts.overdue));
    const fmtPctBr = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    document.getElementById('pctOnTime').textContent = fmtPctBr(pct(counts.onTime));
    document.getElementById('pctOverdue').textContent = fmtPctBr(pct(counts.overdue));
    const bar = document.getElementById('slaBar');
    if (bar) bar.setAttribute('aria-label', `SLA: ${counts.onTime} no prazo, ${outros} pausados ou sem prazo, ${counts.overdue} atrasados`);

    // Gerar insight do card "Fora do Prazo" (desativado temporariamente)
    const insightEl = document.getElementById('overdueInsight');
    if (insightEl) insightEl.textContent = '';

    // A carga por atendente sempre considera todos os chamados carregados (não só os filtrados),
    // senão clicar num atendente faria os outros sumirem da lista.
    const base = (typeof _cachedTickets !== 'undefined' && _cachedTickets && _cachedTickets.length) ? _cachedTickets : (tickets || []);
    updateAttendantsList(buildAttendantMap(base));
    updateQuickChipCounts(base);
}

// ─── Aba Movidesk: KPIs com filtros próprios ───────────────────────────────
// Os filtros (status/equipe/responsável/serviço/cliente/classificação)
// recortam _cachedMovideskTickets (ativos + encerrados) antes de calcular os
// KPIs — não afetam a Dashboard, que usa _cachedTickets (só ativos) e sempre
// olha o total sem filtro.
function updateMovideskKpis(tickets) {
    const { counts, kpiLists } = computeKpiCounts(tickets);
    window._movideskKpiLists = kpiLists;

    // "Total de chamados" aqui é a lista filtrada inteira, não só os buckets
    // abertos (New/InAttendance/Stopped) — a aba agora mostra também
    // fechados/resolvidos/cancelados/sem status.
    const total = kpiLists.Total.length;
    const mdTotal = document.getElementById('mdCountTotal');
    if (mdTotal) mdTotal.textContent = total;
    const mdOnTime = document.getElementById('mdCountOnTime');
    if (mdOnTime) mdOnTime.textContent = counts.onTime;
    const mdOverdue = document.getElementById('mdCountOverdue');
    if (mdOverdue) mdOverdue.textContent = counts.overdue;
    const mdNoResponse = document.getElementById('mdCountNoResponse');
    if (mdNoResponse) mdNoResponse.textContent = kpiLists.noAgentResponse.length;

    updateMovideskCharts(tickets);
}

// "Classificação" = valor do campo personalizado do Movidesk
// cf_classificacao_de_ticket, já persistido como coluna própria na tabela
// tickets (populado no sync, sem chamada à API do Movidesk aqui).
function getMovideskClassificacao(ticket) {
    return getTicketValue(ticket, 'cf_classificacao_de_ticket', 'cf_classificacao_de_ticket', '');
}

// Sentinela pro filtro de status representar chamados com baseStatus
// NULL/vazio no banco (linhas "stub" de sync antiga incompleta — só têm id,
// sem os outros dados do chamado). Precisa ser idêntica à constante
// MOVIDESK_STATUS_NONE em server/routes/tickets.js.
const MOVIDESK_STATUS_NONE = '__sem_status__';

const MOVIDESK_STATUS_LABELS = {
    New: 'Novo',
    InAttendance: 'Em Atendimento',
    InProgress: 'Em Atendimento',
    Stopped: 'Aguardando',
    Closed: 'Fechado',
    Resolved: 'Resolvido',
    Canceled: 'Cancelado',
};
const MOVIDESK_STATUS_ORDER = ['New', 'InAttendance', 'InProgress', 'Stopped', 'Closed', 'Resolved', 'Canceled', MOVIDESK_STATUS_NONE];

function getMovideskStatusValue(t) {
    return getTicketValue(t, 'baseStatus', 'basestatus', '') || MOVIDESK_STATUS_NONE;
}

function getMovideskStatusLabel(value) {
    if (value === MOVIDESK_STATUS_NONE) return 'Sem classificação';
    return MOVIDESK_STATUS_LABELS[value] || value;
}

const MOVIDESK_FILTER_CONFIG = [
    { id: 'mdFilterStatus', label: 'Todos os status', apiKey: 'statuses', getVal: getMovideskStatusValue, labelFn: getMovideskStatusLabel },
    { id: 'mdFilterEquipe', label: 'Todas as equipes', apiKey: 'equipes', getVal: (t) => getTicketValue(t, 'ownerTeam', 'ownerteam', '') },
    { id: 'mdFilterResponsavel', label: 'Todos os responsáveis', apiKey: 'responsaveis', getVal: (t) => getTicketValue(t, 'ownerName', 'ownername', '') },
    { id: 'mdFilterServico', label: 'Todos os serviços', apiKey: 'servicos', getVal: (t) => getTicketValue(t, 'serviceFirstLevel', 'servicefirstlevel', '') },
    { id: 'mdFilterCliente', label: 'Todos os clientes (organização)', apiKey: 'clientes', getVal: (t) => getTicketValue(t, 'clientOrganization', 'clientorganization', '') },
    { id: 'mdFilterClassificacao', label: 'Todas as classificações', apiKey: 'classificacoes', getVal: getMovideskClassificacao },
];

function renderMovideskFilterOptions(id, label, values, labelFn) {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">${label}</option>` +
        values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(labelFn ? labelFn(v) : v)}</option>`).join('');
    select.value = current;
}

// Status segue uma ordem fixa (aberto → encerrado → sem classificação) em
// vez de alfabética — os outros filtros continuam em ordem alfabética pt-BR.
function sortMovideskFilterValues(apiKey, values) {
    if (apiKey !== 'statuses') return [...values].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return [...values].sort((a, b) => MOVIDESK_STATUS_ORDER.indexOf(a) - MOVIDESK_STATUS_ORDER.indexOf(b));
}

// Busca os valores distintos de cada select direto do banco (endpoint próprio,
// sem LIMIT, sobre todos os chamados) em vez de derivar dos tickets já
// carregados na tela — assim um valor novo (status/equipe/cliente/etc.)
// aparece na lista assim que existir no banco, mesmo que só em chamados
// encerrados.
async function populateMovideskFilters(tickets) {
    try {
        const response = await fetch(`${API_BASE}/tickets/filters`, { headers: authHeaders() });
        if (!response.ok) throw new Error(`Erro na API: ${response.status}`);
        const data = await response.json();
        MOVIDESK_FILTER_CONFIG.forEach(({ id, label, apiKey, labelFn }) => {
            const values = sortMovideskFilterValues(apiKey, data[apiKey] || []);
            renderMovideskFilterOptions(id, label, values, labelFn);
        });
    } catch (error) {
        console.warn('Falha ao buscar filtros da aba Movidesk no banco, usando tickets carregados:', error.message);
        // Fallback: deriva as opções a partir dos tickets já carregados na tela.
        MOVIDESK_FILTER_CONFIG.forEach(({ id, label, getVal, labelFn, apiKey }) => {
            const values = sortMovideskFilterValues(apiKey, [...new Set((tickets || []).map(getVal).filter(Boolean))]);
            renderMovideskFilterOptions(id, label, values, labelFn);
        });
    }
}

function getMovideskFilteredTickets() {
    const activeFilters = MOVIDESK_FILTER_CONFIG
        .map(({ id, getVal }) => ({ value: document.getElementById(id)?.value || '', getVal }))
        .filter((f) => f.value);

    if (!activeFilters.length) return _cachedMovideskTickets || [];

    return (_cachedMovideskTickets || []).filter((t) =>
        activeFilters.every(({ value, getVal }) => getVal(t) === value)
    );
}

function applyMovideskFilters() {
    updateMovideskKpis(getMovideskFilteredTickets());
}

// ─── Aba Movidesk: gráficos (ranking + rosca) — usam a mesma lista já
// filtrada pelos 5 filtros acima dos KPIs, sem chamada nova à API.
const MOVIDESK_RANKING_TOP_N = 8;
const MOVIDESK_DONUT_TOP_N = 6;
const MOVIDESK_DONUT_PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16'];

function getMovideskElapsedDays(from, to = new Date()) {
    const start = from ? new Date(from) : null;
    if (!start || isNaN(start) || !to || isNaN(to)) return null;
    return Math.max(0, Math.floor((to - start) / MS_DIA_UTIL));
}

function getMovideskLifetimeDays(ticket) {
    const createdDate = getTicketValue(ticket, 'createdDate', 'createddate', '');
    const baseStatus = getTicketValue(ticket, 'baseStatus', 'basestatus', '');
    // Chamados encerrados param de envelhecer na última atualização.
    const endDate = MOVIDESK_CLOSED_BASE_STATUSES.has(baseStatus)
        ? (getTicketValue(ticket, 'lastUpdate', 'lastupdate', '') || getTicketValue(ticket, 'lastActionDate', 'lastactiondate', ''))
        : new Date();
    return getMovideskElapsedDays(createdDate, endDate);
}

function getMovideskNoResponseDays(ticket) {
    if (getTicketValue(ticket, 'lastActionOrigin', 'lastactionorigin', '') !== 'Customer') return null;
    const lastActionDate = getTicketValue(ticket, 'lastActionDate', 'lastactiondate', '')
        || getTicketValue(ticket, 'lastUpdate', 'lastupdate', '');
    return getMovideskElapsedDays(lastActionDate);
}

function getMovideskDaysBucket(days) {
    if (days === null || days === undefined) return '';
    if (days <= 1) return '0–1 dia';
    if (days <= 3) return '2–3 dias';
    if (days <= 7) return '4–7 dias';
    if (days <= 14) return '8–14 dias';
    if (days <= 30) return '15–30 dias';
    return '31+ dias';
}

function countMovideskBy(tickets, getVal, orderedLabels = []) {
    const counts = new Map();
    (tickets || []).forEach((t) => {
        const val = String(getVal(t) || '').trim();
        if (!val) return;
        counts.set(val, (counts.get(val) || 0) + 1);
    });
    const values = [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
    if (!orderedLabels.length) return values;
    return values.sort((a, b) => orderedLabels.indexOf(a.label) - orderedLabels.indexOf(b.label));
}

function renderMovideskRanking(containerId, items, emptyMsg) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const top = items.slice(0, MOVIDESK_RANKING_TOP_N);
    if (!top.length) {
        el.innerHTML = `<p class="md-chart-empty">${emptyMsg}</p>`;
        return;
    }
    const max = Math.max(...top.map((i) => i.count), 1);
    el.innerHTML = top.map((it) => {
        const pct = Math.max(4, Math.round((it.count / max) * 100));
        return `
        <div class="md-rank-row" title="${escapeHtml(it.label)}: ${it.count} chamado${it.count !== 1 ? 's' : ''}">
            <span class="md-rank-label">${escapeHtml(it.label)}</span>
            <div class="md-rank-track"><div class="md-rank-fill" style="width:${pct}%"></div></div>
            <span class="md-rank-value">${it.count}</span>
        </div>`;
    }).join('');
}

function renderMovideskDonut(containerId, items, emptyMsg) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items.length) {
        el.innerHTML = `<p class="md-chart-empty">${emptyMsg}</p>`;
        return;
    }

    // Agrupa o restante em "Outros" pra rosca não ficar com dezenas de fatias
    // minúsculas — o total continua batendo com a soma real.
    const top = items.slice(0, MOVIDESK_DONUT_TOP_N);
    const restTotal = items.slice(MOVIDESK_DONUT_TOP_N).reduce((s, it) => s + it.count, 0);
    const slices = restTotal > 0 ? [...top, { label: 'Outros', count: restTotal }] : top;

    const total = slices.reduce((s, it) => s + it.count, 0) || 1;
    let acc = 0;
    const stops = slices.map((it, i) => {
        const color = MOVIDESK_DONUT_PALETTE[i % MOVIDESK_DONUT_PALETTE.length];
        const start = (acc / total) * 100;
        acc += it.count;
        const end = (acc / total) * 100;
        return `${color} ${start}% ${end}%`;
    }).join(', ');

    const legend = slices.map((it, i) => {
        const color = MOVIDESK_DONUT_PALETTE[i % MOVIDESK_DONUT_PALETTE.length];
        const pct = Math.round((it.count / total) * 100);
        return `
        <div class="md-donut-legend-item" title="${escapeHtml(it.label)}: ${it.count} chamado${it.count !== 1 ? 's' : ''} (${pct}%)">
            <span class="md-donut-dot" style="background:${color}"></span>
            <span class="md-donut-legend-label">${escapeHtml(it.label)}</span>
            <span class="md-donut-legend-value">${it.count}</span>
        </div>`;
    }).join('');

    el.innerHTML = `
        <div class="md-donut-wrap">
            <div class="md-donut" style="background: conic-gradient(${stops})"></div>
            <div class="md-donut-hole"><span>${total}</span><small>chamados</small></div>
        </div>
        <div class="md-donut-legend">${legend}</div>`;
}

// Metadados dos 4 gráficos da aba Movidesk — usados tanto pra montar os cards
// (tops) quanto pelo modal "ver tudo" (lista completa + drill-down por item).
const MOVIDESK_CHART_META = {
    cliente: { title: 'Clientes (Organização)', getVal: (t) => getTicketValue(t, 'clientOrganization', 'clientorganization', '') },
    atendente: { title: 'Atendentes (Responsável)', getVal: (t) => getTicketValue(t, 'ownerName', 'ownername', '') },
    classificacao: { title: 'Classificação', getVal: getMovideskClassificacao },
    servico: { title: 'Serviço', getVal: (t) => getTicketValue(t, 'serviceFirstLevel', 'servicefirstlevel', '') },
    tempoVida: { title: 'Tempo de vida', getVal: (t) => getMovideskDaysBucket(getMovideskLifetimeDays(t)), orderedLabels: ['0–1 dia', '2–3 dias', '4–7 dias', '8–14 dias', '15–30 dias', '31+ dias'] },
    semRetornoDias: { title: 'Dias sem retorno do agente', getVal: (t) => getMovideskDaysBucket(getMovideskNoResponseDays(t)), orderedLabels: ['0–1 dia', '2–3 dias', '4–7 dias', '8–14 dias', '15–30 dias', '31+ dias'] },
};

function updateMovideskCharts(tickets) {
    const full = {};
    Object.entries(MOVIDESK_CHART_META).forEach(([kind, { getVal, orderedLabels }]) => {
        full[kind] = countMovideskBy(tickets, getVal, orderedLabels);
    });
    // Lista completa (sem cortar nos tops) — alimenta o modal "ver tudo".
    window._movideskChartFull = full;

    renderMovideskRanking('mdChartCliente', full.cliente, 'Sem organização identificada nos chamados filtrados.');
    renderMovideskRanking('mdChartAtendente', full.atendente, 'Sem responsável atribuído nos chamados filtrados.');
    renderMovideskRanking('mdChartClassificacao', full.classificacao, 'Sem classificação identificada nos chamados filtrados.');
    renderMovideskDonut('mdChartServico', full.servico, 'Sem serviço identificado nos chamados filtrados.');
    renderMovideskRanking('mdChartTempoVida', full.tempoVida, 'Sem data de abertura identificada nos chamados filtrados.');
    renderMovideskRanking('mdChartSemRetornoDias', full.semRetornoDias, 'Nenhum chamado sem retorno do agente nos filtros atuais.');
}

function clearMovideskFilters() {
    MOVIDESK_FILTER_CONFIG.forEach(({ id }) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    applyMovideskFilters();
}

// Botão "Sincronizar" da aba Movidesk (admin-only, ver auth.js). Não fala com
// a API do Movidesk — só força reler agora a tabela `tickets` do banco
// (mesma leitura que já roda sozinha a cada 60s via fetchOpenTickets), pra
// quem não quiser esperar o próximo ciclo automático.
async function syncMovideskDb() {
    const btn = document.getElementById('mdSyncDbBtn');
    if (btn) {
        if (!btn.dataset.originalLabel) btn.dataset.originalLabel = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = '<span class="config-btn-spinner"></span> Sincronizando...';
    }
    updateSyncStatus('🔄 Sincronizando com o banco...');
    try {
        await fetchOpenTickets();
    } catch (error) {
        updateSyncStatus(`Falha ao sincronizar: ${error.message}`, true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn.dataset.originalLabel;
        }
    }
}

// Data da última ação do tipo 2 (interação pública/real com o cliente, não
// nota interna) — usada pra "Data da Última Ação" e "Dias Sem Retorno".
// actionsJson vem cru da API do Movidesk (id, type, origin, createdDate...).
function getLastPublicActionDate(ticket) {
    const actions = ticket.actionsJson || ticket.actionsjson;
    if (!Array.isArray(actions) || !actions.length) return null;
    let latest = null;
    actions.forEach((a) => {
        if (a.type !== 2 || !a.createdDate) return;
        const d = new Date(a.createdDate);
        if (!isNaN(d) && (!latest || d > latest)) latest = d;
    });
    return latest;
}

function fmtKpiDate(date) {
    return date ? date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
}

// ─── Horas úteis (mesma regra do SLA em server/utils/sla.js) ───────────────
// Seg-sex, 07:45-12:00 e 13:30-18:00. Usa getUTCHours/getUTCDay de propósito,
// igual ao backend, pra ficar consistente com o resto do sistema — as datas
// que chegam da API já vêm "alinhadas" nesse esquema.
const SLA_HORARIOS_ATENDIMENTO = [
    { inicio: 7, inicioMin: 45, fim: 12, fimMin: 0 },
    { inicio: 13, inicioMin: 30, fim: 18, fimMin: 0 },
];

function slaEhDiaUtil(data) {
    const dia = data.getUTCDay();
    return dia !== 0 && dia !== 6;
}

function slaMinutosUteisEntre(inicio, fim) {
    if (!inicio || !fim || fim <= inicio) return 0;
    let total = 0;
    const diaAtual = new Date(inicio);
    diaAtual.setUTCHours(0, 0, 0, 0);
    const diaFinal = new Date(fim);
    diaFinal.setUTCHours(0, 0, 0, 0);

    while (diaAtual <= diaFinal) {
        if (slaEhDiaUtil(diaAtual)) {
            for (const periodo of SLA_HORARIOS_ATENDIMENTO) {
                const periodoInicio = new Date(diaAtual);
                periodoInicio.setUTCHours(periodo.inicio, periodo.inicioMin, 0, 0);
                const periodoFim = new Date(diaAtual);
                periodoFim.setUTCHours(periodo.fim, periodo.fimMin, 0, 0);

                const inicioCalculo = new Date(Math.max(inicio.getTime(), periodoInicio.getTime()));
                const fimCalculo = new Date(Math.min(fim.getTime(), periodoFim.getTime()));

                if (fimCalculo > inicioCalculo) {
                    total += Math.floor((fimCalculo - inicioCalculo) / 60000);
                }
            }
        }
        diaAtual.setUTCDate(diaAtual.getUTCDate() + 1);
    }
    return total;
}

function fmtKpiDays(days) {
    if (days === null || days === undefined || isNaN(days)) return '—';
    return `${days} dia${days === 1 ? '' : 's'}`;
}

// Formata o tempo decorrido desde `date`: em dias corridos normalmente, mas
// se ainda não fez 24h corridas, mostra em horas úteis (regra do SLA) em vez
// de arredondar pra "0 dias" — mais preciso pra chamados recentes.
const MS_DIA_UTIL = 24 * 60 * 60 * 1000;

function fmtElapsedSince(date) {
    if (!date || isNaN(date)) return '—';
    const now = new Date();
    const rawMs = now - date;
    if (rawMs < MS_DIA_UTIL) {
        const horas = Math.round(slaMinutosUteisEntre(date, now) / 60);
        return `${horas}h`;
    }
    return fmtKpiDays(Math.floor(rawMs / MS_DIA_UTIL));
}

// ─── Modal de chamados de um KPI da Dashboard ──────────────────────────────
// Abre ao clicar num card de resumo (Novos/Em Atendimento/Aguardando/Total/
// Dentro do Prazo/Fora do Prazo/Sem Retorno) e lista os chamados que compõem
// aquele número: ID como link direto pro Movidesk, urgência, organização,
// assunto, owner, data de abertura, data da última ação pública (type 2),
// tempo de vida (hoje - abertura) e dias sem retorno (hoje - última ação tipo 2).
const KPI_URGENCY_RANK = { 'Crítica': 0, 'Alta': 1, 'Média': 2, 'Baixa': 3, 'Sem SLA': 4, 'Indefinida': 5 };

// Estado da ordenação — guarda as linhas já "enriquecidas" (com os valores
// crus, não só o texto formatado) pra poder reordenar sem refazer os cálculos
// de data/urgência a cada clique no cabeçalho.
let _kpiModalRows = [];
let _kpiModalSortKey = null;
let _kpiModalSortAsc = true;

function openKpiModal(kpiKey, title, source) {
    const listsObj = source === 'movidesk' ? window._movideskKpiLists : window._dashboardKpiLists;
    const list = (listsObj && listsObj[kpiKey]) || [];
    openTicketsListModal(list, title);
}

// Preenche e abre o modal de chamados a partir de uma lista já pronta —
// reaproveitado tanto pelos KPIs (openKpiModal) quanto pelo drill-down de um
// item específico do modal "ver tudo" dos gráficos (openMdCategoryTickets).
function openTicketsListModal(list, title) {
    const modal = document.getElementById('kpiTicketsModal');
    const titleEl = document.getElementById('kpiTicketsTitle');
    const countEl = document.getElementById('kpiTicketsCount');
    if (!modal) return;

    if (titleEl) titleEl.textContent = title || 'Chamados';
    if (countEl) countEl.textContent = `${list.length} chamado${list.length === 1 ? '' : 's'}`;

    const now = new Date();
    _kpiModalRows = list.map((t) => {
        const urgency = getUrgencyFromSLA(getTicketValue(t, 'slaAgreementRule', 'slaagreementrule', ''));
        const subject = t.subject || getTicketValue(t, 'subject', 'subject', '—');
        const org = getTicketValue(t, 'clientOrganization', 'clientorganization', '—');
        const owner = getTicketValue(t, 'ownerName', 'ownername', '—');

        const createdRaw = getTicketValue(t, 'createdDate', 'createddate', null);
        const abertura = createdRaw ? new Date(createdRaw) : null;
        const ultimaAcao = getLastPublicActionDate(t);
        const diasSemRetorno = ultimaAcao ? Math.floor((now - ultimaAcao) / MS_DIA_UTIL) : null;

        return {
            id: Number(t.id),
            urgencyLabel: urgency.label,
            urgencyClass: urgency.class,
            urgencyRank: KPI_URGENCY_RANK[urgency.label] ?? 9,
            org, subject, owner,
            abertura, ultimaAcao,
            tempoVidaMs: abertura && !isNaN(abertura) ? (now - abertura) : null,
            diasSemRetornoMs: ultimaAcao ? (now - ultimaAcao) : null,
            diasSemRetornoWarn: diasSemRetorno !== null && diasSemRetorno >= 3,
        };
    });

    // Sem ordenação ativa ao abrir — mantém a ordem original da lista do KPI.
    _kpiModalSortKey = null;
    _kpiModalSortAsc = true;
    renderKpiModalRows();

    modal.style.display = 'flex';
}

function renderKpiModalRows() {
    const tbody = document.getElementById('kpiTicketsTbody');
    if (!tbody) return;

    document.querySelectorAll('.kpi-tickets-table th.kpi-sortable').forEach((th) => {
        th.classList.remove('kpi-sort-active');
        const ind = th.querySelector('.kpi-sort-indicator');
        if (ind) ind.textContent = '↕';
    });
    if (_kpiModalSortKey) {
        const activeTh = document.querySelector(`.kpi-sort-indicator[data-key="${_kpiModalSortKey}"]`)?.closest('th');
        if (activeTh) {
            activeTh.classList.add('kpi-sort-active');
            activeTh.querySelector('.kpi-sort-indicator').textContent = _kpiModalSortAsc ? '▲' : '▼';
        }
    }

    if (!_kpiModalRows.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="kpi-tickets-empty">Nenhum chamado nesta lista.</td></tr>';
        return;
    }

    const rows = _kpiModalSortKey ? sortKpiRows(_kpiModalRows, _kpiModalSortKey, _kpiModalSortAsc) : _kpiModalRows;

    tbody.innerHTML = rows.map((r) => {
        const diasSemRetornoClass = r.diasSemRetornoWarn ? 'kpi-ticket-days-warn' : '';
        return `
            <tr>
                <td><a class="kpi-ticket-link" href="https://viasoft.movidesk.com/Ticket/Edit/${r.id}" target="_blank" rel="noopener noreferrer">#${r.id}</a></td>
                <td><span class="urgency-bubble ${r.urgencyClass}">${r.urgencyLabel}</span></td>
                <td class="kpi-ticket-truncate" title="${escapeHtml(r.org)}">${escapeHtml(r.org)}</td>
                <td class="kpi-ticket-subject" title="${escapeHtml(r.subject)}">${escapeHtml(r.subject)}</td>
                <td class="kpi-ticket-truncate" title="${escapeHtml(r.owner)}">${escapeHtml(r.owner)}</td>
                <td class="kpi-ticket-date">${fmtKpiDate(r.abertura)}</td>
                <td class="kpi-ticket-date">${fmtKpiDate(r.ultimaAcao)}</td>
                <td class="kpi-ticket-days">${r.tempoVidaMs !== null ? fmtElapsedSince(r.abertura) : '—'}</td>
                <td class="kpi-ticket-days ${diasSemRetornoClass}">${r.ultimaAcao ? fmtElapsedSince(r.ultimaAcao) : '—'}</td>
            </tr>`;
    }).join('');
}

function sortKpiRows(rows, key, asc) {
    const dir = asc ? 1 : -1;
    // Nulos sempre no final, independente da direção.
    const val = (r) => {
        switch (key) {
            case 'id': return r.id;
            case 'urgencia': return r.urgencyRank;
            case 'org': return r.org?.toLowerCase() || '';
            case 'assunto': return r.subject?.toLowerCase() || '';
            case 'owner': return r.owner?.toLowerCase() || '';
            case 'abertura': return r.abertura ? r.abertura.getTime() : null;
            case 'ultimaAcao': return r.ultimaAcao ? r.ultimaAcao.getTime() : null;
            case 'tempoVida': return r.tempoVidaMs;
            case 'diasSemRetorno': return r.diasSemRetornoMs;
            default: return null;
        }
    };
    return [...rows].sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        if (typeof va === 'string') return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
    });
}

function sortKpiModal(key) {
    if (_kpiModalSortKey === key) {
        _kpiModalSortAsc = !_kpiModalSortAsc;
    } else {
        _kpiModalSortKey = key;
        _kpiModalSortAsc = true;
    }
    renderKpiModalRows();
}

function closeKpiModal() {
    const modal = document.getElementById('kpiTicketsModal');
    if (modal) modal.style.display = 'none';
}

// ─── Modal "ver tudo" dos gráficos da aba Movidesk ─────────────────────────
// Os cards de Cliente/Atendente/Classificação/Serviço só mostram os tops
// (MOVIDESK_RANKING_TOP_N / MOVIDESK_DONUT_TOP_N) pra não virar uma parede de
// barrinhas minúsculas. Clicando no card, este modal traz 100% dos itens
// (com busca) e cada linha abre os chamados daquele item específico,
// respeitando os filtros já ativos na aba (reaproveita o modal de KPI).
let _mdChartModalKind = null;
let _mdChartModalAllItems = [];
let _mdChartModalRenderedItems = [];

function openMdChartModal(kind) {
    const meta = MOVIDESK_CHART_META[kind];
    const items = (window._movideskChartFull && window._movideskChartFull[kind]) || [];
    if (!meta) return;

    _mdChartModalKind = kind;
    _mdChartModalAllItems = items;

    const modal = document.getElementById('mdChartModal');
    if (!modal) return;
    const titleEl = document.getElementById('mdChartModalTitle');
    const countEl = document.getElementById('mdChartModalCount');
    const searchEl = document.getElementById('mdChartModalSearch');
    const total = items.reduce((s, it) => s + it.count, 0);

    if (titleEl) titleEl.textContent = meta.title;
    if (countEl) countEl.textContent = `${items.length} ite${items.length === 1 ? 'm' : 'ns'} · ${total} chamado${total === 1 ? '' : 's'}`;
    if (searchEl) searchEl.value = '';

    renderMdChartModalRows(items);
    modal.style.display = 'flex';
}

function renderMdChartModalRows(items) {
    _mdChartModalRenderedItems = items;
    const body = document.getElementById('mdChartModalBody');
    if (!body) return;

    if (!items.length) {
        body.innerHTML = '<p class="md-chart-empty">Nenhum item encontrado.</p>';
        return;
    }

    const max = Math.max(...items.map((i) => i.count), 1);
    body.innerHTML = items.map((it, idx) => {
        const pct = Math.max(4, Math.round((it.count / max) * 100));
        return `
        <div class="md-rank-row md-rank-row-clickable" data-idx="${idx}" title="Ver chamados de ${escapeHtml(it.label)}">
            <span class="md-rank-label">${escapeHtml(it.label)}</span>
            <div class="md-rank-track"><div class="md-rank-fill" style="width:${pct}%"></div></div>
            <span class="md-rank-value">${it.count}</span>
        </div>`;
    }).join('');
}

function filterMdChartModal(query) {
    const q = (query || '').trim().toLowerCase();
    const filtered = q ? _mdChartModalAllItems.filter((it) => it.label.toLowerCase().includes(q)) : _mdChartModalAllItems;
    renderMdChartModalRows(filtered);
}

function closeMdChartModal() {
    const modal = document.getElementById('mdChartModal');
    if (modal) modal.style.display = 'none';
}

// Clique numa linha do "ver tudo" abre os chamados daquele item específico
// (delegado no body do modal, já que as linhas são recriadas a cada render).
document.addEventListener('click', (e) => {
    const row = e.target.closest('#mdChartModalBody .md-rank-row-clickable');
    if (!row) return;
    const item = _mdChartModalRenderedItems[Number(row.dataset.idx)];
    const meta = MOVIDESK_CHART_META[_mdChartModalKind];
    if (!item || !meta) return;

    const tickets = getMovideskFilteredTickets().filter((t) => String(meta.getVal(t) || '').trim() === item.label);
    closeMdChartModal();
    openTicketsListModal(tickets, `${meta.title}: ${item.label}`);
});

// ── Carga por atendente ──────────────────────────────────────────────────────
function buildAttendantMap(tickets) {
    const map = {};
    (tickets || []).forEach(t => {
        const owner = getTicketValue(t, 'ownerName', 'ownername', 'Sem atribuição') || 'Sem atribuição';
        const email = getTicketValue(t, 'ownerEmail', 'owneremail', '');
        if (!map[owner]) map[owner] = { count: 0, late: 0, email };
        map[owner].count++;
        if (tkSlaInfo(t).kind === 'late') map[owner].late++;
    });
    return map;
}

function updateAttendantsList(attendantMap) {
    const container = document.getElementById('attendantsContainer');
    if (!container) return;
    const ativo = document.getElementById('filterAtendente')?.value || '';
    const entradas = Object.entries(attendantMap).sort((a, b) => b[1].count - a[1].count);
    const max = entradas.length ? entradas[0][1].count : 1;
    container.innerHTML = entradas.map(([name, d]) => `
        <button type="button" class="att-row" data-att="${escapeHtml(name)}" aria-pressed="${ativo === name}" title="Filtrar pelos chamados de ${escapeHtml(name)}">
            ${createAvatarHTML(d.email || null, name)}
            <span class="att-nome">${escapeHtml(name)}</span>
            <span class="att-n">${d.count}</span>
            <span class="att-barra"><i class="${d.late ? 'tem-atraso' : ''}" style="width:${Math.max(6, (d.count / max) * 100)}%"></i></span>
            <span class="att-meta">${d.late ? `${d.late} fora do prazo` : 'nenhum fora do prazo'}</span>
        </button>`).join('') || '<p style="color: var(--muted);">Nenhum atendente</p>';
    container.querySelectorAll('.att-row').forEach(btn => btn.addEventListener('click', () => {
        const sel = document.getElementById('filterAtendente');
        if (!sel) return;
        sel.value = sel.value === btn.dataset.att ? '' : btn.dataset.att;
        applyDashboardFilters();
    }));
}

function toggleAttendant(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('expanded');
}

// ── Lista densa de chamados ─────────────────────────────────────────────────
// Situação do prazo de solução: late | soon (< 2 h) | ok | paused | none, com o texto pronto.
function tkSlaInfo(t) {
    const paused = getTicketValue(t, 'slaSolutionDateIsPaused', 'slasolutiondateispaused', false);
    const isPaused = paused === 1 || paused === true;
    const dl = getTicketValue(t, 'slaSolutionDate', 'slasolutiondate', '');
    const slaTime = getTicketValue(t, 'slaSolutionTime', 'slasolutiontime', '');
    const created = getTicketValue(t, 'createdDate', 'createddate', '');
    let deadline = null;
    if (dl) deadline = new Date(dl);
    else if (isPaused && slaTime && created) deadline = new Date(new Date(created).getTime() + slaTime * 60000);
    if (!deadline || isNaN(deadline)) return { kind: isPaused ? 'paused' : 'none', label: isPaused ? 'Pausado' : 'Sem prazo', ms: Infinity };
    const diff = deadline - new Date();
    const abs = Math.abs(diff);
    const d = Math.floor(abs / 86400000), h = Math.floor((abs % 86400000) / 3600000), m = Math.floor((abs % 3600000) / 60000);
    const txt = d > 0 ? `${d}d ${h}h` : (h > 0 ? `${h}h ${m}min` : `${m}min`);
    if (isPaused && diff > 0) return { kind: 'paused', label: `Pausado · ${txt}`, ms: Infinity };
    if (diff <= 0) return { kind: 'late', label: `Atrasado ${txt}`, ms: diff };
    return { kind: diff < 2 * 3600000 ? 'soon' : 'ok', label: txt, ms: diff };
}

function tkAgo(v) {
    if (!v) return '';
    const min = Math.round((Date.now() - new Date(v).getTime()) / 60000);
    if (isNaN(min)) return '';
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    if (min < 1440) return `há ${Math.floor(min / 60)} h`;
    return `há ${Math.floor(min / 1440)} d`;
}

const TK_STATUS_LABEL = { New: 'Novo', InAttendance: 'Em atendimento', Stopped: 'Aguardando', InProgress: 'Em andamento' };
const TK_URG_ORDER = { 'Crítica': 0, 'Alta': 1, 'Média': 2, 'Baixa': 3 };
let _dashView = 'lista';
try { _dashView = localStorage.getItem('dashView') === 'cards' ? 'cards' : 'lista'; } catch (e) { /* sem storage */ }
// Padrão: o mais severo (urgência) no topo; dentro da mesma urgência, o prazo mais estourado primeiro.
let _dashSort = { key: 'urg', dir: 1 };

function setDashView(mode) {
    _dashView = mode === 'cards' ? 'cards' : 'lista';
    try { localStorage.setItem('dashView', _dashView); } catch (e) { /* sem storage */ }
    if (typeof applyDashboardFilters === 'function') applyDashboardFilters();
}

function sortDashTable(key) {
    _dashSort = _dashSort.key === key ? { key, dir: -_dashSort.dir } : { key, dir: 1 };
    if (typeof applyDashboardFilters === 'function') applyDashboardFilters();
}

function tkUrgRank(t) {
    return TK_URG_ORDER[getUrgencyFromSLA(getTicketValue(t, 'slaAgreementRule', 'slaagreementrule', '')).label] ?? 9;
}

// Ordena os chamados pela coluna escolhida. Em qualquer coluna, os empates saem por
// urgência (mais severa primeiro), depois pelo prazo (mais estourado primeiro) e por fim
// pelo chamado mais antigo — assim a ordem nunca fica aleatória.
function tkSorted(tickets) {
    return (tickets || []).slice().sort((a, b) => {
        const va = tkSortValue(a, _dashSort.key), vb = tkSortValue(b, _dashSort.key);
        if (va !== vb) return (va < vb ? -1 : 1) * _dashSort.dir;
        const ua = tkUrgRank(a), ub = tkUrgRank(b);
        if (ua !== ub) return ua - ub;
        const sa = tkSlaInfo(a).ms, sb = tkSlaInfo(b).ms;
        if (sa !== sb) return sa < sb ? -1 : 1;
        return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
}

function tkSortValue(t, key) {
    switch (key) {
        case 'sla': return tkSlaInfo(t).ms;
        case 'id': return Number(t.id) || 0;
        case 'urg': return tkUrgRank(t);
        case 'upd': return -(new Date(getTicketValue(t, 'lastUpdate', 'lastupdate', '') || 0).getTime());
        default: return 0;
    }
}

function renderTicketsTable(tickets) {
    const linhas = tkSorted(tickets);
    const seta = (k) => (_dashSort.key === k ? (_dashSort.dir === 1 ? ' ↑' : ' ↓') : '');
    const th = (k, rotulo) => `<th scope="col"><button type="button" onclick="sortDashTable('${k}')">${rotulo}${seta(k)}</button></th>`;
    const corpo = linhas.map(t => {
        const sla = tkSlaInfo(t);
        const urg = getUrgencyFromSLA(getTicketValue(t, 'slaAgreementRule', 'slaagreementrule', ''));
        const base = normalizeDashboardBaseStatus(getTicketValue(t, 'baseStatus', 'basestatus', '') || getTicketValue(t, 'status', 'status', ''));
        const statusTxt = getTicketValue(t, 'status', 'status', '') || TK_STATUS_LABEL[base] || base;
        const dono = getTicketValue(t, 'ownerName', 'ownername', 'Não atribuído') || 'Não atribuído';
        const cliente = getTicketValue(t, 'clientName', 'clientname', '') || getTicketValue(t, 'clientOrganization', 'clientorganization', '');
        const quem = getTicketValue(t, 'lastActionCreatedByBusinessName', 'lastactioncreatedbybusinessname', '');
        const origem = getTicketValue(t, 'lastActionOrigin', 'lastactionorigin', '');
        const upd = getTicketValue(t, 'lastUpdate', 'lastupdate', '') || getTicketValue(t, 'lastActionDate', 'lastactiondate', '');
        return `
        <tr class="tk-row" tabindex="0" role="button" onclick="openTicketWorkspace(${t.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTicketWorkspace(${t.id});}">
            <td><span class="tk-pill sla-${sla.kind}">${escapeHtml(sla.label)}</span></td>
            <td class="tk-id">#${escapeHtml(t.id)}</td>
            <td><div class="tk-title" title="${escapeHtml(t.subject)}">${escapeHtml(t.subject)}</div><div class="tk-sub">${escapeHtml(cliente || '—')}</div></td>
            <td><span class="urgency-bubble ${urg.class}">${urg.label}</span></td>
            <td class="tk-col-agente"><div class="tk-agent">${createAvatarHTML(getTicketValue(t, 'ownerEmail', 'owneremail', '') || null, dono)}<span>${escapeHtml(dono)}</span></div></td>
            <td><span class="tk-st st-${escapeHtml(base)}">${escapeHtml(statusTxt)}</span></td>
            <td class="tk-col-last tk-last ${origem === 'Customer' ? 'cliente' : ''}"><span class="tk-last-quem">${origem === 'Customer' ? 'Cliente' : 'Agente'}${quem ? ' · ' + escapeHtml(quem) : ''}</span><small>${escapeHtml(tkAgo(upd))}</small></td>
        </tr>`;
    }).join('');
    return `<div class="tk-wrap"><table class="tk-table">
        <thead><tr>${th('sla', 'Prazo')}${th('id', 'Nº')}<th scope="col">Assunto / cliente</th>${th('urg', 'Urgência')}<th scope="col" class="tk-col-agente">Agente</th><th scope="col">Status</th>${th('upd', 'Última ação')}</tr></thead>
        <tbody>${corpo}</tbody></table></div>`;
}

// Contadores dos filtros rápidos (sempre sobre todos os chamados carregados).
function updateQuickChipCounts(all) {
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n ? `(${n})` : ''; };
    let atras = 0, semRet = 0, novos = 0, pausa = 0;
    (all || []).forEach(t => {
        const k = tkSlaInfo(t).kind;
        if (k === 'late') atras++;
        if (k === 'paused') pausa++;
        if (getTicketValue(t, 'lastActionOrigin', 'lastactionorigin', '') === 'Customer') semRet++;
        if (normalizeDashboardBaseStatus(getTicketValue(t, 'baseStatus', 'basestatus', '') || getTicketValue(t, 'status', 'status', '')) === 'New') novos++;
    });
    set('chipAtrasados', atras); set('chipSemRetorno', semRet); set('chipNovos', novos); set('chipPausa', pausa);
}

// ── Kanban ────────────────────────────────────────────────────────────────────
// Colunas por status; em cada uma o mais severo (urgência) fica no topo. Cartão enxuto: o
// que importa pra decidir o que pegar agora (urgência, prazo, assunto, cliente, quem e
// se o cliente está esperando). Clicar abre a Central do chamado.
const KB_COLUNAS = [
    { key: 'New', titulo: 'Novos' },
    { key: 'InAttendance', titulo: 'Em atendimento' },
    { key: 'Stopped', titulo: 'Aguardando' },
];

function renderKanbanCard(t) {
    const sla = tkSlaInfo(t);
    const urg = getUrgencyFromSLA(getTicketValue(t, 'slaAgreementRule', 'slaagreementrule', ''));
    const dono = getTicketValue(t, 'ownerName', 'ownername', 'Não atribuído') || 'Não atribuído';
    const cliente = getTicketValue(t, 'clientName', 'clientname', '') || getTicketValue(t, 'clientOrganization', 'clientorganization', '');
    const origem = getTicketValue(t, 'lastActionOrigin', 'lastactionorigin', '');
    const quem = getTicketValue(t, 'lastActionCreatedByBusinessName', 'lastactioncreatedbybusinessname', '');
    const upd = getTicketValue(t, 'lastUpdate', 'lastupdate', '') || getTicketValue(t, 'lastActionDate', 'lastactiondate', '');
    const primeiroNome = String(dono).split(' ')[0];
    return `
    <article class="kb-card kb-${sla.kind}" tabindex="0" role="button" aria-label="Chamado ${escapeHtml(t.id)}: ${escapeHtml(t.subject)}"
        onclick="openTicketWorkspace(${t.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTicketWorkspace(${t.id});}">
        <div class="kb-topo">
            <span class="urgency-bubble ${urg.class}">${urg.label}</span>
            <span class="kb-id">#${escapeHtml(t.id)}</span>
            <span class="tk-pill sla-${sla.kind} kb-sla">${escapeHtml(sla.label)}</span>
        </div>
        <h4 class="kb-titulo" title="${escapeHtml(t.subject)}">${escapeHtml(t.subject)}</h4>
        <div class="kb-cliente" title="${escapeHtml(cliente)}">${escapeHtml(cliente || 'Cliente não informado')}</div>
        <div class="kb-rodape">
            <span class="kb-agente" title="${escapeHtml(dono)}">${createAvatarHTML(getTicketValue(t, 'ownerEmail', 'owneremail', '') || null, dono)}<span>${escapeHtml(primeiroNome)}</span></span>
            ${origem === 'Customer' ? '<span class="kb-espera" title="A última ação foi do cliente — ele aguarda retorno">Cliente aguarda</span>' : `${quem && String(quem).split(' ')[0] !== primeiroNome ? `<span class="kb-ult" title="Última ação: ${escapeHtml(quem)}">↩ ${escapeHtml(String(quem).split(' ')[0])}</span>` : ''}`}
            <span class="kb-quando">${escapeHtml(tkAgo(upd))}</span>
        </div>
    </article>`;
}

function renderKanban(tickets) {
    const ordenados = tkSorted(tickets);
    const grupos = {};
    KB_COLUNAS.forEach(c => { grupos[c.key] = []; });
    const outros = [];
    ordenados.forEach(t => {
        const base = normalizeDashboardBaseStatus(getTicketValue(t, 'baseStatus', 'basestatus', '') || getTicketValue(t, 'status', 'status', ''));
        (grupos[base] || outros).push(t);
    });
    const colunas = KB_COLUNAS.map(c => ({ ...c, itens: grupos[c.key] }));
    if (outros.length) colunas.push({ key: 'Outros', titulo: 'Outros status', itens: outros });
    return `<div class="kb-board">${colunas.map(c => `
        <section class="kb-col kb-col-${c.key}" aria-label="${escapeHtml(c.titulo)}">
            <header class="kb-col-topo"><h3>${escapeHtml(c.titulo)}</h3><span class="kb-col-n">${c.itens.length}</span></header>
            <div class="kb-lista">${c.itens.length ? c.itens.map(renderKanbanCard).join('') : '<div class="kb-vazio">Nenhum chamado</div>'}</div>
        </section>`).join('')}</div>`;
}

// Função para renderizar os chamados (lista densa ou kanban)
function renderTickets(tickets, container) {
    const seg = { lista: document.getElementById('viewLista'), cards: document.getElementById('viewCards') };
    if (seg.lista) seg.lista.setAttribute('aria-pressed', String(_dashView === 'lista'));
    if (seg.cards) seg.cards.setAttribute('aria-pressed', String(_dashView === 'cards'));
    container.classList.toggle('tk-list-mode', _dashView === 'lista');
    container.classList.toggle('kb-mode', _dashView === 'cards');

    if (!tickets || tickets.length === 0) {
        container.innerHTML = '<div class="tk-vazio" style="grid-column: 1/-1;">Nenhum chamado encontrado para estes filtros.</div>';
        return;
    }
    container.innerHTML = _dashView === 'lista' ? renderTicketsTable(tickets) : renderKanban(tickets);
}

function normalizeDashboardBaseStatus(value) {
    const raw = String(value || '').trim();
    const key = raw.toLowerCase();

    if (key === 'new' || key === 'novo') return 'New';
    if (key === 'inattendance' || key === 'inprogress' || key === 'em atendimento') return 'InAttendance';
    if (key === 'stopped' || key.startsWith('aguardando')) return 'Stopped';

    return raw;
}

// Mapas de status para o estilo do card
const BASE_STATUS_LABEL = {
    'New': 'Novo',
    'InAttendance': 'Em Atendimento',
    'Stopped': 'Aguardando'
};

const BASE_STATUS_HEADER_CLASS = {
    'New': 'status-baixa',
    'InAttendance': 'status-media',
    'Stopped': 'status-alta'
};

// Extrai urgência do slaAgreementRule e retorna classe CSS + label
function getUrgencyFromSLA(slaAgreementRule) {
    if (!slaAgreementRule) return { label: 'Sem SLA', class: 'urgency-none' };
    
    const rule = slaAgreementRule.toLowerCase();
    
    if (rule.includes('crítica')) {
        return { label: 'Crítica', class: 'urgency-critica' };
    } else if (rule.includes('alta')) {
        return { label: 'Alta', class: 'urgency-alta' };
    } else if (rule.includes('média')) {
        return { label: 'Média', class: 'urgency-media' };
    } else if (rule.includes('baixa')) {
        return { label: 'Baixa', class: 'urgency-baixa' };
    }
    
    return { label: 'Indefinida', class: 'urgency-none' };
}

// Calcula e retorna o badge HTML do SLA
function buildSlaBadge(ticket) {
    const isPaused = ticket.slaSolutionDateIsPaused === 1 || ticket.slaSolutionDateIsPaused === true;
    let deadline;
    
    // Determinar o prazo a ser comparado
    if (ticket.slaSolutionDate) {
        deadline = new Date(ticket.slaSolutionDate);
    } else if (isPaused && ticket.slaSolutionTime && ticket.createdDate) {
        // Quando pausado sem slaSolutionDate, calcular uma data teórica
        // slaSolutionTime está em MINUTOS
        const created = new Date(ticket.createdDate);
        deadline = new Date(created.getTime() + ticket.slaSolutionTime * 60000);
    } else {
        return ''; // Sem informação de prazo
    }

    const now = new Date();
    const diffMs = deadline - now;
    const absDiff = Math.abs(diffMs);
    const hours = Math.floor(absDiff / 3600000);
    const minutes = Math.floor((absDiff % 3600000) / 60000);
    const timeStr = hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;

    // Determinar status
    let statusText, badgeClass;
    if (diffMs > 0) {
        const urgentClass = diffMs < 3600000 ? 'sla-warning' : 'sla-ok';
        statusText = `✅ No prazo: ${timeStr} restantes`;
        badgeClass = urgentClass;
    } else {
        statusText = `❌ Fora do Prazo há: ${timeStr}`;
        badgeClass = 'sla-breached';
    }

    // Adicionar indicador de pausa se aplicável
    if (isPaused) {
        return `<span class="sla-badge sla-paused">⏸️ SLA Pausado - ${statusText}</span>`;
    } else {
        return `<span class="sla-badge ${badgeClass}">${statusText}</span>`;
    }
}

function formatMinutesAsText(totalMinutes) {
    const mins = Number(totalMinutes || 0);
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    if (hours <= 0) return `${rest}min`;
    return `${hours}h ${rest}min`;
}

function buildFirstResponsePlaceholder(ticketId, lastActionAuthor, lastActionOrigin, ownerName) {
    const author = lastActionAuthor || 'Não registrado';
    let originLabel = 'Agente';
    let originIcon = '👨\u200d💼';
    
    if (lastActionOrigin === 'Customer') {
        originLabel = 'Cliente';
        originIcon = '👤';
    } else if (lastActionOrigin === 'Attendant') {
        originLabel = 'Agente';
        originIcon = '👨\u200d💼';
    }
    
    return `<span class="action-pill action-pill-${originLabel.toLowerCase()}">
        <span class="sla-icon">${originIcon}</span><span>${originLabel}${author ? ` • ${escapeHtml(author)}` : ''}</span>
    </span>`;


}

function buildOriginBadge(origin) {
    const normalized = String(origin || '').toLowerCase();
    const label = normalized === 'customer'
        ? 'Cliente'
        : normalized === 'attendant'
            ? 'Agente'
            : 'Indefinido';
    return `<span class="origin-badge origin-${normalized || 'unknown'}">${label}</span>`;
}

function buildSlaStatusCard(ticket) {
    const isPaused = ticket.slaSolutionDateIsPaused === 1 || ticket.slaSolutionDateIsPaused === true;
    let deadline;
    
    if (ticket.slaSolutionDate) {
        deadline = new Date(ticket.slaSolutionDate);
    } else if (isPaused && ticket.slaSolutionTime && ticket.createdDate) {
        const created = new Date(ticket.createdDate);
        deadline = new Date(created.getTime() + ticket.slaSolutionTime * 60000);
    } else {
        return '';
    }

    const now = new Date();
    const diffMs = deadline - now;
    const absDiff = Math.abs(diffMs);
    const hours = Math.floor(absDiff / 3600000);
    const minutes = Math.floor((absDiff % 3600000) / 60000);
    const timeStr = hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;

    let statusHTML = '';
    if (diffMs > 0) {
        statusHTML = `<div class="sla-status-card sla-status-ok"><span class="sla-status-icon">✓</span>No prazo: ${timeStr} restantes</div>`;
    } else {
        const estouro = absDiff / 60000;
        const hEst = Math.floor(estouro / 60);
        const mEst = Math.floor(estouro % 60);
        const estStr = hEst > 0 ? `${hEst}h ${mEst}min` : `${mEst}min`;
        statusHTML = `<div class="sla-status-card sla-status-overdue"><span class="sla-status-icon">✕</span>Atrasado: ${estStr}</div>`;
    }
    
    return statusHTML;
}

function buildSlaMetricsSection(ticketId) {
    return `<div style="display: flex; flex-direction: column; gap: 8px;">
        <span id="first-response-sla-${ticketId}" class="sla-metric-pill sla-metric-loading"><span class="sla-icon">⋯</span><span>1ª resposta: calculando...</span></span>
        <span id="solution-sla-${ticketId}" class="sla-metric-pill sla-metric-loading"><span class="sla-icon">⋯</span><span>Resolução: calculando...</span></span>
    </div>`;
}

async function loadFirstResponseSla(tickets) {
    const tasks = (tickets || []).map(async (ticket) => {
        const firstRespId = `first-response-sla-${ticket.id}`;
        const solutionId = `solution-sla-${ticket.id}`;
        const firstRespEl = document.getElementById(firstRespId);
        if (!firstRespEl) return;

        try {
            const response = await fetch(`${API_BASE}/tickets/${ticket.id}/sla`, {
                headers: authHeaders()
            });
            if (!response.ok) throw new Error(`status ${response.status}`);

            const sla = await response.json();
            const stillMountedFirst = document.getElementById(firstRespId);
            const stillMountedSolution = document.getElementById(solutionId);
            if (!stillMountedFirst && !stillMountedSolution) return;

            // ===== PRIMEIRA RESPOSTA =====
            const previsto = formatMinutesAsText(sla.slaPrevistoMinutos);
            if (!sla.primeiroContatoEncontrado) {
                if (stillMountedFirst) {
                    stillMountedFirst.className = 'sla-metric-pill sla-metric-missing';
                    stillMountedFirst.innerHTML = `<span class="sla-icon">⏳</span><span>1ª resposta: Sem contato (${previsto})</span>`;
                }
            } else {
                const consumidos = formatMinutesAsText(sla.minutosUteisConsumidos);
                if (stillMountedFirst) {
                    if (sla.dentroDoSLA) {
                        stillMountedFirst.className = 'sla-metric-pill sla-metric-ok';
                        stillMountedFirst.innerHTML = `<span class="sla-icon">✓</span><span>1ª resposta: ${consumidos}</span>`;
                    } else {
                        const estouro = formatMinutesAsText(sla.minutosEstouro);
                        stillMountedFirst.className = 'sla-metric-pill sla-metric-breach';
                        stillMountedFirst.innerHTML = `<span class="sla-icon">⚠</span><span>1ª resposta: +${estouro}</span>`;
                    }
                }
            }

            // ===== RESOLUÇÃO =====
            if (stillMountedSolution) {
                if (ticket.slaSolutionDate) {
                    const deadline = new Date(ticket.slaSolutionDate);
                    const now = new Date();
                    const diffMs = deadline - now;
                    const absDiff = Math.abs(diffMs);
                    const hours = Math.floor(absDiff / 3600000);
                    const minutes = Math.floor((absDiff % 3600000) / 60000);
                    const timeStr = hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;
                    
                    if (diffMs > 0) {
                        stillMountedSolution.className = 'sla-metric-pill sla-metric-ok';
                        stillMountedSolution.innerHTML = `<span class="sla-icon">✓</span><span>Resolução: ${timeStr}</span>`;
                    } else {
                        const estouro = absDiff / 60000;
                        const hEst = Math.floor(estouro / 60);
                        const mEst = Math.floor(estouro % 60);
                        const estStr = hEst > 0 ? `${hEst}h ${mEst}min` : `${mEst}min`;
                        stillMountedSolution.className = 'sla-metric-pill sla-metric-breach';
                        stillMountedSolution.innerHTML = `<span class="sla-icon">+</span><span>Resolução: ${estStr}</span>`;
                    }
                } else {
                    const justification = ticket.justification || ticket.justificacao || '';
                    if (justification) {
                        const isValidacaoCliente = justification.toLowerCase().includes('valida') && justification.toLowerCase().includes('cliente');
                        stillMountedSolution.className = isValidacaoCliente ? 'sla-metric-pill sla-metric-validation' : 'sla-metric-pill sla-metric-missing';
                        stillMountedSolution.innerHTML = `<span class="sla-icon">—</span><span>Resolução: ${escapeHtml(justification)}</span>`;
                    } else {
                        stillMountedSolution.className = 'sla-metric-pill sla-metric-missing';
                        stillMountedSolution.innerHTML = `<span class="sla-icon">—</span><span>Resolução: Sem prazo</span>`;
                    }
                }
            }
        } catch (error) {
            const stillMountedFirst = document.getElementById(firstRespId);
            const stillMountedSolution = document.getElementById(solutionId);
            if (stillMountedFirst) {
                stillMountedFirst.className = 'sla-metric-pill sla-metric-error';
                stillMountedFirst.innerHTML = `<span class="sla-icon">?</span><span>1ª resposta: Erro</span>`;
            }
            if (stillMountedSolution) {
                stillMountedSolution.className = 'sla-metric-pill sla-metric-error';
                stillMountedSolution.innerHTML = `<span class="sla-icon">?</span><span>Resolução: Erro</span>`;
            }
        }
    });

    await Promise.all(tasks);
}

// Função para criar o HTML de um card
function createCardHTML(ticket) {
    const urgency = getUrgencyFromSLA(getTicketValue(ticket, 'slaAgreementRule', 'slaagreementrule', ''));
    const ownerName = getTicketValue(ticket, 'ownerName', 'ownername', 'Não atribuído');
    const ownerEmail = getTicketValue(ticket, 'ownerEmail', 'owneremail', '');
    const clientName = getTicketValue(ticket, 'clientName', 'clientname', 'Não informado');
    const initials = ownerName
        .split(' ')
        .map(n => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
    
    // Cria avatar com foto ou fallback
    const avatarHTML = ownerEmail ? createAvatarHTML(ownerEmail, ownerName) : `
        <div class="card-agent-avatar-placeholder">
            ${initials}
        </div>
    `;

    return `
        <div class="card" onclick="openTicketWorkspace(${ticket.id})">
            <div class="card-header-new">
                <span class="card-id">#${ticket.id}</span>
                <span class="urgency-bubble ${urgency.class}">${urgency.label}</span>
            </div>
            <div class="card-body-new">
                <h3 class="card-title-new" title="${escapeHtml(ticket.subject)}">${escapeHtml(ticket.subject)}</h3>
                
                <div class="card-agent">
                    ${avatarHTML}
                    <span class="card-agent-name">Agente: ${escapeHtml(ownerName)}</span>
                </div>
                
                <div class="card-info-row">
                    <div class="card-info-col">
                        <span class="card-info-label">ÚLT. AÇÃO:</span>
                        <div style="margin-top: 6px;">
                            ${buildFirstResponsePlaceholder(ticket.id, getTicketValue(ticket, 'lastActionCreatedByBusinessName', 'lastactioncreatedbybusinessname', ''), getTicketValue(ticket, 'lastActionOrigin', 'lastactionorigin', ''), ownerName)}
                        </div>
                    </div>
                    <div class="card-info-col">
                        <span class="card-info-label">CLIENTE:</span>
                        <span class="card-info-value">${escapeHtml(clientName)}</span>
                    </div>
                </div>
                
                <div style="padding: 12px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin-top: 12px;">
                    <span class="card-info-label" style="display: block; margin-bottom: 8px;">PRAZOS SLA:</span>
                    ${buildSlaMetricsSection(ticket.id)}
                </div>
                
                ${buildSlaStatusCard({
                    ...ticket,
                    createdDate: getTicketValue(ticket, 'createdDate', 'createddate', ''),
                    slaSolutionDateIsPaused: getTicketValue(ticket, 'slaSolutionDateIsPaused', 'slasolutiondateispaused', false),
                    slaSolutionTime: getTicketValue(ticket, 'slaSolutionTime', 'slasolutiontime', ''),
                    slaSolutionDate: getTicketValue(ticket, 'slaSolutionDate', 'slasolutiondate', '')
                })}
                
                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 10px; color: #94a3b8; display: flex; justify-content: flex-end;">
                    Atualizado em ${formatDate(new Date())}
                </div>
            </div>
        </div>
    `;
}

// Utilitários
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDate(dateString) {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function handleCardClick(ticketId) {
    console.log('✓ Card clicado - Ticket ID:', ticketId, 'Tipo:', typeof ticketId);
    
    // Normaliza o ID para número
    const normalizedId = Number(ticketId);
    
    // Recupera o ticket do cache - compara como número. Checa também o cache
    // da aba Movidesk (ativos + encerrados) — um chamado já fechado só existe
    // ali, não em _cachedTickets (só ativos, usado pelo Dashboard).
    let ticket = null;
    if (_cachedTickets && _cachedTickets.length > 0) {
        ticket = _cachedTickets.find(t => Number(t.id) === normalizedId);
    }
    if (!ticket && _cachedMovideskTickets && _cachedMovideskTickets.length > 0) {
        ticket = _cachedMovideskTickets.find(t => Number(t.id) === normalizedId);
    }

    if (!ticket) {
        console.warn(`⚠ Ticket ${ticketId} (normalizado: ${normalizedId}) não encontrado no cache. Cache total: ${_cachedTickets ? _cachedTickets.length : 0}`);
        console.log('IDs disponíveis no cache:', _cachedTickets?.map(t => ({ id: t.id, tipo: typeof t.id })).slice(0, 5));
        
        // Fallback: abre no Movidesk direto
        console.log('🔗 Abrindo no Movidesk (sem cache completo)');
        window.open(`https://viasoft.movidesk.com/Ticket/Edit/${ticketId}`, '_blank');
        return;
    }
    
    console.log('✓ Ticket encontrado no cache:', ticket.id);
    
    // Faz a análise
    const analise = analyzeTicket(ticket);
    console.log('✓ Análise gerada');
    
    // Popula o modal
    const modal = document.getElementById('executiveSummaryModal');
    const title = document.getElementById('executiveSummaryTitle');
    const body = document.getElementById('executiveSummaryBody');
    const openBtn = document.getElementById('executiveSummaryOpenTicket');
    
    if (!modal || !title || !body) {
        console.error('❌ Modal ou elementos não encontrados');
        return;
    }
    
    title.innerHTML = `Análise do Ticket #${ticketId}`;
    body.innerHTML = formatarResumoExecutivoCompacto(analise);
    modal.style.display = 'flex';
    console.log('✓ Modal exibido');
    
    // Botão para abrir no Movidesk
    if (openBtn) {
        openBtn.onclick = () => {
            window.open(`https://viasoft.movidesk.com/Ticket/Edit/${ticketId}`, '_blank');
        };
    }
}

function formatCuradoriaBadge(value, type = 'neutral') {
    const safe = escapeHtml(value || '—');
    return `<span class="curadoria-badge curadoria-badge-${type}">${safe}</span>`;
}

function getCuradoriaUrgencyType(value) {
    const normalized = String(value || '').toLowerCase();
    if (normalized.includes('crit')) return 'critica';
    if (normalized.includes('alta')) return 'alta';
    if (normalized.includes('med')) return 'media';
    if (normalized.includes('baix')) return 'baixa';
    return 'neutral';
}

function safeCuradoriaText(value, fallback = '—') {
    if (value === undefined || value === null) return fallback;
    const str = String(value).trim();
    return str ? str : fallback;
}

function parseJsonLoose(value) {
    if (value === undefined || value === null) return value;
    if (typeof value === 'object') return value;
    const text = String(value).trim();
    if (!text) return '';
    if (!(text.startsWith('{') || text.startsWith('['))) return value;
    try {
        return JSON.parse(text);
    } catch {
        return value;
    }
}

function formatCuradoriaComplexValue(value) {
    const parsed = parseJsonLoose(value);
    if (parsed === undefined || parsed === null || parsed === '') return '—';
    if (Array.isArray(parsed)) {
        if (!parsed.length) return '—';
        const items = parsed.map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
                if (item.nome) return item.nome;
                if (item.indicacao) return item.indicacao;
                return Object.values(item).filter(Boolean).join(' - ');
            }
            return String(item);
        }).filter(Boolean);
        return items.length ? items.join(' | ') : '—';
    }
    if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed)
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(' | ');
    }
    return String(parsed);
}

function findCuradoriaRowByTicketId(ticketId) {
    const target = String(ticketId || '').trim();
    if (!target) return null;
    return (_curadoriaRows || []).find((row) => String(row.ticket_id) === target) || null;
}

function parseCuradoriaActionsText(txt) {
    if (!txt || typeof txt !== 'string') return [];

    const blocks = txt.split(/--- Ação \d+ \(ID: \d+\) ---/).slice(1);
    const headers = [...txt.matchAll(/--- Ação (\d+) \(ID: (\d+)\) ---/g)];

    const readField = (block, label) => {
        const m = block.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n(?:Tipo|Origem|Status|Data|Autor|Descrição|Descricao):|$)`));
        return m ? m[1].trim() : '';
    };

    return blocks.map((b, i) => ({
        ordem: headers[i] ? Number(headers[i][1]) : i + 1,
        id: headers[i] ? Number(headers[i][2]) : i + 1,
        tipo: readField(b, 'Tipo'),
        origem: readField(b, 'Origem'),
        status: readField(b, 'Status'),
        data: readField(b, 'Data'),
        autor: readField(b, 'Autor'),
        descricao: readField(b, 'Descrição') || readField(b, 'Descricao')
    }));
}

function parseCuradoriaJsonArray(value) {
    const parsed = parseJsonLoose(value);
    return Array.isArray(parsed) ? parsed : [];
}

function classifyCuradoriaActor(actor, author) {
    const actorNorm = String(actor || '').toLowerCase();
    if (actorNorm.includes('cliente')) return 'cliente';
    if (actorNorm.includes('suporte') || actorNorm.includes('agente')) return 'suporte';
    if (actorNorm.includes('sistema')) return 'sistema';

    const authorNorm = String(author || '').toLowerCase();
    if (!authorNorm || authorNorm.includes('desconhecido')) return 'sistema';
    if (authorNorm.includes('@viasoft.com.br')) return 'suporte';
    return 'cliente';
}

function escapeHtmlWithBreaks(value) {
    return escapeHtml(value || '—').replace(/\n/g, '<br>');
}

function parseCuradoriaActionDate(value) {
    if (!value) return null;
    const normalized = String(value).trim();
    const direct = new Date(normalized);
    if (!Number.isNaN(direct.getTime())) return direct;

    const m = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = Number(m[3]);
    const hh = Number(m[4] || 0);
    const mm = Number(m[5] || 0);
    const ss = Number(m[6] || 0);
    const dt = new Date(year, month, day, hh, mm, ss);
    return Number.isNaN(dt.getTime()) ? null : dt;
}

function toCuradoriaNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function parseCuradoriaObject(value, fallback = null) {
    const parsed = parseJsonLoose(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return fallback;
}

function parseCuradoriaObjectArray(value, fallback = []) {
    const parsed = parseJsonLoose(value);
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') : fallback;
}

function buildCuradoriaMergedActions(row) {
    const actionsRaw = row ? parseCuradoriaActionsText(row.actions) : [];
    const tabelaAcoes = row ? parseCuradoriaJsonArray(row.tabela_acoes) : [];

    return actionsRaw.map((a) => {
        const resumoAcao = tabelaAcoes.find((x) => Number(x.id) === Number(a.id));
        const ator = resumoAcao?.ator || '';
        const origem = resumoAcao?.origem || a.origem || '—';
        const criadoPor = resumoAcao?.criado_por || a.autor || '—';
        const role = classifyCuradoriaActor(ator, a.autor);
        return {
            ...a,
            ator: ator || (role === 'suporte' ? 'Suporte' : role === 'cliente' ? 'Cliente' : 'Sistema'),
            origem,
            criadoPor,
            role,
            _parsedDate: parseCuradoriaActionDate(a.data)
        };
    });
}


// ── Sync & Dashboard utilities ──────────────────────────────────────────
function getOrCreatePill() {
    // Remove completamente qualquer duplicata
    const existing = document.getElementById('syncStatusBubble');
    if (existing) {
        return existing;
    }
    
    // Remove qualquer elemento antigo que possa estar órfão
    document.querySelectorAll('div[style*="bottom:20px"][style*="right:20px"]').forEach(el => {
        if (el.id === 'syncStatusBubble' || !el.id) {
            el.remove();
        }
    });
    
    // Criar novo elemento
    const el = document.createElement('div');
    el.id = 'syncStatusBubble';
    el.style.cssText = [
        'position:fixed',
        'bottom:20px',
        'right:20px',
        'background:rgba(30,30,40,0.85)',
        'backdrop-filter:blur(6px)',
        'color:#fff',
        'padding:8px 16px',
        'border-radius:999px',
        'font-size:12px',
        'font-weight:500',
        'z-index:9999',
        'box-shadow:0 2px 10px rgba(0,0,0,0.25)',
        'display:flex',
        'align-items:center',
        'gap:8px',
        'transition:background 0.3s'
    ].join(';');
    document.body.appendChild(el);
    return el;
}

function updateSyncStatus(message, isError) {
    const el = getOrCreatePill();
    el.style.background = isError
        ? 'rgba(180,30,30,0.85)'
        : 'rgba(30,30,40,0.85)';
    el.textContent = message;
}

function showLastSync() {
    const saved = localStorage.getItem('lastSyncTime');
    const el = getOrCreatePill();
    // Só atualiza se não houver outra mensagem recente
    if (!el.textContent.includes('Sincronizando') && !el.textContent.includes('Falha')) {
        if (saved) {
            el.textContent = `⏰ Atualizado em ${saved}`;
        } else {
            el.textContent = '⏰ Nunca sincronizado';
        }
    }
}

// Toggle para seção de chamados
function toggleCardsSection() {
    const cardsSection = document.getElementById('cardsSection');
    const toggleBtn = document.getElementById('toggleBtn');
    if (cardsSection) {
        cardsSection.classList.toggle('collapsed');
        if (toggleBtn) {
            toggleBtn.textContent = cardsSection.classList.contains('collapsed') ? '▶ Chamados em Aberto' : '▼ Chamados em Aberto';
        }
    }
}
