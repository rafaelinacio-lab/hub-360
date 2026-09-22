
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

async function fetchOpenTickets() {
    const container = document.getElementById('cardsContainer');
    if (!container) return;
    
    try {
        // Buscar tickets ativos
        const activeResponse = await fetch(`${API_BASE}/tickets`, {
            headers: authHeaders()
        });
        
        if (!activeResponse.ok) {
            throw new Error(`Erro na API: ${activeResponse.status}`);
        }
        
        const tickets = await activeResponse.json();
        
        _cachedTickets = tickets;
        renderTickets(tickets, container);

        try {
            updateSummaryCards(tickets);
        } catch (summaryError) {
            console.error('Erro ao atualizar resumo da dashboard:', summaryError);
        }

        try {
            populateDashboardFilters();
        } catch (filtersError) {
            console.error('Erro ao popular filtros da dashboard:', filtersError);
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
        updateSyncStatus(`⏰ Atualizado em ${hora}`);
        
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
    const attendantMap = {};

    (tickets || []).forEach(t => {
        const owner = getTicketValue(t, 'ownerName', 'ownername', 'Sem atribuição');
        const ownerEmail = getTicketValue(t, 'ownerEmail', 'owneremail', '');
        if (!attendantMap[owner]) attendantMap[owner] = { count: 0, tickets: [], email: ownerEmail };
        attendantMap[owner].count++;
        const urg = getUrgencyFromSLA(getTicketValue(t, 'slaAgreementRule', 'slaagreementrule', ''));
        attendantMap[owner].tickets.push({ id: t.id, urgClass: urg.class });
    });

    window._dashboardKpiLists = kpiLists;

    const total = counts.New + counts.InAttendance + counts.Stopped;
    document.getElementById('countNew').textContent = counts.New;
    document.getElementById('countInAttendance').textContent = counts.InAttendance;
    document.getElementById('countStopped').textContent = counts.Stopped;
    document.getElementById('countTotal').textContent = total;
    document.getElementById('countOnTime').textContent = counts.onTime;
    document.getElementById('countOverdue').textContent = counts.overdue;

    // Renderizar sparklines (dados aleatórios para demo)
    const sparklineData = [5, 12, 8, 15, 9, 14, 11];
    drawSparkline('sparkNew', sparklineData, '#1d9e75');
    drawSparkline('sparkInAttendance', sparklineData.map(v => v + 2), '#378add');
    drawSparkline('sparkStopped', sparklineData.map(v => v + 5), '#ef9f27');
    drawSparkline('sparkTotal', sparklineData.map(v => v + 8), '#8b5cf6');

    // Renderizar donuts
    const onTimePercentage = total > 0 ? (counts.onTime / total) * 100 : 0;
    const overduePercentage = total > 0 ? (counts.overdue / total) * 100 : 0;

    drawDonut('donutOntime', onTimePercentage, '#10b981');
    drawDonut('donutOverdue', overduePercentage, '#ef4444');

    document.getElementById('pctOnTime').textContent = onTimePercentage.toFixed(1) + '%';
    document.getElementById('pctOverdue').textContent = overduePercentage.toFixed(1) + '%';

    // Gerar insight do card "Fora do Prazo" (desativado temporariamente)
    const insightEl = document.getElementById('overdueInsight');
    if (insightEl) insightEl.textContent = '';

    updateAttendantsList(attendantMap);
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

// Atualiza a lista de atendentes
function updateAttendantsList(attendantMap) {
    const container = document.getElementById('attendantsContainer');
    if (!container) return;

    let html = '';
    Object.entries(attendantMap)
        .sort((a, b) => b[1].count - a[1].count)
        .forEach(([name, data]) => {
            const slugId = 'att-' + name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
            const ticketLinks = data.tickets
                .map(({ id, urgClass }) => `<a class="att-ticket-link ${urgClass}" onclick="handleCardClick(${id});event.stopPropagation()" href="#">#${id}</a>`)
                .join('');
            
            // Usar avatar com foto (email ou nome) ou fallback com iniciais
            const avatarHTML = createAvatarHTML(data.email || null, name);
            
            html += `
                <div class="attendant-item attendant-expandable" onclick="toggleAttendant('${slugId}')">
                    <div class="attendant-header">
                        <div class="attendant-avatar-wrapper">
                            ${avatarHTML}
                        </div>
                        <div class="attendant-info">
                            <div class="attendant-name">${escapeHtml(name)}</div>
                        </div>
                    </div>
                    <span class="attendant-count">${data.count}</span>
                    <div class="attendant-tickets" id="${slugId}">${ticketLinks}</div>
                </div>
            `;
        });

    container.innerHTML = html || '<p style="color: #999;">Nenhum atendente</p>';
}

function toggleAttendant(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('expanded');
}

// Função para renderizar os tickets como cards
function renderTickets(tickets, container) {
    if (!tickets || tickets.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1/-1; padding: 40px; text-align: center;">
                <p style="color: #7f8c8d; font-size: 16px;">Nenhum chamado encontrado. Acesse o painel admin para sincronizar.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = tickets.map(ticket => createCardHTML(ticket)).join('');
    loadFirstResponseSla(tickets);
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
        <div class="card" onclick="handleCardClick(${ticket.id})">
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
