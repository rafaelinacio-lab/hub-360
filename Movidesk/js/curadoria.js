
// ── curadoria.js — Curadoria & Performance ─────────────────────────────────

function renderCuradoriaPerformanceBoard(rows) {
    const host = document.getElementById('curadoriaPerformanceBoard');
    if (!host) return;

    const kpiHost = document.getElementById('curadoriaKpiBar');
    if (kpiHost && rows && rows.length) {
        const totalTickets = rows.length;
        const totalAcoes = rows.reduce((acc, r) => acc + toCuradoriaNumber(r.total_acoes), 0);
        const avgSatisfacao = rows.reduce((acc, r) => acc + toCuradoriaNumber(r.satisfacao), 0) / rows.length;
        const urgenciaCritica = rows.filter((r) => String(r.urgencia || '').toLowerCase().includes('crit')).length;

        const satisfacaoPercent = Math.round((avgSatisfacao / 5) * 100);
        const urgenciaPercent = totalTickets > 0 ? Math.round((urgenciaCritica / totalTickets) * 100) : 0;

        kpiHost.innerHTML = `
            <div class="curadoria-kpi-grid">
                <div class="curadoria-kpi-card">
                    <span class="kpi-label">Tickets</span>
                    <strong class="kpi-value">${totalTickets}</strong>
                </div>
                <div class="curadoria-kpi-card">
                    <span class="kpi-label">Ações</span>
                    <strong class="kpi-value">${totalAcoes}</strong>
                </div>
                <div class="curadoria-kpi-card">
                    <span class="kpi-label">Satisfação</span>
                    <div class="kpi-progress">
                        <div class="kpi-progress-bar" style="width:${satisfacaoPercent}%"></div>
                    </div>
                    <span class="kpi-pct">${satisfacaoPercent}%</span>
                </div>
                <div class="curadoria-kpi-card">
                    <span class="kpi-label">Críticas</span>
                    <div class="kpi-progress">
                        <div class="kpi-progress-bar critical" style="width:${urgenciaPercent}%"></div>
                    </div>
                    <span class="kpi-pct">${urgenciaPercent}%</span>
                </div>
            </div>
        `;
    }

    if (!rows || !rows.length) {
        host.innerHTML = '';
        return;
    }

    const collabMap = new Map();

    const ensureCollab = (name) => {
        const key = safeCuradoriaText(name, 'Sem owner');
        if (!collabMap.has(key)) {
            collabMap.set(key, {
                name: key,
                tickets: new Set(),
                supportActions: 0,
                clientActions: 0,
                totalActions: 0,
                pendingTickets: 0,
                responseTimes: []
            });
        }
        return collabMap.get(key);
    };

    for (const row of rows) {
        const owner = safeCuradoriaText(row.owner, 'Sem owner');
        const ownerEntry = ensureCollab(owner);
        const ticketKey = String(row.ticket_id || '');

        ownerEntry.tickets.add(ticketKey);
        ownerEntry.clientActions += toCuradoriaNumber(row.total_cliente);
        ownerEntry.supportActions += toCuradoriaNumber(row.total_agente);
        ownerEntry.totalActions += toCuradoriaNumber(row.total_acoes);

        const mergedWithDate = buildCuradoriaMergedActions(row);
        if (!mergedWithDate.length) {
            if (toCuradoriaNumber(row.total_cliente) > toCuradoriaNumber(row.total_agente)) {
                ownerEntry.pendingTickets += 1;
            }
            continue;
        }

        for (const action of mergedWithDate) {
            if (action.role !== 'suporte') continue;
            const supportName = safeCuradoriaText(action.criadoPor, owner);
            const supportEntry = ensureCollab(supportName);
            supportEntry.tickets.add(ticketKey);
            supportEntry.supportActions += 1;
        }

        for (let i = 0; i < mergedWithDate.length; i += 1) {
            const current = mergedWithDate[i];
            if (current.role !== 'cliente') continue;

            let replied = false;
            for (let j = i + 1; j < mergedWithDate.length; j += 1) {
                const next = mergedWithDate[j];
                if (next.role !== 'suporte') continue;
                replied = true;

                const supportName = safeCuradoriaText(next.criadoPor, owner);
                const supportEntry = ensureCollab(supportName);
                if (current._parsedDate && next._parsedDate) {
                    const diffMin = Math.max(0, Math.round((next._parsedDate - current._parsedDate) / 60000));
                    supportEntry.responseTimes.push(diffMin);
                }
                break;
            }

            if (!replied) {
                ownerEntry.pendingTickets += 1;
            }
        }
    }

    const collabs = Array.from(collabMap.values()).map((c) => {
        const avgResponse = c.responseTimes.length
            ? Math.round(c.responseTimes.reduce((acc, x) => acc + x, 0) / c.responseTimes.length)
            : null;
        const coverage = c.clientActions > 0
            ? Math.round((c.supportActions / c.clientActions) * 100)
            : (c.supportActions > 0 ? 100 : 0);

        return {
            ...c,
            ticketsCount: c.tickets.size,
            avgResponse,
            coverage
        };
    }).sort((a, b) => {
        if (b.ticketsCount !== a.ticketsCount) return b.ticketsCount - a.ticketsCount;
        return b.supportActions - a.supportActions;
    });

    const rowsHtml = collabs.map((c) => `
        <tr>
            <td>${escapeHtml(c.name)}</td>
            <td class="is-number">${c.ticketsCount}</td>
            <td class="is-number">${c.supportActions}</td>
            <td class="is-number">${c.clientActions}</td>
            <td class="is-number">${c.coverage}%</td>
            <td class="is-number">${c.avgResponse === null ? '—' : `${c.avgResponse} min`}</td>
            <td class="is-number">${c.pendingTickets}</td>
        </tr>
    `).join('');

    host.innerHTML = `
        <div class="curadoria-performance-board">
            <div class="curadoria-performance-header">
                <div>
                    <h3>Performance por Colaborador</h3>
                    <p>Análise consolidada para avaliação humana de colaboradores e comportamento de clientes.</p>
                </div>
                <span class="curadoria-performance-total">${rows.length} tickets no filtro atual</span>
            </div>
            <div class="curadoria-performance-table-wrap">
                <table class="curadoria-performance-table">
                    <thead>
                        <tr>
                            <th>Colaborador</th>
                            <th class="is-number">Tickets</th>
                            <th class="is-number">Ações suporte</th>
                            <th class="is-number">Ações cliente</th>
                            <th class="is-number">Cobertura</th>
                            <th class="is-number">TMR</th>
                            <th class="is-number">Pendências</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderCuradoriaCards(rows) {
    const container = document.getElementById('curadoriaCardsContainer');
    const meta = document.getElementById('curadoriaMeta');
    if (!container) return;

    if (!rows || !rows.length) {
        container.innerHTML = '<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--muted);">Nenhum registro encontrado na curadoria.</div>';
        if (meta) meta.textContent = '0 registros';
        return;
    }

    const urgencyType = (value) => getCuradoriaUrgencyType(value || '');

    container.innerHTML = rows.map((row, index) => {
        const urgencia = safeCuradoriaText(row.urgencia);
        const urgenciaSugerida = safeCuradoriaText(row.urgencia_sugerida);
        const urgencyClass = urgencyType(urgencia);
        const ticketId = escapeHtml(String(row.ticket_id ?? ''));
        const owner = escapeHtml(safeCuradoriaText(row.owner));
        const solicitante = escapeHtml(safeCuradoriaText(row.solicitante));
        const servico = escapeHtml(safeCuradoriaText(row.servico));
        const status = escapeHtml(safeCuradoriaText(row.status));
        const equipe = escapeHtml(safeCuradoriaText(row.equipe));
        const ownerTeam = escapeHtml(safeCuradoriaText(row.owner_team));
        const organizacao = escapeHtml(safeCuradoriaText(row.organizacao));
        const modulo = escapeHtml(safeCuradoriaText(row.modulo_rotina_normalizado || row.modulo_x_rotina));
        const causa = escapeHtml(safeCuradoriaText(row.causa_normalizada || row.causa));
        const categoriaFato = escapeHtml(safeCuradoriaText(row.fato_categoria_principal));
        const sentimento = escapeHtml(safeCuradoriaText(row.sentimento));
        const satisfacao = escapeHtml(safeCuradoriaText(row.satisfacao));
        const perfilCliente = escapeHtml(safeCuradoriaText(row.perfil_cliente));
        const totalAcoes = escapeHtml(safeCuradoriaText(row.total_acoes));
        const totalCliente = escapeHtml(safeCuradoriaText(row.total_cliente));
        const totalAgente = escapeHtml(safeCuradoriaText(row.total_agente));
        const processadoEm = escapeHtml(safeCuradoriaText(row.processado_em));

        const recomendacao = escapeHtml(safeCuradoriaText(row.recomendacao_atendente, 'Sem recomendacao registrada'));
        const impacto = escapeHtml(safeCuradoriaText(row.impacto_real));

        return `
            <div class="curadoria-card" data-ticket-id="${ticketId}" tabindex="0" style="--card-index:${index};">
                <div class="curadoria-card-header urgency-${urgencyClass}">
                    <div class="curadoria-ticket-stack">
                        <span class="curadoria-card-id">#${ticketId}</span>
                        <span class="curadoria-ticket-status">${status}</span>
                    </div>
                    <div class="curadoria-badge-pair">
                        ${formatCuradoriaBadge(urgencia, urgencyType(urgencia))}
                        ${formatCuradoriaBadge(urgenciaSugerida, urgencyType(urgenciaSugerida))}
                    </div>
                </div>
                <div class="curadoria-card-body">
                    <div class="curadoria-card-field curadoria-card-field-main">
                        <span class="curadoria-card-label">Servico</span>
                        <span class="curadoria-card-value curadoria-card-main-value">${servico}</span>
                    </div>
                    <div class="curadoria-card-grid">
                        <div class="curadoria-card-field">
                            <span class="curadoria-card-label">Solicitante</span>
                            <span class="curadoria-card-value">${solicitante}</span>
                        </div>
                        <div class="curadoria-card-field">
                            <span class="curadoria-card-label">Organizacao</span>
                            <span class="curadoria-card-value">${organizacao}</span>
                        </div>
                        <div class="curadoria-card-field">
                            <span class="curadoria-card-label">Equipe</span>
                            <span class="curadoria-card-value">${equipe}</span>
                        </div>
                        <div class="curadoria-card-field">
                            <span class="curadoria-card-label">Owner Team</span>
                            <span class="curadoria-card-value">${ownerTeam}</span>
                        </div>
                    </div>
                    <div class="curadoria-card-field curadoria-owner-block">
                        <span class="curadoria-card-label">Owner</span>
                        <div class="curadoria-owner-display">
                            <span class="curadoria-owner-name">${owner}</span>
                        </div>
                    </div>

                    <div class="curadoria-kpi-grid">
                        <div class="curadoria-kpi-item"><span>Acoes</span><strong>${totalAcoes}</strong></div>
                        <div class="curadoria-kpi-item"><span>Cliente</span><strong>${totalCliente}</strong></div>
                        <div class="curadoria-kpi-item"><span>Suporte</span><strong>${totalAgente}</strong></div>
                    </div>

                    <div class="curadoria-tags-row">
                        <span class="curadoria-tag">Modulo: ${modulo}</span>
                        <span class="curadoria-tag">Causa: ${causa}</span>
                        <span class="curadoria-tag">Categoria: ${categoriaFato}</span>
                        <span class="curadoria-tag">Perfil: ${perfilCliente}</span>
                        <span class="curadoria-tag">Sentimento: ${sentimento}</span>
                        <span class="curadoria-tag">Satisfacao: ${satisfacao}</span>
                    </div>

                    <div class="curadoria-card-field">
                        <span class="curadoria-card-label">Impacto Real</span>
                        <span class="curadoria-card-value curadoria-card-multiline">${impacto}</span>
                    </div>
                    <div class="curadoria-card-field">
                        <span class="curadoria-card-label">Recomendacao Atendente</span>
                        <span class="curadoria-card-value curadoria-card-multiline">${recomendacao}</span>
                    </div>
                </div>
                <div class="curadoria-card-footer">
                    <span>Processado em ${processadoEm}</span>
                    <button type="button" class="curadoria-open-btn" data-ticket-id="${ticketId}">Ver analise completa</button>
                </div>
            </div>
        `;
    }).join('');

    if (meta) meta.textContent = `${rows.length} registros`;

    container.querySelectorAll('.curadoria-card, .curadoria-open-btn').forEach(item => {
        item.addEventListener('click', (event) => {
            const target = event.currentTarget;
            const ticketId = target.dataset.ticketId || target.closest('.curadoria-card')?.dataset.ticketId;
            if (!ticketId) return;
            const row = findCuradoriaRowByTicketId(ticketId);
            showCuradoriaResumo(ticketId, row, null);
        });
    });

    container.querySelectorAll('.curadoria-card').forEach((card) => {
        card.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            const ticketId = card.dataset.ticketId;
            if (!ticketId) return;
            const row = findCuradoriaRowByTicketId(ticketId);
            showCuradoriaResumo(ticketId, row, null);
        });
    });
}

function renderCuradoriaPerformanceBoard(rows) {
    const host = document.getElementById('curadoriaPerformanceBoard');
    if (!host) return;

    const kpiHost = document.getElementById('curadoriaKpiBar');
    if (!rows || !rows.length) {
        if (kpiHost) kpiHost.innerHTML = '';
        host.innerHTML = '';
        return;
    }

    const totalTickets = rows.length;
    const totalAcoes = rows.reduce((acc, r) => acc + toCuradoriaNumber(r.total_acoes), 0);
    const owners = new Set(rows.map((row) => safeCuradoriaText(row.owner, '')).filter(Boolean)).size;
    const urgenciaCritica = rows.filter((r) => getCuradoriaUrgencyType(r.urgencia_sugerida || r.urgencia || '') === 'critica').length;
    const avgSatisfacao = rows.reduce((acc, r) => acc + toCuradoriaNumber(r.satisfacao), 0) / rows.length;
    const satisfacaoPercent = Number.isFinite(avgSatisfacao) ? Math.round((avgSatisfacao / 5) * 100) : 0;
    const latestRow = rows[0] || null;

    if (kpiHost) {
        kpiHost.innerHTML = `
            <div class="curadoria-kpi-glass">
                <span>Tickets</span>
                <strong>${totalTickets}</strong>
            </div>
            <div class="curadoria-kpi-glass">
                <span>Acoes</span>
                <strong>${totalAcoes}</strong>
            </div>
            <div class="curadoria-kpi-glass">
                <span>Owners</span>
                <strong>${owners}</strong>
            </div>
        `;
    }

    host.innerHTML = `
        <div class="curadoria-insight-card">
            <strong>Satisfacao media</strong>
            <p>${satisfacaoPercent}% de satisfacao nos tickets carregados.</p>
        </div>
        <div class="curadoria-insight-card">
            <strong>Atencao imediata</strong>
            <p>${urgenciaCritica} ticket(s) critico(s) e ultimo registro em foco #${escapeHtml(String(latestRow?.ticket_id ?? '—'))}.</p>
        </div>
    `;
}

function renderCuradoriaCards(rows) {
    const container = document.getElementById('curadoriaCardsContainer');
    const meta = document.getElementById('curadoriaMeta');
    if (!container) return;

    if (!rows || !rows.length) {
        container.innerHTML = '<div class="curadoria-empty-state">Nenhum registro encontrado na curadoria.</div>';
        if (meta) meta.textContent = '0 registros';
        return;
    }

    const featuredRows = rows.slice(0, 1);

    container.innerHTML = featuredRows.map((row) => {
        const ticketId = escapeHtml(String(row.ticket_id ?? ''));
        const servico = escapeHtml(safeCuradoriaText(row.servico));
        const owner = escapeHtml(safeCuradoriaText(row.owner));
        const status = escapeHtml(safeCuradoriaText(row.status));
        const solicitante = escapeHtml(safeCuradoriaText(row.solicitante));
        const urgencia = escapeHtml(safeCuradoriaText(row.urgencia_sugerida || row.urgencia));
        const resumo = escapeHtml(safeCuradoriaText(row.resumo, 'Sem resumo registrado.'));
        const ownerTeam = escapeHtml(safeCuradoriaText(row.owner_team || row.equipe, 'Owner do chamado'));

        return `
            <article class="curadoria-preview-item curadoria-portrait-card" data-ticket-id="${ticketId}">
                <div class="curadoria-portrait-media">
                    <div class="curadoria-portrait-overlay"></div>
                    <div class="curadoria-portrait-topline">
                        <span class="curadoria-preview-ticket">Ticket #${ticketId}</span>
                    </div>
                    <div class="curadoria-portrait-content">
                        <div class="curadoria-portrait-copy">
                            <strong>${owner}</strong>
                            <p>${ownerTeam}</p>
                        </div>
                        <div class="curadoria-portrait-pill">${urgencia}</div>
                    </div>
                </div>
                <div class="curadoria-preview-meta">
                    <span>${servico}</span>
                    <span>${status}</span>
                    <span>${solicitante}</span>
                </div>
                <p class="curadoria-portrait-summary">${resumo}</p>
            </article>
        `;
    }).join('');

    if (meta) meta.textContent = `${rows.length} registros`;

    container.querySelectorAll('.curadoria-preview-item').forEach(item => {
        item.addEventListener('click', (event) => {
            const target = event.currentTarget;
            const ticketId = target.dataset.ticketId;
            if (!ticketId) return;
            const row = findCuradoriaRowByTicketId(ticketId);
            showCuradoriaResumo(ticketId, row);
        });
    });
}

// Normaliza texto como em curadoria.html (remove acentos e normaliza espaços)
function normalizeCuradoriaText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function populateSelectOptions() {
    if (!_curadoriaRows || _curadoriaRows.length === 0) return;

    // Use Maps para deduplicar baseado em valores normalizados
    const servicos = new Map(); // normalized -> original
    const owners = new Map();   // normalized -> original
    const equipes = new Map();  // normalized -> original
    const solicitantes = new Map(); // normalized -> original

    _curadoriaRows.forEach(row => {
        if (row.servico) {
            const norm = normalizeCuradoriaText(row.servico);
            if (!servicos.has(norm)) servicos.set(norm, row.servico);
        }
        if (row.owner) {
            const norm = normalizeCuradoriaText(row.owner);
            if (!owners.has(norm)) owners.set(norm, row.owner);
        }
        if (row.equipe) {
            const norm = normalizeCuradoriaText(row.equipe);
            if (!equipes.has(norm)) equipes.set(norm, row.equipe);
        }
        if (row.solicitante) {
            const norm = normalizeCuradoriaText(row.solicitante);
            if (!solicitantes.has(norm)) solicitantes.set(norm, row.solicitante);
        }
    });

    const filterServico = document.getElementById('filterServico');
    const filterOwner = document.getElementById('filterOwner');
    const filterCuradoriaEquipe = document.getElementById('filterCuradoriaEquipe');
    const filterSolicitante = document.getElementById('filterSolicitante');

    // Popular Serviço
    if (filterServico) {
        const currentValue = filterServico.value;
        const options = ['<option value="">Todos os serviços</option>'];
        Array.from(servicos.values()).sort().forEach(s => {
            options.push(`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
        });
        filterServico.innerHTML = options.join('');
        filterServico.value = currentValue;
    }

    // Popular Owner
    if (filterOwner) {
        const currentValue = filterOwner.value;
        const options = ['<option value="">Todos os owners</option>'];
        Array.from(owners.values()).sort().forEach(o => {
            options.push(`<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`);
        });
        filterOwner.innerHTML = options.join('');
        filterOwner.value = currentValue;
    }

    if (filterCuradoriaEquipe) {
        const currentValue = filterCuradoriaEquipe.value;
        const options = ['<option value="">Todas as equipes</option>'];
        Array.from(equipes.values()).sort().forEach(e => {
            options.push(`<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`);
        });
        filterCuradoriaEquipe.innerHTML = options.join('');
        filterCuradoriaEquipe.value = currentValue;
    }

    // Popular Solicitante
    if (filterSolicitante) {
        const currentValue = filterSolicitante.value;
        const options = ['<option value="">Todos os solicitantes</option>'];
        Array.from(solicitantes.values()).sort().forEach(s => {
            options.push(`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
        });
        filterSolicitante.innerHTML = options.join('');
        filterSolicitante.value = currentValue;
    }
}

function populateCuradoriaFilters() {
    if (_curadoriaFiltersReady) return;
    _curadoriaFiltersReady = true;

    const filterServico = document.getElementById('filterServico');
    const filterOwner = document.getElementById('filterOwner');
    const filterCuradoriaEquipe = document.getElementById('filterCuradoriaEquipe');
    const filterSolicitante = document.getElementById('filterSolicitante');
    const filterCuradoriaUrgencia = document.getElementById('filterCuradoriaUrgencia');
    const filterCuradoriaUrgenciaSugerida = document.getElementById('filterCuradoriaUrgenciaSugerida');
    const clearBtn = document.getElementById('curadoriaFilterClear');

    function applyFilters() {
        const servico = filterServico ? filterServico.value.trim() : '';
        const owner = filterOwner ? filterOwner.value.trim() : '';
        const equipe = filterCuradoriaEquipe ? filterCuradoriaEquipe.value.trim() : '';
        const solicitante = filterSolicitante ? filterSolicitante.value.trim() : '';
        const urgencia = filterCuradoriaUrgencia ? filterCuradoriaUrgencia.value.toLowerCase().trim() : '';
        const urgenciaSugerida = filterCuradoriaUrgenciaSugerida ? filterCuradoriaUrgenciaSugerida.value.toLowerCase().trim() : '';

        const filtered = _curadoriaRows.filter(row => {
            // Compara usando normalização de texto (sem acentos e espaços extras)
            if (servico && normalizeCuradoriaText(row.servico) !== normalizeCuradoriaText(servico)) return false;
            if (owner && normalizeCuradoriaText(row.owner) !== normalizeCuradoriaText(owner)) return false;
            if (equipe && normalizeCuradoriaText(row.equipe) !== normalizeCuradoriaText(equipe)) return false;
            if (solicitante && normalizeCuradoriaText(row.solicitante) !== normalizeCuradoriaText(solicitante)) return false;
            if (urgencia) {
                const urg = getCuradoriaUrgencyType(row.urgencia || '');
                if (urg !== urgencia) return false;
            }
            if (urgenciaSugerida) {
                const urgSug = getCuradoriaUrgencyType(row.urgencia_sugerida || '');
                if (urgSug !== urgenciaSugerida) return false;
            }
            return true;
        });

        renderCuradoriaPerformanceBoard(filtered);
        renderCuradoriaCards(filtered);
    }

    // Listeners para os selects (agora usa 'change' em vez de 'input')
    [filterServico, filterOwner, filterCuradoriaEquipe, filterSolicitante, filterCuradoriaUrgencia, filterCuradoriaUrgenciaSugerida].forEach(el => {
        if (el) el.addEventListener('change', applyFilters);
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (filterServico) filterServico.value = '';
            if (filterOwner) filterOwner.value = '';
            if (filterCuradoriaEquipe) filterCuradoriaEquipe.value = '';
            if (filterSolicitante) filterSolicitante.value = '';
            if (filterCuradoriaUrgencia) filterCuradoriaUrgencia.value = '';
            if (filterCuradoriaUrgenciaSugerida) filterCuradoriaUrgenciaSugerida.value = '';
            applyFilters();
        });
    }
}

function showCuradoriaResumo(ticketId, payload, sourceEl = null) {
    const modal = document.getElementById('executiveSummaryModal');
    const title = document.getElementById('executiveSummaryTitle');
    const body = document.getElementById('executiveSummaryBody');
    const openBtn = document.getElementById('executiveSummaryOpenTicket');

    if (modal && title && body) {
        title.textContent = `Análise completa - Ticket #${escapeHtml(ticketId)}`;

        const row = payload && typeof payload === 'object' ? payload : findCuradoriaRowByTicketId(ticketId);
        const resumo = row ? safeCuradoriaText(row.resumo, '') : '';
        const conclusao = row ? safeCuradoriaText(row.conclusao, '') : '';
        const recomendacao = row ? safeCuradoriaText(row.recomendacao_atendente, '') : '';
        const perfil = row ? safeCuradoriaText(row.perfil_cliente) : '—';
        const urgencia = row ? safeCuradoriaText(row.urgencia) : '—';
        const urgenciaSugerida = row ? safeCuradoriaText(row.urgencia_sugerida) : '—';
        const sentimento = row ? safeCuradoriaText(row.sentimento) : '—';
        const satisfacao = row ? safeCuradoriaText(row.satisfacao) : '—';

        const tabelaAcoes = row ? parseCuradoriaJsonArray(row.tabela_acoes) : [];
        const diagnosticoRaw = row ? parseJsonLoose(row.diagnostico_raw) : null;
        const analiseCompleta = row ? parseJsonLoose(row.analise_completa) : null;
        const comportamentoSuporteBanco = row ? parseCuradoriaObjectArray(row.comportamento_suporte, []) : [];
        const comportamentoClienteBanco = row ? parseCuradoriaObject(row.comportamento_cliente, null) : null;
        const dinamicaConversaBanco = row ? parseCuradoriaObject(row.dinamica_conversa, null) : null;
        const mergedWithDate = buildCuradoriaMergedActions(row);
        const merged = mergedWithDate;

        const supportActions = mergedWithDate.filter((a) => a.role === 'suporte');
        const clientActions = mergedWithDate.filter((a) => a.role === 'cliente');
        const supportShare = mergedWithDate.length ? Math.round((supportActions.length / mergedWithDate.length) * 100) : 0;

        const responseMinutes = [];
        let pendingClientInteractions = 0;

        for (let i = 0; i < mergedWithDate.length; i += 1) {
            const current = mergedWithDate[i];
            if (current.role !== 'cliente') continue;

            let replied = false;
            for (let j = i + 1; j < mergedWithDate.length; j += 1) {
                const next = mergedWithDate[j];
                if (next.role !== 'suporte') continue;

                replied = true;
                if (current._parsedDate && next._parsedDate) {
                    const diffMin = Math.max(0, Math.round((next._parsedDate - current._parsedDate) / 60000));
                    responseMinutes.push(diffMin);
                }
                break;
            }

            if (!replied) {
                pendingClientInteractions += 1;
            }
        }

        const avgResponseMinutes = responseMinutes.length
            ? Math.round(responseMinutes.reduce((acc, x) => acc + x, 0) / responseMinutes.length)
            : null;
        const lastSupportAction = [...supportActions].reverse().find((a) => a.data)?.data || '—';

        const supportByCollaborator = new Map();
        const ensureSupportCollab = (name) => {
            const key = safeCuradoriaText(name, 'Sem identificação');
            if (!supportByCollaborator.has(key)) {
                supportByCollaborator.set(key, {
                    name: key,
                    actions: 0,
                    responses: 0,
                    responseTimes: [],
                    lastAction: '—'
                });
            }
            return supportByCollaborator.get(key);
        };

        for (const action of supportActions) {
            const collab = ensureSupportCollab(action.criadoPor);
            collab.actions += 1;
            collab.lastAction = action.data || collab.lastAction;
        }

        for (let i = 0; i < mergedWithDate.length; i += 1) {
            const current = mergedWithDate[i];
            if (current.role !== 'cliente') continue;

            for (let j = i + 1; j < mergedWithDate.length; j += 1) {
                const next = mergedWithDate[j];
                if (next.role !== 'suporte') continue;
                const collab = ensureSupportCollab(next.criadoPor);
                collab.responses += 1;
                if (current._parsedDate && next._parsedDate) {
                    const diffMin = Math.max(0, Math.round((next._parsedDate - current._parsedDate) / 60000));
                    collab.responseTimes.push(diffMin);
                }
                break;
            }
        }

        const supportCollabRows = Array.from(supportByCollaborator.values())
            .map((c) => ({
                ...c,
                avgResponse: c.responseTimes.length
                    ? Math.round(c.responseTimes.reduce((acc, x) => acc + x, 0) / c.responseTimes.length)
                    : null
            }))
            .sort((a, b) => {
                if (b.actions !== a.actions) return b.actions - a.actions;
                return b.responses - a.responses;
            });

        const supportCollabHtml = supportCollabRows.length
            ? supportCollabRows.map((c) => `
                <tr>
                    <td>${escapeHtml(c.name)}</td>
                    <td style="text-align:right;">${c.actions}</td>
                    <td style="text-align:right;">${c.responses}</td>
                    <td style="text-align:right;">${c.avgResponse === null ? '—' : `${c.avgResponse} min`}</td>
                    <td style="text-align:right;">${escapeHtml(c.lastAction || '—')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="5" class="pm-info">Sem ações de suporte identificadas neste ticket.</td></tr>';

        const suporteIndividualRows = comportamentoSuporteBanco.length
            ? comportamentoSuporteBanco.map((item) => {
                const nome = safeCuradoriaText(item.nome, 'Sem identificação');
                const ids = Array.isArray(item.ids) ? item.ids : [];
                const pontos = Array.isArray(item.pontos) ? item.pontos : [];
                const pontosHtml = pontos.length
                    ? `<ul class="curadoria-individual-points">${pontos.map((p) => `<li>${escapeHtml(String(p))}</li>`).join('')}</ul>`
                    : '<p class="curadoria-individual-empty">Sem pontos registrados.</p>';
                return `
                    <article class="curadoria-individual-card suporte">
                        <header>
                            <h6>${escapeHtml(nome)}</h6>
                            <span>${ids.length ? `Ações: ${ids.join(', ')}` : 'Sem IDs de ações'}</span>
                        </header>
                        ${pontosHtml}
                    </article>
                `;
            }).join('')
            : '<p class="curadoria-individual-empty">Sem análise individual de suporte registrada no banco.</p>';

        const clienteNome = safeCuradoriaText(comportamentoClienteBanco?.nome || row?.solicitante, 'Cliente não identificado');
        const clientePerfil = safeCuradoriaText(comportamentoClienteBanco?.perfil || row?.perfil_cliente, '—');
        const clientePadrao = safeCuradoriaText(comportamentoClienteBanco?.padrao_emocional, 'Sem padrão emocional detalhado.');
        const clientePontos = Array.isArray(comportamentoClienteBanco?.pontos) ? comportamentoClienteBanco.pontos : [];
        const clientePontosHtml = clientePontos.length
            ? `<ul class="curadoria-individual-points">${clientePontos.map((p) => `<li>${escapeHtml(String(p))}</li>`).join('')}</ul>`
            : '<p class="curadoria-individual-empty">Sem pontos de comportamento do cliente no banco.</p>';

        const dinamicaHtml = dinamicaConversaBanco
            ? `
                <div class="curadoria-dinamica-grid">
                    <div><span>Tempo de resposta</span><strong>${escapeHtml(safeCuradoriaText(dinamicaConversaBanco.tempo_resposta, '—'))}</strong></div>
                </div>
            `
            : '';

        let supportPerformanceLabel = 'Sem base';
        if (supportActions.length > 0) {
            if (avgResponseMinutes !== null && avgResponseMinutes <= 30 && pendingClientInteractions === 0) {
                supportPerformanceLabel = 'Excelente';
            } else if (avgResponseMinutes !== null && avgResponseMinutes <= 120 && pendingClientInteractions <= 1) {
                supportPerformanceLabel = 'Bom';
            } else {
                supportPerformanceLabel = 'Atencao';
            }
        }

        const resumoText = [resumo, conclusao, recomendacao].filter(Boolean).join(' ');
        const safeResumo = resumoText || 'Sem resumo detalhado para este ticket.';

        const timelineHtml = merged.length
            ? merged.map((a) => `
                <div class="curadoria-audit-item ${a.role}">
                    <div class="curadoria-audit-head">
                        <span class="curadoria-audit-actor">${escapeHtml(a.ator)}</span>
                        <span class="curadoria-audit-author">${escapeHtml(a.criadoPor)}</span>
                        <span class="curadoria-audit-date">#${escapeHtml(String(a.id))} · ${escapeHtml(a.data || '—')}</span>
                    </div>
                    <div class="curadoria-audit-desc">${escapeHtmlWithBreaks(a.descricao || 'Sem descrição')}</div>
                </div>
            `).join('')
            : '<p class="pm-info">Sem ações disponíveis no campo actions.</p>';

        const tableSource = tabelaAcoes.length ? tabelaAcoes : merged;
        const tableHtml = tableSource.length
            ? tableSource.map((a) => `
                <tr>
                    <td>#${escapeHtml(String(a.id ?? '—'))}</td>
                    <td>${escapeHtml(String(a.ator || '—'))}</td>
                    <td>${escapeHtml(String(a.origem || '—'))}</td>
                    <td>${escapeHtml(String(a.criado_por || a.criadoPor || a.autor || '—'))}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="4" class="pm-info">Sem dados de tabela_acoes.</td></tr>';

        body.innerHTML = `
            <div class="resumo-executivo">
                <section class="resumo-secao resumo-secao-compacta">
                    <h4>Resumo Executivo</h4>
                    <p class="resumo-highlight">${escapeHtml(safeResumo)}</p>
                    <div class="resumo-badges" style="margin-top:10px; justify-content:flex-start;">
                        <span class="badge-urgencia urgency-${getCuradoriaUrgencyType(urgencia)}">Movidesk: ${escapeHtml(urgencia)}</span>
                        <span class="badge-urgencia urgency-${getCuradoriaUrgencyType(urgenciaSugerida)}">Sugerida: ${escapeHtml(urgenciaSugerida)}</span>
                        <span class="badge-urgencia urgency-none">Perfil: ${escapeHtml(perfil)}</span>
                        <span class="badge-urgencia urgency-none">Sentimento: ${escapeHtml(sentimento)}</span>
                        <span class="badge-urgencia urgency-none">Satisfacao: ${escapeHtml(satisfacao)}</span>
                    </div>

                    <div class="curadoria-support-performance">
                        <h5>Performance do Suporte</h5>
                        <div class="curadoria-support-performance-grid">
                            <div class="curadoria-support-metric">
                                <span class="label">Acoes do suporte</span>
                                <strong>${escapeHtml(String(supportActions.length))}</strong>
                            </div>
                            <div class="curadoria-support-metric">
                                <span class="label">Participacao</span>
                                <strong>${escapeHtml(String(supportShare))}%</strong>
                            </div>
                            <div class="curadoria-support-metric">
                                <span class="label">Tempo medio de resposta</span>
                                <strong>${avgResponseMinutes === null ? '—' : `${escapeHtml(String(avgResponseMinutes))} min`}</strong>
                            </div>
                            <div class="curadoria-support-metric">
                                <span class="label">Interacoes pendentes</span>
                                <strong>${escapeHtml(String(pendingClientInteractions))}</strong>
                            </div>
                            <div class="curadoria-support-metric wide">
                                <span class="label">Ultima acao do suporte</span>
                                <strong>${escapeHtml(String(lastSupportAction))}</strong>
                            </div>
                            <div class="curadoria-support-metric wide">
                                <span class="label">Indicador</span>
                                <strong>${escapeHtml(supportPerformanceLabel)}</strong>
                            </div>
                        </div>

                        <div class="curadoria-individual-section">
                            <h5>Análises Individuais por Ticket (Banco)</h5>
                            <div class="curadoria-individual-grid">
                                ${suporteIndividualRows}
                            </div>
                            <article class="curadoria-individual-card cliente">
                                <header>
                                    <h6>${escapeHtml(clienteNome)}</h6>
                                    <span>Perfil: ${escapeHtml(clientePerfil)}</span>
                                </header>
                                <p class="curadoria-individual-pattern">${escapeHtml(clientePadrao)}</p>
                                ${clientePontosHtml}
                            </article>
                            ${dinamicaHtml}
                        </div>

                        <div style="margin-top:10px; overflow:auto;">
                            <table class="curadoria-audit-table" style="min-width:620px;">
                                <thead>
                                    <tr>
                                        <th>Colaborador (ticket)</th>
                                        <th style="text-align:right;">Ações</th>
                                        <th style="text-align:right;">Respostas</th>
                                        <th style="text-align:right;">TMR</th>
                                        <th style="text-align:right;">Última ação</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${supportCollabHtml}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>
                <section class="resumo-secao resumo-secao-compacta">
                    <div class="curadoria-audit-tabs" id="curadoriaAuditTabs">
                        <button class="active" data-tab="timeline">Timeline (${merged.length})</button>
                        <button data-tab="table">Tabela resumida</button>
                    </div>

                    <div class="curadoria-audit-panel active" data-panel="timeline">
                        <div class="curadoria-audit-timeline">
                            ${timelineHtml}
                        </div>
                    </div>

                    <div class="curadoria-audit-panel" data-panel="table">
                        <div class="curadoria-audit-table-wrap">
                            <table class="curadoria-audit-table">
                                <thead>
                                    <tr>
                                        <th>ID</th>
                                        <th>Ator</th>
                                        <th>Origem</th>
                                        <th>Criado por</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableHtml}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>
            </div>
        `;

        const tabsHost = body.querySelector('#curadoriaAuditTabs');
        if (tabsHost) {
            const tabButtons = tabsHost.querySelectorAll('button[data-tab]');
            const panels = body.querySelectorAll('.curadoria-audit-panel');
            tabButtons.forEach((btn) => {
                btn.addEventListener('click', () => {
                    const tab = btn.dataset.tab;
                    tabButtons.forEach((x) => x.classList.remove('active'));
                    panels.forEach((p) => p.classList.remove('active'));
                    btn.classList.add('active');
                    const panel = body.querySelector(`.curadoria-audit-panel[data-panel="${tab}"]`);
                    if (panel) panel.classList.add('active');
                });
            });
        }

        if (openBtn) {
            openBtn.onclick = () => window.open(`https://viasoft.movidesk.com/Ticket/Edit/${ticketId}`, '_blank');
        }

        modal.style.display = 'flex';
        playExecutiveSummaryOpenAnimation(sourceEl);
    }
}

function renderCuradoriaTable(rows) {
    const tbody = document.getElementById('curadoriaTbody');
    const meta = document.getElementById('curadoriaMeta');
    if (!tbody) return;

    if (!rows || !rows.length) {
        tbody.innerHTML = '<tr><td colspan="12" class="pessoas-loading">Nenhum registro encontrado na curadoria.</td></tr>';
        if (meta) meta.textContent = '0 registros';
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td><span class="curadoria-ticket-id">#${escapeHtml(String(row.ticket_id ?? ''))}</span></td>
            <td>${formatCuradoriaBadge(row.status, 'neutral')}</td>
            <td>${formatCuradoriaBadge(row.urgencia_sugerida || row.urgencia, getCuradoriaUrgencyType(row.urgencia_sugerida || row.urgencia))}</td>
            <td>${escapeHtml(row.servico || '—')}</td>
            <td>${escapeHtml(row.owner || '—')}</td>
            <td>${escapeHtml(row.solicitante || '—')}</td>
            <td>${escapeHtml(row.organizacao || '—')}</td>
            <td>${escapeHtml(row.equipe || '—')}</td>
            <td class="curadoria-cell-long">${escapeHtml(row.resumo || '—')}</td>
            <td class="curadoria-cell-long">${escapeHtml(row.analise_fato || row.fato || '—')}</td>
            <td class="curadoria-cell-long">${escapeHtml(row.causa || '—')}</td>
            <td class="curadoria-cell-long">${escapeHtml(row.acao || '—')}</td>
        </tr>
    `).join('');

    if (meta) meta.textContent = `${rows.length} registros`;
}

async function loadCuradoria() {
    const container = document.getElementById('curadoriaCardsContainer');
    const meta = document.getElementById('curadoriaMeta');

    // Carrega o cache de usuários se ainda não foi carregado
    if (_usersCache.length === 0) {
        try {
            const response = await fetch(`${API_BASE}/pessoas`, {
                headers: authHeaders()
            });
            if (response.ok) {
                _usersCache = await response.json();
            }
        } catch (e) {
            console.warn('Não foi possível carregar cache de usuários:', e);
        }
    }

    // Configura filtros uma única vez (não depende dos dados)
    populateCuradoriaFilters();

    // Se já carregou, só re-renderiza do cache
    if (_curadoriaLoaded && _curadoriaRows.length) {
        populateSelectOptions();
        renderCuradoriaPerformanceBoard(_curadoriaRows);
        renderCuradoriaCards(_curadoriaRows);
        if (meta) meta.textContent = `${_curadoriaRows.length} registros`;
        return;
    }

    if (container) {
        container.innerHTML = '<div class="curadoria-empty-state">Carregando curadoria...</div>';
    }
    if (meta) meta.textContent = 'Carregando...';

    try {
        const res = await fetch(CURADORIA_API, {
            headers: authHeaders()
        });
        if (!res.ok) throw new Error(`Erro na API: ${res.status}`);
        const rows = await res.json();
        _curadoriaRows = rows;
        populateSelectOptions();
        renderCuradoriaPerformanceBoard(rows);
        renderCuradoriaCards(rows);
        _curadoriaLoaded = true;
    } catch (error) {
        console.error('Erro ao carregar curadoria:', error);
        if (container) {
            container.innerHTML = `<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #ef4444;">Erro ao carregar curadoria. ${escapeHtml(error.message)}</div>`;
        }
        if (meta) meta.textContent = 'Falha ao carregar';
    }
}

function closeExecutiveSummaryModal() {
    const modal = document.getElementById('executiveSummaryModal');
    if (modal) {
        modal.classList.remove('modal-opening-from-avatar');
        const box = modal.querySelector('.executive-modal-box');
        if (box) {
            box.classList.remove('modal-opening-from-avatar-box');
            box.style.removeProperty('--modal-start-x');
            box.style.removeProperty('--modal-start-y');
            box.style.removeProperty('--modal-start-scale-x');
            box.style.removeProperty('--modal-start-scale-y');
        }
        modal.style.display = 'none';
    }
}

function playExecutiveSummaryOpenAnimation(sourceEl) {
    const modal = document.getElementById('executiveSummaryModal');
    const box = modal?.querySelector('.executive-modal-box');
    if (!modal || !box || !(sourceEl instanceof Element)) return;

    modal.classList.remove('modal-opening-from-avatar');
    box.classList.remove('modal-opening-from-avatar-box');

    const sourceRect = sourceEl.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    if (!sourceRect.width || !sourceRect.height || !boxRect.width || !boxRect.height) return;

    const sourceCenterX = sourceRect.left + (sourceRect.width / 2);
    const sourceCenterY = sourceRect.top + (sourceRect.height / 2);
    const boxCenterX = boxRect.left + (boxRect.width / 2);
    const boxCenterY = boxRect.top + (boxRect.height / 2);

    box.style.setProperty('--modal-start-x', `${sourceCenterX - boxCenterX}px`);
    box.style.setProperty('--modal-start-y', `${sourceCenterY - boxCenterY}px`);
    box.style.setProperty('--modal-start-scale-x', Math.max(0.06, Math.min(0.22, sourceRect.width / boxRect.width)).toFixed(3));
    box.style.setProperty('--modal-start-scale-y', Math.max(0.06, Math.min(0.22, sourceRect.height / boxRect.height)).toFixed(3));
    modal.style.setProperty('--modal-origin-x', `${sourceCenterX}px`);
    modal.style.setProperty('--modal-origin-y', `${sourceCenterY}px`);

    modal.classList.add('modal-opening-from-avatar');
    box.classList.add('modal-opening-from-avatar-box');

    window.setTimeout(() => {
        modal.classList.remove('modal-opening-from-avatar');
        box.classList.remove('modal-opening-from-avatar-box');
    }, 720);
}

function parseJsonValue(value, fallback) {
    if (!value) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function extractCustomFieldValue(customFields, terms) {
    const list = Array.isArray(customFields) ? customFields : [];
    const found = list.find((item) => {
        const blob = JSON.stringify(item || {}).toLowerCase();
        return terms.some((term) => blob.includes(term));
    });
    if (!found) return '';
    if (typeof found.value === 'string' && found.value.trim()) return found.value.trim();
    if (Array.isArray(found.items) && found.items.length) {
        return found.items
            .map((item) => item.businessName || item.value || item.label || '')
            .filter(Boolean)
            .join(', ');
    }
    return '';
}

function buildLocalAnalysisTicket(ticket) {
    const customFields = parseJsonValue(ticket.customFields, []);
    const actions = parseJsonValue(ticket.actionsJson, []);

    return {
        ...ticket,
        customFields,
        actions,
        causa: extractCustomFieldValue(customFields, ['causa']) || ticket.causa || '',
        fato: extractCustomFieldValue(customFields, ['fato']) || ticket.fato || ticket.subject || '',
        ModuloXRotina: extractCustomFieldValue(customFields, ['moduloxrotina', 'modulo x rotina', 'modulo']) || ticket.ModuloXRotina || ticket.serviceSecondLevel || ticket.serviceFirstLevel || ''
    };
}

async function handleCardClick(ticketId) {
    console.log('Card clicado - Ticket ID:', ticketId, 'Tipo:', typeof ticketId);

    const normalizedId = Number(ticketId);
    let ticket = null;
    if (_cachedTickets && _cachedTickets.length > 0) {
        ticket = _cachedTickets.find(t => Number(t.id) === normalizedId);
    }
    // Cache da aba Movidesk (ativos + encerrados) — mantido em sincronia com
    // a cópia desta função em dashboard.js, que é sobrescrita por essa aqui
    // (curadoria.js carrega depois). Sem isso, chamados já fechados (só
    // existem em _cachedMovideskTickets) sempre cairiam no fallback abaixo.
    if (!ticket && typeof _cachedMovideskTickets !== 'undefined' && _cachedMovideskTickets && _cachedMovideskTickets.length > 0) {
        ticket = _cachedMovideskTickets.find(t => Number(t.id) === normalizedId);
    }

    if (!ticket) {
        console.warn(`Ticket ${ticketId} (normalizado: ${normalizedId}) nao encontrado no cache. Cache total: ${_cachedTickets ? _cachedTickets.length : 0}`);
        console.log('IDs disponiveis no cache:', _cachedTickets?.map(t => ({ id: t.id, tipo: typeof t.id })).slice(0, 5));
        window.open(`https://viasoft.movidesk.com/Ticket/Edit/${ticketId}`, '_blank');
        return;
    }

    const modal = document.getElementById('executiveSummaryModal');
    const title = document.getElementById('executiveSummaryTitle');
    const body = document.getElementById('executiveSummaryBody');
    const openBtn = document.getElementById('executiveSummaryOpenTicket');

    if (!modal || !title || !body) {
        console.error('Modal ou elementos nao encontrados');
        return;
    }

    title.innerHTML = `Análise do Ticket #${ticketId}`;
    body.innerHTML = '<div class="pm-info">Gerando análise do ticket...</div>';
    modal.style.display = 'flex';

    let analise = null;
    try {
        const response = await fetch(`${API_BASE}/tickets/${ticketId}/executive-summary`, {
            method: 'POST',
            headers: authHeaders()
        });
        const raw = await response.text();
        let data = {};
        if (raw) {
            try { data = JSON.parse(raw); } catch { data = { error: raw }; }
        }
        if (!response.ok) {
            throw new Error(data.error || 'Falha ao gerar analise com IA');
        }
        analise = data.summary || null;
        console.log('Analise via prompt gerada');
    } catch (error) {
        console.warn('Falha ao gerar analise com IA, usando fallback local:', error);
        try {
            const fallbackResponse = await fetch(`${API_BASE}/tickets/${ticketId}`, {
                headers: authHeaders()
            });
            const fallbackRaw = await fallbackResponse.text();
            let fallbackData = {};
            if (fallbackRaw) {
                try { fallbackData = JSON.parse(fallbackRaw); } catch { fallbackData = { error: fallbackRaw }; }
            }
            if (!fallbackResponse.ok) {
                throw new Error(fallbackData.error || 'Falha ao carregar ticket completo para fallback');
            }
            analise = analyzeTicket(buildLocalAnalysisTicket(fallbackData));
        } catch (fallbackError) {
            console.warn('Falha no fallback detalhado, usando cache local:', fallbackError);
            analise = analyzeTicket(buildLocalAnalysisTicket(ticket));
        }
    }

    body.innerHTML = formatarResumoExecutivoCompacto(analise);

    if (openBtn) {
        openBtn.onclick = () => {
            window.open(`https://viasoft.movidesk.com/Ticket/Edit/${ticketId}`, '_blank');
        };
    }
}

// Pill permanente de última atualização

// ─── Cache de tickets para Área de Pessoas (declarado em script.js) ────────

// ─── Navegação entre Views ────────────────────────────────────────
function navigateTo(view) {
    // Normaliza para evitar bugs com acentos ou espaços vindos de data-view
    const normalizedView = (view || '').trim().toLowerCase();

    if (EMBED_MODE) {
        if (normalizedView === 'configuracoes' && !isCurrentUserAdmin()) {
            return;
        }

        document.querySelectorAll('.sidebar-btn[data-view]').forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.sidebar-btn[data-view="${normalizedView}"]`);
        if (activeBtn) activeBtn.classList.add('active');

        loadEmbeddedPage(normalizedView);
        localStorage.setItem('activeEmbeddedView', normalizedView);
        return;
    }

    const views = {
        dashboard: document.getElementById('dashboardView'),
        chamados: document.getElementById('curadoriaView'),
        pessoas:   document.getElementById('pessoasView'),
        configuracoes: document.getElementById('configuracoesView'),
    };

    if (normalizedView === 'configuracoes' && !isCurrentUserAdmin()) {
        const denied = document.getElementById('configAccessDenied');
        if (denied) denied.style.display = 'block';
        return;
    }

    const denied = document.getElementById('configAccessDenied');
    if (denied) denied.style.display = 'none';

    document.querySelectorAll('.sidebar-btn[data-view]').forEach(b => b.classList.remove('active'));
    Object.values(views).forEach(v => { if (v) v.style.display = 'none'; });

    if (views[normalizedView]) views[normalizedView].style.display = 'block';
    const activeBtn = document.querySelector(`.sidebar-btn[data-view="${normalizedView}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    if (normalizedView === 'dashboard') {
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

function isCurrentUserAdmin() {
    return String(_currentUser?.role || '').toLowerCase() === 'admin';
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

// Mantida em sincronia com a cópia desta função em auth.js — curadoria.js
// carrega depois e sobrescreve o global, então precisa repetir a lógica
// aqui. TAB_PERMISSION_BTN_BY_KEY é declarada só uma vez, em auth.js.
async function applyRoleBasedNavigation() {
    const cfgBtn = document.getElementById('navConfiguracoes');
    const pessoasBtn = document.getElementById('navPessoas');
    if (!cfgBtn) return;

    const admin = isCurrentUserAdmin();

    cfgBtn.style.display = admin ? 'flex' : 'none';
    if (pessoasBtn) pessoasBtn.style.display = admin ? 'flex' : 'none';

    // Botão "Sincronizar" da aba Movidesk: também admin-only, mesmo critério.
    const mdSyncBtn = document.getElementById('mdSyncDbBtn');
    if (mdSyncBtn) mdSyncBtn.style.display = admin ? '' : 'none';

    if (admin) {
        Object.values(TAB_PERMISSION_BTN_BY_KEY).forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) btn.style.display = 'flex';
        });
    } else {
        let allowed = isCurrentUserGuest()
            ? ['dashboard']
            : ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk'];
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

