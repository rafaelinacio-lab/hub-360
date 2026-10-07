
// ── config.js — Painel de configurações ───────────────────────────────────

function setCfgStatus(elementId, message, type = '') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `config-status${type ? ` ${type}` : ''}`;
}

async function loadMovideskTokenStatus() {
    try {
        const response = await fetch(`${API_BASE}/config/token`, {
            headers: authHeaders()
        });
        if (!response.ok) throw new Error('Falha ao consultar token Movidesk');
        const data = await response.json();
        const badge = document.getElementById('cfgMovideskTokenStatus');
        if (!badge) return;

        if (data.tokenExists) {
            badge.textContent = 'Configurado';
            badge.className = 'config-token-status config-token-status-on';
        } else {
            badge.textContent = 'Nao configurado';
            badge.className = 'config-token-status config-token-status-off';
        }
    } catch (error) {
        setCfgStatus('cfgMovideskStatus', `Erro ao verificar token: ${error.message}`, 'error');
    }
}

async function saveMovideskToken() {
    const input = document.getElementById('cfgMovideskToken');
    const token = input?.value?.trim();
    if (!token) {
        setCfgStatus('cfgMovideskStatus', 'Informe o token Movidesk antes de salvar.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/token`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar token');

        input.value = '';
        setCfgStatus('cfgMovideskStatus', 'Token Movidesk salvo com sucesso.', 'ok');
        await loadMovideskTokenStatus();
    } catch (error) {
        setCfgStatus('cfgMovideskStatus', `Erro ao salvar token: ${error.message}`, 'error');
    }
}

// Atualiza o dashboard a cada 2 minutos buscando de novo os chamados da equipe do usuário
// logado (o servidor aplica o filtro de equipe). Não dispara sync na API do Movidesk.
// Com a aba do navegador escondida não busca; ao voltar, atualiza na hora se já passou o prazo.
const DASHBOARD_REFRESH_MS = 2 * 60 * 1000;
let _dashboardRefreshIntervalId = null;
let _dashboardRefreshRunning = false;
let _dashboardRefreshLastAt = 0;

async function runDashboardRefresh() {
    if (_dashboardRefreshRunning) return;
    _dashboardRefreshRunning = true;
    try {
        await fetchOpenTickets();
        _dashboardRefreshLastAt = Date.now();
    } catch (e) {
        console.warn('Dashboard refresh silencioso falhou:', e.message);
    } finally {
        _dashboardRefreshRunning = false;
    }
}

function startDashboardRefreshLoop() {
    if (_dashboardRefreshIntervalId) return;
    _dashboardRefreshLastAt = Date.now();
    _dashboardRefreshIntervalId = setInterval(() => {
        if (document.hidden) return;
        runDashboardRefresh();
    }, DASHBOARD_REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _dashboardRefreshIntervalId && Date.now() - _dashboardRefreshLastAt >= DASHBOARD_REFRESH_MS) {
        runDashboardRefresh();
    }
});

function stopDashboardRefreshLoop() {
    if (_dashboardRefreshIntervalId) {
        clearInterval(_dashboardRefreshIntervalId);
        _dashboardRefreshIntervalId = null;
    }
}

// ============================================================
// COMPETÊNCIAS DE CURADORIA — Editor de configuração
// ============================================================

const DEFAULT_CURADORIA_CATEGORIES = [
    {
        key: 'comunicacao_clara', label: 'Comunicação clara', icon: 'forum',
        description: 'Clareza e cordialidade nas interações', isNegative: false,
        prompt: 'O atendente se comunicou de forma clara, objetiva e cordial? Avalie se as respostas são fáceis de entender, sem jargão excessivo, e se o tom foi respeitoso e profissional.'
    },
    {
        key: 'detalhamento', label: 'Detalhamento', icon: 'manage_search',
        description: 'Profundidade na análise e explicação', isNegative: false,
        prompt: 'O atendente detalhou adequadamente o problema e a solução? Avalie se houve explicação da causa raiz, descrição técnica suficiente e informações que ajudem o cliente a entender o que ocorreu.'
    },
    {
        key: 'fechamento', label: 'Fechamento', icon: 'task_alt',
        description: 'Conclusão adequada dos atendimentos', isNegative: false,
        prompt: 'O atendente encerrou o chamado de forma adequada? Avalie se houve confirmação com o cliente, resumo da solução aplicada e fechamento formal do ticket.'
    },
    {
        key: 'acompanhamento', label: 'Acompanhamento', icon: 'update',
        description: 'Follow-up e atualização de status', isNegative: false,
        prompt: 'O atendente realizou acompanhamento proativo? Avalie se houve retorno ao cliente sem ele precisar cobrar, atualizações de status e follow-up para verificar se o problema foi resolvido.'
    },
    {
        key: 'solucao_tecnica', label: 'Solução técnica', icon: 'build_circle',
        description: 'Resolução e ajustes técnicos', isNegative: false,
        prompt: 'O atendente demonstrou competência técnica na resolução? Avalie se a solução foi adequada ao problema, se houve análise técnica e se os ajustes realizados resolveram o issue.'
    },
    {
        key: 'transparencia', label: 'Transparência', icon: 'visibility',
        description: 'Reconhecimento de prazos e limitações', isNegative: false,
        prompt: 'O atendente foi transparente sobre prazos, limitações e o andamento do chamado? Avalie se ele reconheceu quando não sabia algo, informou prazos realistas e foi honesto sobre restrições.'
    },
    {
        key: 'dificuldade_resolucao', label: 'Dificuldade de resolução', icon: 'warning_amber',
        description: 'Ocorrências sem solução registrada', isNegative: true,
        prompt: 'O chamado ficou sem solução, com falta de retorno ou foi encerrado sem resolver o problema do cliente? Identifique se houve abandono, falta de follow-up ou encerramento indevido.'
    },
];

function _escCfg(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadCategoriesConfig() {
    const container = document.getElementById('cfgCategoriesList');
    if (!container) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-categories`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : {};
        const cats = (data.categories && data.categories.length) ? data.categories : DEFAULT_CURADORIA_CATEGORIES;
        renderCategoriesEditor(cats);
    } catch {
        renderCategoriesEditor(DEFAULT_CURADORIA_CATEGORIES);
    }
}

function renderCategoriesEditor(categories) {
    const container = document.getElementById('cfgCategoriesList');
    if (!container) return;
    container.innerHTML = categories.map((cat) => {
        const prompt = cat.prompt || '';
        const negBadge = cat.isNegative
            ? `<span class="cfg-cat-badge cfg-cat-badge-neg">⚠ Negativa</span>`
            : `<span class="cfg-cat-badge cfg-cat-badge-pos">✅ Positiva</span>`;
        return `
        <div class="cfg-category-row" data-icon="${_escCfg(cat.icon || 'star')}" data-key="${_escCfg(cat.key)}">
            <div class="cfg-cat-top">
                ${negBadge}
                <span class="cfg-cat-name-preview">${_escCfg(cat.label)}</span>
                <button class="config-btn config-btn-danger" onclick="cfgRemoveCategoryRow(this)" title="Remover esta competência">✕ Remover</button>
            </div>
            <div class="cfg-cat-fields">
                <div class="cfg-field-group">
                    <label class="cfg-field-label">Nome da competência</label>
                    <input class="config-input cfg-cat-label" type="text" placeholder="Ex: Comunicação clara" value="${_escCfg(cat.label)}" oninput="this.closest('.cfg-category-row').querySelector('.cfg-cat-name-preview').textContent=this.value">
                </div>
                <div class="cfg-field-group">
                    <label class="cfg-field-label">Descrição curta <span class="cfg-field-hint">(aparece no cartão da análise)</span></label>
                    <input class="config-input cfg-cat-desc" type="text" placeholder="Ex: Clareza e cordialidade nas interações" value="${_escCfg(cat.description)}">
                </div>
                <div class="cfg-field-group">
                    <label class="cfg-field-label">Prompt de avaliação <span class="cfg-field-hint">(instrução para a IA identificar esta competência nos chamados)</span></label>
                    <p class="cfg-help-text">💡 Descreva em linguagem natural o que a IA deve observar nos chamados para identificar esta competência. Seja específico sobre comportamentos e evidências esperados.</p>
                    <textarea class="config-input cfg-cat-prompt" rows="4" placeholder="Ex: O atendente se comunicou de forma clara e objetiva? Avalie se as respostas são fáceis de entender e o tom foi profissional.">${_escCfg(prompt)}</textarea>
                </div>
                <div class="cfg-field-group">
                    <label class="config-checkbox-label cfg-neg-toggle">
                        <input type="checkbox" class="cfg-cat-negative" ${cat.isNegative ? 'checked' : ''}
                            onchange="const b=this.closest('.cfg-category-row').querySelector('.cfg-cat-badge'); b.className='cfg-cat-badge '+(this.checked?'cfg-cat-badge-neg':'cfg-cat-badge-pos'); b.textContent=this.checked?'⚠ Negativa':'✅ Positiva';">
                        <div>
                            <strong>É uma competência negativa?</strong>
                            <p class="cfg-help-text" style="margin:0">Marque se esta competência representa um <strong>problema</strong> no atendimento (ex: falta de solução, demora). Deixe desmarcado para pontos positivos.</p>
                        </div>
                    </label>
                </div>
            </div>
        </div>`;
    }).join('');
}

function cfgAddCategoryRow() {
    const container = document.getElementById('cfgCategoriesList');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'cfg-category-row';
    div.dataset.icon = 'star';
    div.dataset.key = '';
    div.innerHTML = `
        <div class="cfg-cat-top">
            <span class="cfg-cat-badge cfg-cat-badge-pos">✅ Positiva</span>
            <span class="cfg-cat-name-preview" style="color:var(--text-secondary);font-style:italic">Nova competência</span>
            <button class="config-btn config-btn-danger" onclick="cfgRemoveCategoryRow(this)" title="Remover">✕ Remover</button>
        </div>
        <div class="cfg-cat-fields">
            <div class="cfg-field-group">
                <label class="cfg-field-label">Nome da competência</label>
                <input class="config-input cfg-cat-label" type="text" placeholder="Ex: Proatividade" value="" oninput="this.closest('.cfg-category-row').querySelector('.cfg-cat-name-preview').textContent=this.value||'Nova competência'">
            </div>
            <div class="cfg-field-group">
                <label class="cfg-field-label">Descrição curta <span class="cfg-field-hint">(aparece no cartão da análise)</span></label>
                <input class="config-input cfg-cat-desc" type="text" placeholder="Ex: Atitude proativa do atendente" value="">
            </div>
            <div class="cfg-field-group">
                <label class="cfg-field-label">Prompt de avaliação <span class="cfg-field-hint">(instrução para a IA identificar esta competência nos chamados)</span></label>
                <p class="cfg-help-text">💡 Descreva o que a IA deve observar para identificar esta competência. Seja específico sobre comportamentos e evidências esperados.</p>
                <textarea class="config-input cfg-cat-prompt" rows="4" placeholder="Ex: O atendente demonstrou proatividade? Identifique se ele antecipou problemas, tomou iniciativa sem esperar o cliente cobrar e sugeriu soluções além do solicitado."></textarea>
            </div>
            <div class="cfg-field-group">
                <label class="config-checkbox-label cfg-neg-toggle">
                    <input type="checkbox" class="cfg-cat-negative"
                        onchange="const b=this.closest('.cfg-category-row').querySelector('.cfg-cat-badge'); b.className='cfg-cat-badge '+(this.checked?'cfg-cat-badge-neg':'cfg-cat-badge-pos'); b.textContent=this.checked?'⚠ Negativa':'✅ Positiva';">
                    <div>
                        <strong>É uma competência negativa?</strong>
                        <p class="cfg-help-text" style="margin:0">Marque se esta competência representa um <strong>problema</strong> no atendimento. Deixe desmarcado para pontos positivos.</p>
                    </div>
                </label>
            </div>
        </div>`;
    container.appendChild(div);
    div.querySelector('.cfg-cat-label').focus();
}

function cfgRemoveCategoryRow(btn) {
    btn.closest('.cfg-category-row').remove();
}

function cfgReadCategoriesFromEditor() {
    const rows = document.querySelectorAll('#cfgCategoriesList .cfg-category-row');
    const categories = [];
    for (const row of rows) {
        const label = row.querySelector('.cfg-cat-label')?.value?.trim();
        const prompt = row.querySelector('.cfg-cat-prompt')?.value?.trim() || '';
        if (!label || !prompt) continue;
        const description = row.querySelector('.cfg-cat-desc')?.value?.trim() || '';
        const isNegative  = row.querySelector('.cfg-cat-negative')?.checked || false;
        const icon = row.dataset.icon || (isNegative ? 'warning_amber' : 'check_circle');
        const key = label.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        categories.push({ key, label, prompt, icon, description, isNegative });
    }
    return categories;
}

async function saveCategoriesConfig() {
    const categories = cfgReadCategoriesFromEditor();
    if (categories.length === 0) {
        setCfgStatus('cfgCategoriesStatus', 'Adicione pelo menos uma competência com nome e prompt antes de salvar.', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-categories`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ categories })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar');
        setCfgStatus('cfgCategoriesStatus', `✅ ${categories.length} competência(s) salvas com sucesso.`, 'ok');
    } catch (e) {
        setCfgStatus('cfgCategoriesStatus', `Erro ao salvar: ${e.message}`, 'error');
    }
}

function resetCategoriesConfig() {
    renderCategoriesEditor(DEFAULT_CURADORIA_CATEGORIES);
    setCfgStatus('cfgCategoriesStatus', 'Padrão restaurado. Clique em "Salvar competências" para confirmar.', 'ok');
}

/* ── Pesos do score de performance (0-1000) — 4 dimensões configuráveis ──── */
const DEFAULT_SCORE_WEIGHTS_CFG = { satisfacao: 0.35, eficiencia: 0.25, pontos: 0.25, competencias: 0.15 };

function _cfgWeightInputs() {
    return {
        satisfacao: document.getElementById('cfgWeightSatisfacao'),
        eficiencia: document.getElementById('cfgWeightEficiencia'),
        pontos: document.getElementById('cfgWeightPontos'),
        competencias: document.getElementById('cfgWeightCompetencias')
    };
}

function renderScoreWeightsEditor(weights) {
    const inputs = _cfgWeightInputs();
    if (!inputs.satisfacao) return;
    inputs.satisfacao.value = Math.round(weights.satisfacao * 100);
    inputs.eficiencia.value = Math.round(weights.eficiencia * 100);
    inputs.pontos.value = Math.round(weights.pontos * 100);
    inputs.competencias.value = Math.round(weights.competencias * 100);
    updateScoreWeightSum();
}

function updateScoreWeightSum() {
    const inputs = _cfgWeightInputs();
    const sumEl = document.getElementById('cfgWeightSum');
    if (!inputs.satisfacao || !sumEl) return;
    const sum = ['satisfacao', 'eficiencia', 'pontos', 'competencias']
        .reduce((s, k) => s + (Number(inputs[k].value) || 0), 0);
    sumEl.textContent = `${sum}%`;
    sumEl.className = sum === 100 ? 'config-token-status config-token-status-on' : 'config-token-status config-token-status-off';
}

async function loadScoreWeightsConfig() {
    try {
        const response = await fetch(`${API_BASE}/config/score-weights`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : {};
        renderScoreWeightsEditor(data.weights || DEFAULT_SCORE_WEIGHTS_CFG);
    } catch {
        renderScoreWeightsEditor(DEFAULT_SCORE_WEIGHTS_CFG);
    }
}

async function saveScoreWeights() {
    const inputs = _cfgWeightInputs();
    const weights = {
        satisfacao: (Number(inputs.satisfacao.value) || 0) / 100,
        eficiencia: (Number(inputs.eficiencia.value) || 0) / 100,
        pontos: (Number(inputs.pontos.value) || 0) / 100,
        competencias: (Number(inputs.competencias.value) || 0) / 100
    };
    const sum = Math.round((weights.satisfacao + weights.eficiencia + weights.pontos + weights.competencias) * 100);
    if (sum !== 100) {
        setCfgStatus('cfgScoreWeightsStatus', `A soma dos pesos precisa ser 100% (atual: ${sum}%).`, 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/config/score-weights`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ weights })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar');
        setCfgStatus('cfgScoreWeightsStatus', '✅ Pesos salvos com sucesso.', 'ok');
    } catch (e) {
        setCfgStatus('cfgScoreWeightsStatus', `Erro ao salvar: ${e.message}`, 'error');
    }
}

function resetScoreWeights() {
    renderScoreWeightsEditor(DEFAULT_SCORE_WEIGHTS_CFG);
    setCfgStatus('cfgScoreWeightsStatus', 'Padrão restaurado. Clique em "Salvar pesos" para confirmar.', 'ok');
}

// ============================================================
// CURADORIA AVANÇADO — prompt de análise, prompts client-side,
// queries SQL e parâmetros das requisições Movidesk (100% configurável, sem editar código)
// ============================================================

const DEFAULT_CURADORIA_PROMPT_ANALISE_TEMPLATE = `Voce e um analista senior de suporte critico que analisa tickets de suporte em JSON.

REGRAS ABSOLUTAS:
- Ignore acoes com type = 1 (acoes internas de escalonamento/atribuicao)
- Ignore acoes onde createdBy.id = "007" (acoes de sistema)
- Suporte = createdBy com email contendo @viasoft.com.br OU createdBy.businessName === owner.businessName (quando businessName nao for vazio)
- Cliente = usuario solicitante do chamado {{solicitante}}
- Fato relatado = {{fato}}
- Causa identificada = {{causa}}
- Modulo X Rotina = {{moduloXRotina}}
- Owner do ticket = {{owner}}
- Aberto em = {{abertoEm}}
- Resolvido em = {{resolvidoEm}}
- Responda APENAS com um JSON valido, sem markdown, sem texto adicional, sem crases, sem \`\`\`json
- Preencha TODOS os campos com dados reais do JSON do ticket
- Nunca use dados ficticios
- Use SEMPRE os nomes e e-mails reais presentes no JSON fornecido

CAMPOS PRE-CALCULADOS:
  - aberto_em = {{abertoEm}}
  - sla_inicio_em = {{slaInicioEm}}
  - resolvido_em = {{resolvidoEm}}
  - tempo_resolucao_min_uteis = {{tempoResolucaoMinUteis}}
  - tempo_resolucao_horas_uteis = {{tempoResolucaoHorasUteis}}
  - tempo_resolucao_dias_uteis = {{tempoResolucaoDiasUteis}}
  - tempo_resolucao_legivel = {{tempoResolucaoLegivel}}
  - abertura_fora_expediente = {{aberturaForaExpediente}}`;

async function loadCuradoriaPromptAnalise() {
    if (!isCurrentUserAdmin()) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-analise`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : {};
        document.getElementById('cfgCuradoriaPromptAnalise').value = data.template || DEFAULT_CURADORIA_PROMPT_ANALISE_TEMPLATE;
        document.getElementById('cfgCuradoriaPromptModel').value = data.model || 'gpt-4.1-mini';
        document.getElementById('cfgCuradoriaPromptTemp').value = data.temperature ?? 0;
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptAnaliseStatus', `Erro ao carregar prompt: ${error.message}`, 'error');
    }
}

async function saveCuradoriaPromptAnalise() {
    const template = document.getElementById('cfgCuradoriaPromptAnalise')?.value?.trim();
    const model = document.getElementById('cfgCuradoriaPromptModel')?.value?.trim();
    const temperature = document.getElementById('cfgCuradoriaPromptTemp')?.value;
    if (!template) {
        setCfgStatus('cfgCuradoriaPromptAnaliseStatus', 'Informe o prompt antes de salvar.', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-analise`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ template, model, temperature })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar prompt');
        setCfgStatus('cfgCuradoriaPromptAnaliseStatus', 'Prompt salvo com sucesso.', 'ok');
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptAnaliseStatus', `Erro ao salvar prompt: ${error.message}`, 'error');
    }
}

function resetCuradoriaPromptAnaliseToDefault() {
    document.getElementById('cfgCuradoriaPromptAnalise').value = DEFAULT_CURADORIA_PROMPT_ANALISE_TEMPLATE;
    document.getElementById('cfgCuradoriaPromptModel').value = 'gpt-4.1-mini';
    document.getElementById('cfgCuradoriaPromptTemp').value = 0;
    setCfgStatus('cfgCuradoriaPromptAnaliseStatus', 'Padrão restaurado. Clique em "Salvar prompt" para confirmar.', 'ok');
}

async function testCuradoriaPromptAnalise() {
    const btn = document.getElementById('cfgTestCuradoriaPromptAnalise');
    const resultEl = document.getElementById('cfgCuradoriaPromptTestResult');
    const ticketId = document.getElementById('cfgCuradoriaPromptTestTicket')?.value;
    const template = document.getElementById('cfgCuradoriaPromptAnalise')?.value?.trim();
    const model = document.getElementById('cfgCuradoriaPromptModel')?.value?.trim();
    const temperature = document.getElementById('cfgCuradoriaPromptTemp')?.value;

    if (!ticketId) { setCfgStatus('cfgCuradoriaPromptAnaliseStatus', 'Informe um ticket_id para testar.', 'error'); return; }
    if (!template) { setCfgStatus('cfgCuradoriaPromptAnaliseStatus', 'Informe o prompt antes de testar.', 'error'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Testando...'; }
    if (resultEl) { resultEl.style.display = 'block'; resultEl.textContent = 'Chamando a IA...'; }

    try {
        const response = await fetch(`${API_BASE}/curadoria/prompt-analise/test`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticketId, template, model, temperature })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao testar prompt');
        const errorsBlock = data.errors?.length ? `\n\n⚠️ Erros de validação:\n${data.errors.join('\n')}` : '';
        if (resultEl) resultEl.textContent = JSON.stringify(data.raw, null, 2) + errorsBlock;
    } catch (error) {
        if (resultEl) resultEl.textContent = `Erro: ${error.message}`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Testar com este chamado'; }
    }
}

const DEFAULT_CURADORIA_PROMPT_COMPETENCIAS_TEXT = 'Avaliador de suporte. Para cada chamado listado, identifique quais das competências fornecidas realmente se manifestam no atendimento e atribua um percentual de 0 a 100 indicando a intensidade da evidência. Inclua no JSON apenas as competências que efetivamente se aplicam a cada chamado (omita as que não se aplicam ou têm percentual 0). Use EXATAMENTE as chaves fornecidas em COMPETÊNCIAS, sem alterar acentos ou maiúsculas. Retorne SOMENTE JSON: {"results":{"TICKET_ID":{"CHAVE":percentual}}}. Sem texto adicional.';

async function loadCuradoriaPromptCompetencias() {
    if (!isCurrentUserAdmin()) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-competencias`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : {};
        document.getElementById('cfgCuradoriaPromptCompetencias').value = data.prompt || DEFAULT_CURADORIA_PROMPT_COMPETENCIAS_TEXT;
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptCompetenciasStatus', `Erro ao carregar prompt: ${error.message}`, 'error');
    }
}

async function saveCuradoriaPromptCompetencias() {
    const prompt = document.getElementById('cfgCuradoriaPromptCompetencias')?.value?.trim();
    if (!prompt || prompt.length < 10) {
        setCfgStatus('cfgCuradoriaPromptCompetenciasStatus', 'Prompt muito curto: descreva melhor o critério de classificação.', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-competencias`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar prompt');
        setCfgStatus('cfgCuradoriaPromptCompetenciasStatus', 'Prompt salvo com sucesso.', 'ok');
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptCompetenciasStatus', `Erro ao salvar prompt: ${error.message}`, 'error');
    }
}

function resetCuradoriaPromptCompetenciasToDefault() {
    document.getElementById('cfgCuradoriaPromptCompetencias').value = DEFAULT_CURADORIA_PROMPT_COMPETENCIAS_TEXT;
    setCfgStatus('cfgCuradoriaPromptCompetenciasStatus', 'Padrão restaurado. Clique em "Salvar prompt" para confirmar.', 'ok');
}

const DEFAULT_CURADORIA_PROMPT_NARR_SYSTEM = `Você é um analista de operações de suporte. Escreva uma análise curta e objetiva da equipe, em português, EXATAMENTE nesta estrutura (um parágrafo curto por tópico, sem markdown, sem listas, sem títulos extras):

Produtividade: (texto)
Eficiência: (texto)
Feedback: (texto)
Área de melhoria: (texto)

REGRAS:
- Use APENAS os números e nomes fornecidos pelo usuário. Não invente, não estime, não arredonde diferente do fornecido.
- Cite pessoas pelo primeiro nome.
- Seja direto, sem introduções ou conclusões genéricas.`;

const DEFAULT_CURADORIA_PROMPT_NARR_USER = `DADOS DA EQUIPE:
- Total de atendentes: {{totalAtendentes}}
- Total de chamados no período: {{totalChamados}}
- % de chamados avaliados pelo cliente (feedback): {{feedbackRateEquipe}}%
- Cumprimento de SLA da equipe (SLA SUPORTE MOVIDESK.pdf): {{slaEquipe}}%

TOP EM VOLUME DE CHAMADOS: {{topProdutividade}}

TOP EM CUMPRIMENTO DE SLA: {{topSla}}

MENOR TAXA DE FEEDBACK: {{menosFeedback}}

MENOR SCORE (podem precisar de apoio): {{precisamApoio}}`;

async function loadCuradoriaPromptNarrativa() {
    if (!isCurrentUserAdmin()) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-narrativa`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : {};
        document.getElementById('cfgCuradoriaPromptNarrSystem').value = data.system || DEFAULT_CURADORIA_PROMPT_NARR_SYSTEM;
        document.getElementById('cfgCuradoriaPromptNarrUser').value = data.userTemplate || DEFAULT_CURADORIA_PROMPT_NARR_USER;
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptNarrativaStatus', `Erro ao carregar prompt: ${error.message}`, 'error');
    }
}

async function saveCuradoriaPromptNarrativa() {
    const system = document.getElementById('cfgCuradoriaPromptNarrSystem')?.value?.trim();
    const userTemplate = document.getElementById('cfgCuradoriaPromptNarrUser')?.value?.trim();
    if (!system || !userTemplate) {
        setCfgStatus('cfgCuradoriaPromptNarrativaStatus', 'Preencha os dois campos antes de salvar.', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-narrativa`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ system, userTemplate })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar prompt');
        setCfgStatus('cfgCuradoriaPromptNarrativaStatus', 'Prompt salvo com sucesso.', 'ok');
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptNarrativaStatus', `Erro ao salvar prompt: ${error.message}`, 'error');
    }
}

function resetCuradoriaPromptNarrativaToDefault() {
    document.getElementById('cfgCuradoriaPromptNarrSystem').value = DEFAULT_CURADORIA_PROMPT_NARR_SYSTEM;
    document.getElementById('cfgCuradoriaPromptNarrUser').value = DEFAULT_CURADORIA_PROMPT_NARR_USER;
    setCfgStatus('cfgCuradoriaPromptNarrativaStatus', 'Padrão restaurado. Clique em "Salvar prompt" para confirmar.', 'ok');
}

const DEFAULT_CURADORIA_QUERY_CONFIG = {
    listagem: { mode: 'guided', guided: { limit: 2000, orderDir: 'DESC', includeSatisfacaoSemProcessar: true }, rawWhere: '' },
    pendentes: { mode: 'guided', guided: { processadoValue: 0, orderDir: 'ASC' }, rawWhere: '' }
};

function renderCuradoriaQueryConfig(config) {
    const l = config.listagem, p = config.pendentes;
    document.getElementById('cfgQueryListagemLimit').value = l.guided.limit;
    document.getElementById('cfgQueryListagemOrderDir').value = l.guided.orderDir;
    document.getElementById('cfgQueryListagemIncludeSatisfacao').checked = !!l.guided.includeSatisfacaoSemProcessar;
    document.getElementById('cfgQueryListagemRawToggle').checked = l.mode === 'raw';
    document.getElementById('cfgQueryListagemRaw').value = l.rawWhere || '';
    document.getElementById('cfgQueryListagemRawWrap').style.display = l.mode === 'raw' ? 'block' : 'none';

    document.getElementById('cfgQueryPendentesProcessado').value = p.guided.processadoValue;
    document.getElementById('cfgQueryPendentesOrderDir').value = p.guided.orderDir;
    document.getElementById('cfgQueryPendentesRawToggle').checked = p.mode === 'raw';
    document.getElementById('cfgQueryPendentesRaw').value = p.rawWhere || '';
    document.getElementById('cfgQueryPendentesRawWrap').style.display = p.mode === 'raw' ? 'block' : 'none';
}

async function loadCuradoriaQueryConfig() {
    if (!isCurrentUserAdmin()) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-query-config`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : DEFAULT_CURADORIA_QUERY_CONFIG;
        renderCuradoriaQueryConfig(data);
    } catch (error) {
        renderCuradoriaQueryConfig(DEFAULT_CURADORIA_QUERY_CONFIG);
        setCfgStatus('cfgQueryListagemStatus', `Erro ao carregar consulta: ${error.message}`, 'error');
    }
}

function toggleCuradoriaRawWhere(which) {
    const toggle = document.getElementById(which === 'listagem' ? 'cfgQueryListagemRawToggle' : 'cfgQueryPendentesRawToggle');
    const wrap = document.getElementById(which === 'listagem' ? 'cfgQueryListagemRawWrap' : 'cfgQueryPendentesRawWrap');
    if (wrap) wrap.style.display = toggle?.checked ? 'block' : 'none';
}

// As duas consultas (listagem e fila de pendentes) ficam gravadas juntas numa única chave de
// config — por isso os dois botões "Salvar consulta" chamam esta mesma função, enviando o
// estado atual de ambos os cards de uma vez (evita que salvar um sobrescreva o outro com o padrão).
async function saveCuradoriaQueryConfig() {
    const listagem = {
        mode: document.getElementById('cfgQueryListagemRawToggle')?.checked ? 'raw' : 'guided',
        guided: {
            limit: parseInt(document.getElementById('cfgQueryListagemLimit')?.value, 10) || 2000,
            orderDir: document.getElementById('cfgQueryListagemOrderDir')?.value || 'DESC',
            includeSatisfacaoSemProcessar: !!document.getElementById('cfgQueryListagemIncludeSatisfacao')?.checked
        },
        rawWhere: document.getElementById('cfgQueryListagemRaw')?.value?.trim() || ''
    };
    const pendentes = {
        mode: document.getElementById('cfgQueryPendentesRawToggle')?.checked ? 'raw' : 'guided',
        guided: {
            processadoValue: Number(document.getElementById('cfgQueryPendentesProcessado')?.value) || 0,
            orderDir: document.getElementById('cfgQueryPendentesOrderDir')?.value || 'ASC'
        },
        rawWhere: document.getElementById('cfgQueryPendentesRaw')?.value?.trim() || ''
    };

    try {
        const response = await fetch(`${API_BASE}/config/curadoria-query-config`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ listagem, pendentes })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar consulta');
        setCfgStatus('cfgQueryListagemStatus', 'Consultas salvas com sucesso.', 'ok');
        setCfgStatus('cfgQueryPendentesStatus', 'Consultas salvas com sucesso.', 'ok');
    } catch (error) {
        setCfgStatus('cfgQueryListagemStatus', `Erro ao salvar: ${error.message}`, 'error');
        setCfgStatus('cfgQueryPendentesStatus', `Erro ao salvar: ${error.message}`, 'error');
    }
}

function resetCuradoriaQueryListagem() {
    document.getElementById('cfgQueryListagemLimit').value = DEFAULT_CURADORIA_QUERY_CONFIG.listagem.guided.limit;
    document.getElementById('cfgQueryListagemOrderDir').value = DEFAULT_CURADORIA_QUERY_CONFIG.listagem.guided.orderDir;
    document.getElementById('cfgQueryListagemIncludeSatisfacao').checked = true;
    document.getElementById('cfgQueryListagemRawToggle').checked = false;
    document.getElementById('cfgQueryListagemRaw').value = '';
    document.getElementById('cfgQueryListagemRawWrap').style.display = 'none';
    setCfgStatus('cfgQueryListagemStatus', 'Padrão restaurado. Clique em "Salvar consulta" para confirmar.', 'ok');
}

function resetCuradoriaQueryPendentes() {
    document.getElementById('cfgQueryPendentesProcessado').value = DEFAULT_CURADORIA_QUERY_CONFIG.pendentes.guided.processadoValue;
    document.getElementById('cfgQueryPendentesOrderDir').value = DEFAULT_CURADORIA_QUERY_CONFIG.pendentes.guided.orderDir;
    document.getElementById('cfgQueryPendentesRawToggle').checked = false;
    document.getElementById('cfgQueryPendentesRaw').value = '';
    document.getElementById('cfgQueryPendentesRawWrap').style.display = 'none';
    setCfgStatus('cfgQueryPendentesStatus', 'Padrão restaurado. Clique em "Salvar consulta" para confirmar.', 'ok');
}

const DEFAULT_CURADORIA_MOVIDESK_CONFIG = {
    satisfacao: { selectFields: 'id,satisfactionSurveyResponses' },
    moduloRotina: { customFieldId: 59786, selectFields: 'id,customFieldValues' },
    rateLimitMs: 6500,
    fullLoadTimes: ['08:00', '12:00', '19:00']
};
let _cfgFullLoadTimes = [];

function renderFullLoadTimesList() {
    const wrap = document.getElementById('cfgFullLoadTimesList');
    if (!wrap) return;
    wrap.innerHTML = _cfgFullLoadTimes.length
        ? _cfgFullLoadTimes.map(t => `
            <span class="config-token-status config-token-status-on" style="display:inline-flex; align-items:center; gap:6px;">
                ${t}
                <button type="button" onclick="removeCuradoriaFullLoadTime('${t}')" style="background:none;border:none;color:inherit;cursor:pointer;font-weight:bold;">×</button>
            </span>`).join('')
        : '<span style="font-size:12px; color:#888;">Nenhum horário configurado</span>';
}

function addCuradoriaFullLoadTime() {
    const input = document.getElementById('cfgFullLoadTimeAdd');
    const value = input?.value;
    if (!value) return;
    if (!_cfgFullLoadTimes.includes(value)) {
        _cfgFullLoadTimes.push(value);
        _cfgFullLoadTimes.sort();
        renderFullLoadTimesList();
    }
    input.value = '';
}

function removeCuradoriaFullLoadTime(time) {
    _cfgFullLoadTimes = _cfgFullLoadTimes.filter(t => t !== time);
    renderFullLoadTimesList();
}

async function loadCuradoriaMovideskConfig() {
    if (!isCurrentUserAdmin()) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-movidesk-config`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : DEFAULT_CURADORIA_MOVIDESK_CONFIG;
        document.getElementById('cfgMovideskSatisfacaoSelect').value = data.satisfacao?.selectFields || DEFAULT_CURADORIA_MOVIDESK_CONFIG.satisfacao.selectFields;
        document.getElementById('cfgMovideskModuloCustomFieldId').value = data.moduloRotina?.customFieldId || DEFAULT_CURADORIA_MOVIDESK_CONFIG.moduloRotina.customFieldId;
        document.getElementById('cfgMovideskModuloSelect').value = data.moduloRotina?.selectFields || DEFAULT_CURADORIA_MOVIDESK_CONFIG.moduloRotina.selectFields;
        document.getElementById('cfgMovideskRateLimitMs').value = data.rateLimitMs || DEFAULT_CURADORIA_MOVIDESK_CONFIG.rateLimitMs;
        _cfgFullLoadTimes = Array.isArray(data.fullLoadTimes) && data.fullLoadTimes.length ? [...data.fullLoadTimes] : [...DEFAULT_CURADORIA_MOVIDESK_CONFIG.fullLoadTimes];
        renderFullLoadTimesList();
    } catch (error) {
        setCfgStatus('cfgMovideskCuradoriaConfigStatus', `Erro ao carregar configuração: ${error.message}`, 'error');
    }
}

async function saveCuradoriaMovideskConfig() {
    const satisfacao = { selectFields: document.getElementById('cfgMovideskSatisfacaoSelect')?.value?.trim() };
    const moduloRotina = {
        customFieldId: parseInt(document.getElementById('cfgMovideskModuloCustomFieldId')?.value, 10),
        selectFields: document.getElementById('cfgMovideskModuloSelect')?.value?.trim()
    };
    const rateLimitMs = parseInt(document.getElementById('cfgMovideskRateLimitMs')?.value, 10);

    if (!_cfgFullLoadTimes.length) {
        setCfgStatus('cfgMovideskCuradoriaConfigStatus', 'Informe ao menos um horário para a carga agendada.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/curadoria-movidesk-config`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ satisfacao, moduloRotina, rateLimitMs, fullLoadTimes: _cfgFullLoadTimes })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar configuração');
        setCfgStatus('cfgMovideskCuradoriaConfigStatus', 'Configuração salva com sucesso.', 'ok');
    } catch (error) {
        setCfgStatus('cfgMovideskCuradoriaConfigStatus', `Erro ao salvar: ${error.message}`, 'error');
    }
}

function resetCuradoriaMovideskConfigToDefault() {
    document.getElementById('cfgMovideskSatisfacaoSelect').value = DEFAULT_CURADORIA_MOVIDESK_CONFIG.satisfacao.selectFields;
    document.getElementById('cfgMovideskModuloCustomFieldId').value = DEFAULT_CURADORIA_MOVIDESK_CONFIG.moduloRotina.customFieldId;
    document.getElementById('cfgMovideskModuloSelect').value = DEFAULT_CURADORIA_MOVIDESK_CONFIG.moduloRotina.selectFields;
    document.getElementById('cfgMovideskRateLimitMs').value = DEFAULT_CURADORIA_MOVIDESK_CONFIG.rateLimitMs;
    _cfgFullLoadTimes = [...DEFAULT_CURADORIA_MOVIDESK_CONFIG.fullLoadTimes];
    renderFullLoadTimesList();
    setCfgStatus('cfgMovideskCuradoriaConfigStatus', 'Padrão restaurado. Clique em "Salvar" para confirmar.', 'ok');
}

const DEFAULT_CURADORIA_SLA_THRESHOLDS = { critica: 4, alta: 8, media: 16, baixa: 24 };

async function loadCuradoriaSlaThresholds() {
    if (!isCurrentUserAdmin()) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-sla-thresholds`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : DEFAULT_CURADORIA_SLA_THRESHOLDS;
        document.getElementById('cfgSlaCritica').value = data.critica ?? DEFAULT_CURADORIA_SLA_THRESHOLDS.critica;
        document.getElementById('cfgSlaAlta').value = data.alta ?? DEFAULT_CURADORIA_SLA_THRESHOLDS.alta;
        document.getElementById('cfgSlaMedia').value = data.media ?? DEFAULT_CURADORIA_SLA_THRESHOLDS.media;
        document.getElementById('cfgSlaBaixa').value = data.baixa ?? DEFAULT_CURADORIA_SLA_THRESHOLDS.baixa;
    } catch (error) {
        setCfgStatus('cfgSlaThresholdsStatus', `Erro ao carregar prazos de SLA: ${error.message}`, 'error');
    }
}

async function saveSlaThresholds() {
    const critica = Number(document.getElementById('cfgSlaCritica')?.value);
    const alta = Number(document.getElementById('cfgSlaAlta')?.value);
    const media = Number(document.getElementById('cfgSlaMedia')?.value);
    const baixa = Number(document.getElementById('cfgSlaBaixa')?.value);

    for (const [label, v] of [['Crítica', critica], ['Alta', alta], ['Média', media], ['Baixa', baixa]]) {
        if (!Number.isFinite(v) || v <= 0) {
            setCfgStatus('cfgSlaThresholdsStatus', `Informe um prazo válido (maior que 0) para "${label}".`, 'error');
            return;
        }
    }

    try {
        const response = await fetch(`${API_BASE}/config/curadoria-sla-thresholds`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ critica, alta, media, baixa })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar prazos de SLA');
        setCfgStatus('cfgSlaThresholdsStatus', 'Prazos de SLA salvos com sucesso.', 'ok');
    } catch (error) {
        setCfgStatus('cfgSlaThresholdsStatus', `Erro ao salvar prazos de SLA: ${error.message}`, 'error');
    }
}

function resetSlaThresholdsToDefault() {
    document.getElementById('cfgSlaCritica').value = DEFAULT_CURADORIA_SLA_THRESHOLDS.critica;
    document.getElementById('cfgSlaAlta').value = DEFAULT_CURADORIA_SLA_THRESHOLDS.alta;
    document.getElementById('cfgSlaMedia').value = DEFAULT_CURADORIA_SLA_THRESHOLDS.media;
    document.getElementById('cfgSlaBaixa').value = DEFAULT_CURADORIA_SLA_THRESHOLDS.baixa;
    setCfgStatus('cfgSlaThresholdsStatus', 'Padrão restaurado. Clique em "Salvar prazos" para confirmar.', 'ok');
}

const DEFAULT_CURADORIA_PROMPT_SLA_ESTOURO_TEXT = `CRITERIO DE ATRIBUICAO DE ESTOURO DE SLA:
- Prazo de resolucao esperado para a urgencia deste chamado = {{slaResolucaoHoras}} horas uteis
- Tempo real de resolucao (ja calculado) = {{tempoResolucaoHorasUteis}} horas uteis
- Se o tempo real for menor ou igual ao prazo esperado, responsavel = "nao_estourou"
- Se o tempo real for maior que o prazo esperado, analise a tabela de acoes em ordem cronologica (autor, tipo e data) para decidir quem causou o atraso:
  - "cliente": o suporte respondeu, sinalizou solucao ou pediu uma confirmacao/informacao, e o cliente demorou a responder ou confirmar, sendo essa demora do cliente o principal motivo do estouro
  - "suporte": o atraso decorreu de demora do proprio suporte em responder, investigar, agir ou dar sequencia
  - "indisponivel": nao ha acoes ou dados suficientes para decidir com confianca
- Preencha justificativa em ate 2 frases e liste de 1 a 3 evidencias reais (id da acao, autor e data) que sustentam a decisao`;

async function loadCuradoriaPromptSlaEstouro() {
    if (!isCurrentUserAdmin()) return;
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-sla-estouro`, { headers: authHeaders() });
        const data = response.ok ? await response.json() : {};
        document.getElementById('cfgCuradoriaPromptSlaEstouro').value = data.prompt || DEFAULT_CURADORIA_PROMPT_SLA_ESTOURO_TEXT;
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptSlaEstouroStatus', `Erro ao carregar prompt: ${error.message}`, 'error');
    }
}

async function saveCuradoriaPromptSlaEstouro() {
    const prompt = document.getElementById('cfgCuradoriaPromptSlaEstouro')?.value?.trim();
    if (!prompt || prompt.length < 10) {
        setCfgStatus('cfgCuradoriaPromptSlaEstouroStatus', 'Prompt muito curto: descreva melhor o critério de atribuição.', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/config/curadoria-prompt-sla-estouro`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar prompt');
        setCfgStatus('cfgCuradoriaPromptSlaEstouroStatus', 'Prompt salvo com sucesso.', 'ok');
    } catch (error) {
        setCfgStatus('cfgCuradoriaPromptSlaEstouroStatus', `Erro ao salvar prompt: ${error.message}`, 'error');
    }
}

function resetCuradoriaPromptSlaEstouroToDefault() {
    document.getElementById('cfgCuradoriaPromptSlaEstouro').value = DEFAULT_CURADORIA_PROMPT_SLA_ESTOURO_TEXT;
    setCfgStatus('cfgCuradoriaPromptSlaEstouroStatus', 'Padrão restaurado. Clique em "Salvar prompt" para confirmar.', 'ok');
}

function loadCuradoriaAvancadoTab() {
    loadCuradoriaPromptAnalise();
    loadCuradoriaPromptCompetencias();
    loadCuradoriaPromptNarrativa();
    loadCuradoriaQueryConfig();
    loadCuradoriaMovideskConfig();
    loadCuradoriaSlaThresholds();
    loadCuradoriaPromptSlaEstouro();
}

function switchConfigTab(tab) {
    document.querySelectorAll('.cfg-tab-panel').forEach(p => p.classList.add('cfg-tab-hidden'));
    document.querySelectorAll('.cfg-tab-btn').forEach(b => b.classList.remove('cfg-tab-active'));
    document.getElementById(`cfgTab-${tab}`)?.classList.remove('cfg-tab-hidden');
    document.querySelector(`.cfg-tab-btn[data-tab="${tab}"]`)?.classList.add('cfg-tab-active');
    // Volta o scroll para o topo ao trocar de aba
    document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
    // Carregar consumo de IA ao abrir aba IA
    if (tab === 'ia') loadAiUsage();
    if (tab === 'ia-assist') { aiaInit(); loadAiAssistTab(); }
    if (tab === 'curadoria') { if (typeof loadPipeAnoCount === 'function') loadPipeAnoCount(); loadCuradoriaPendingCount(); checkSurveySyncOnLoad(); checkModuloSyncOnLoad(); loadScoreWeightsConfig(); checkFullLoadOnLoad(); loadSlaEstouroCount(); loadEnrichCount(); loadEnrichStatus(); }
    if (tab === 'curadoria-avancado') loadCuradoriaAvancadoTab();
    if (tab === 'acesso') { if (typeof pessoasLoad === 'function') pessoasLoad(); loadTabPermissionsConfig(); loadVerticalAliases(); }
    if (tab === 'avisos' && typeof avisosCarregar === 'function') avisosCarregar();
    if (tab === 'telemetria') loadTelemetria();
    if (tab === 'datalake') {
        // garante que os botões nunca fiquem travados ao abrir a aba
        const btnFull   = document.getElementById('dlBtnFull');
        const btnInc    = document.getElementById('dlBtnInc');
        const btnCancel = document.getElementById('dlBtnCancel');
        if (btnFull)   { btnFull.disabled = false; btnFull.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">download_for_offline</span> Full agora'; }
        if (btnInc)    { btnInc.disabled  = false; btnInc.innerHTML  = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">update</span> Incremental agora'; }
        if (btnCancel) { btnCancel.style.display = 'none'; btnCancel.disabled = false; }
        dlLoad();
        dlSatLoad();
        cronLoad();
    }
}

// ─── Acesso: quais abas cada perfil vê no menu ─────────────────────────────
const CFG_ACCESS_DEFAULTS = { supervisor: ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk', 'satisfacao', 'paineltv', 'incidentes', 'reincidencias'], atendente: ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk', 'satisfacao', 'paineltv', 'incidentes', 'reincidencias'], guest: ['dashboard'] };
const CFG_TAB_LABELS = { dashboard: 'Dashboard', chamados: 'Curadoria', ouvidoria: 'Ouvidoria', gcc: 'GCC', jira: 'Jira', movidesk: 'Movidesk (Painel Geral)', satisfacao: 'Satisfação', paineltv: 'Painel TV', incidentes: 'Incidentes', reincidencias: 'Reincidências' };
let cfgAccessPermissions = {};
let cfgAccessRoles = [];

function cfgEsc(value) { return String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }
function cfgRoleLabel(role) { return ({ supervisor: 'Supervisor', atendente: 'Atendente', guest: 'Sem perfil (guest)' })[role] || role.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

function renderProfilesConfig() {
    const container = document.getElementById('cfgProfilesList');
    if (!container) return;
    container.innerHTML = cfgAccessRoles.filter(r => r.name !== 'admin').map(role => {
        const allowed = cfgAccessPermissions[role.name] || [];
        const locked = ['supervisor', 'atendente', 'guest'].includes(role.name);
        const canDelete = !locked && Number.isFinite(Number(role.id));
        const SUB_MOVIDESK = ['satisfacao', 'paineltv'];   // sub-abas da aba Movidesk
        const caixa = ([key, label], desab) => `<label class="config-checkbox-label"><input type="checkbox" class="cfg-access-checkbox" data-role="${cfgEsc(role.name)}" data-key="${key}" value="${key}" ${allowed.includes(key) ? 'checked' : ''} ${desab ? 'disabled' : ''}> ${label}</label>`;
        const semMov = !allowed.includes('movidesk');
        const checks = Object.entries(CFG_TAB_LABELS).filter(([k]) => !SUB_MOVIDESK.includes(k)).map((e) => caixa(e, false)).join('') +
            `<div style="flex-basis:100%;margin-top:4px;padding:8px 12px;border:1px dashed #cbd5e1;border-radius:10px;"><div style="font-size:12px;opacity:.75;margin-bottom:4px;">Sub-abas dentro de “Movidesk” (só valem se “Movidesk” estiver marcado)</div><div style="display:flex;flex-wrap:wrap;gap:14px;" data-subabas="${cfgEsc(role.name)}">${SUB_MOVIDESK.map((k) => caixa([k, CFG_TAB_LABELS[k]], semMov)).join('')}</div></div>`;
        return `<div class="config-form-stack" style="margin:0 0 18px;padding-bottom:18px;border-bottom:1px solid #e5e7eb;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><label class="config-form-label" style="margin:0;"><strong>${cfgEsc(cfgRoleLabel(role.name))}</strong></label>${role.description ? `<span style="font-size:12px;color:#666;">${cfgEsc(role.description)}</span>` : ''}${canDelete ? `<button type="button" class="config-btn config-btn-danger" style="margin-left:auto;" onclick="deleteProfileConfig(${Number(role.id)})">Remover</button>` : ''}</div>
            <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;">${checks}</div>
        </div>`;
    }).join('') || '<p class="config-card-help">Nenhum perfil disponível.</p>';
}

document.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.classList || !cb.classList.contains('cfg-access-checkbox') || cb.dataset.key !== 'movidesk') return;
    const grupo = document.querySelector(`[data-subabas="${CSS.escape(cb.dataset.role)}"]`);
    if (!grupo) return;
    grupo.querySelectorAll('input').forEach((i) => { i.disabled = !cb.checked; if (!cb.checked) i.checked = false; });
});

function applyTabPermissionsToForm(perms) {
    cfgAccessPermissions = perms || {};
    renderProfilesConfig();
}

async function loadTabPermissionsConfig() {
    try {
        const res = await fetch(`${API_BASE}/config/tab-permissions`, { headers: authHeaders() });
        const data = await res.json();
        const rolesRes = await fetch(`${API_BASE}/users/roles`, { headers: authHeaders() });
        const savedRoles = Object.keys(data.permissions || {});
        const fallbackRoles = [...new Set(['supervisor', 'atendente', 'guest', ...savedRoles])]
            .filter(name => name !== 'admin')
            .map(name => ({ name }));
        cfgAccessRoles = rolesRes.ok ? await rolesRes.json() : fallbackRoles;
        if (!cfgAccessRoles.length) cfgAccessRoles = fallbackRoles;
        applyTabPermissionsToForm((res.ok && data.permissions) ? data.permissions : CFG_ACCESS_DEFAULTS);
    } catch (e) {
        cfgAccessRoles = [
            { name: 'supervisor' }, { name: 'atendente' }, { name: 'guest' },
            ...Object.keys(cfgAccessPermissions).filter(name => !['admin', 'supervisor', 'atendente', 'guest'].includes(name)).map(name => ({ name }))
        ];
        applyTabPermissionsToForm(CFG_ACCESS_DEFAULTS);
        setCfgStatus('cfgTabPermissionsStatus', 'Não foi possível carregar — mostrando o padrão.', 'error');
    }
}

async function saveTabPermissionsConfig() {
    const btn = document.getElementById('cfgSaveTabPermissions');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
    try {
        const permissions = {};
        cfgAccessRoles.filter(r => r.name !== 'admin').forEach(r => { permissions[r.name] = []; });
        document.querySelectorAll('.cfg-access-checkbox').forEach((cb) => {
            if (cb.checked) permissions[cb.dataset.role].push(cb.value);
        });
        const res = await fetch(`${API_BASE}/config/tab-permissions`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ permissions })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar');
        setCfgStatus('cfgTabPermissionsStatus', 'Salvo com sucesso — vale a partir do próximo carregamento do menu de cada pessoa.', 'ok');
    } catch (e) {
        setCfgStatus('cfgTabPermissionsStatus', `Erro ao salvar: ${e.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
    }
}

async function createProfileConfig() {
    const name = document.getElementById('cfgNewRoleName')?.value.trim();
    const description = document.getElementById('cfgNewRoleDescription')?.value.trim();
    try {
        const res = await fetch(`${API_BASE}/users/roles`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao criar perfil');
        document.getElementById('cfgNewRoleName').value = '';
        document.getElementById('cfgNewRoleDescription').value = '';
        setCfgStatus('cfgTabPermissionsStatus', 'Perfil criado. Escolha as abas e clique em Salvar.', 'ok');
        await loadTabPermissionsConfig();
    } catch (e) { setCfgStatus('cfgTabPermissionsStatus', `Erro ao criar perfil: ${e.message}`, 'error'); }
}

async function deleteProfileConfig(id) {
    if (!confirm('Remover este perfil? Usuários vinculados precisam ser reatribuídos antes.')) return;
    try {
        const res = await fetch(`${API_BASE}/users/roles/${id}`, { method: 'DELETE', headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao remover perfil');
        setCfgStatus('cfgTabPermissionsStatus', 'Perfil removido com sucesso.', 'ok');
        await loadTabPermissionsConfig();
    } catch (e) { setCfgStatus('cfgTabPermissionsStatus', `Erro ao remover perfil: ${e.message}`, 'error'); }
}

function resetTabPermissionsConfig() {
    applyTabPermissionsToForm(CFG_ACCESS_DEFAULTS);
    setCfgStatus('cfgTabPermissionsStatus', 'Padrão restaurado na tela. Clique em "Salvar" para confirmar.', 'ok');
}

async function loadGptStatus() {
    if (!isCurrentUserAdmin()) {
        setCfgStatus('cfgGptStatus', 'Somente admin pode consultar a chave GPT.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/gpt-key`, {
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar chave GPT');

        if (data.configured) {
            setCfgStatus('cfgGptStatus', 'Chave GPT configurada.', 'ok');
        } else {
            setCfgStatus('cfgGptStatus', 'Chave GPT ainda nao configurada.');
        }
    } catch (error) {
        setCfgStatus('cfgGptStatus', `Erro ao consultar chave GPT: ${error.message}`, 'error');
    }
}

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
    const loginEmail = document.getElementById('loginEmail');
    const loginPassword = document.getElementById('loginPassword');
    if (loginEmail) loginEmail.value = '';
    if (loginPassword) loginPassword.value = '';
    showLoginScreen();
}

async function loadGptPrompt() {
    if (!isCurrentUserAdmin()) {
        setCfgStatus('cfgPromptStatus', 'Somente admin pode consultar o prompt.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/gpt-prompt`, {
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar prompt');

        const input = document.getElementById('cfgGptPrompt');
        if (input) input.value = data.prompt || '';
        setCfgStatus('cfgPromptStatus', data.configured ? 'Prompt carregado.' : 'Prompt ainda nao configurado.');
    } catch (error) {
        setCfgStatus('cfgPromptStatus', `Erro ao consultar prompt: ${error.message}`, 'error');
    }
}

async function saveGptApiKey() {
    if (!isCurrentUserAdmin()) {
        setCfgStatus('cfgGptStatus', 'Somente admin pode salvar a chave GPT.', 'error');
        return;
    }

    const input = document.getElementById('cfgGptApiKey');
    const apiKey = input?.value?.trim();
    if (!apiKey) {
        setCfgStatus('cfgGptStatus', 'Informe a chave GPT antes de salvar.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/gpt-key`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ apiKey })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar chave GPT');

        input.value = '';
        setCfgStatus('cfgGptStatus', 'Chave GPT salva com sucesso.', 'ok');
        await loadGptStatus();
    } catch (error) {
        setCfgStatus('cfgGptStatus', `Erro ao salvar chave GPT: ${error.message}`, 'error');
    }
}

async function saveGptPrompt() {
    if (!isCurrentUserAdmin()) {
        setCfgStatus('cfgPromptStatus', 'Somente admin pode salvar o prompt.', 'error');
        return;
    }

    const input = document.getElementById('cfgGptPrompt');
    const prompt = input?.value?.trim();
    if (!prompt) {
        setCfgStatus('cfgPromptStatus', 'Informe o prompt antes de salvar.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/gpt-prompt`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar prompt');

        setCfgStatus('cfgPromptStatus', 'Prompt salvo com sucesso.', 'ok');
        await loadGptPrompt();
    } catch (error) {
        setCfgStatus('cfgPromptStatus', `Erro ao salvar prompt: ${error.message}`, 'error');
    }
}


function resetGptPromptToDefault() {
    const input = document.getElementById('cfgGptPrompt');
    if (!input) return;
    input.value = `Analise o ticket JSON abaixo e retorne APENAS um objeto JSON valido com todos os campos preenchidos com dados reais do ticket.

JSON DO TICKET:
{{ticketJson}}

Voce e um analista senior de suporte critico que analisa tickets de suporte em JSON.

REGRAS ABSOLUTAS:
- Analise TODO o JSON do ticket fornecido, incluindo campos principais, customFields, actions, clients e statusHistories
- Se serviceFirstLevel for exatamente "Sistemas Internos", nao use causa, fato nem ModuloXRotina como base da analise, porque esses campos podem nao existir ou nao ser aplicaveis
- Em tickets de Sistemas Internos, baseie diagnostico, urgencia e impacto principalmente em subject, description, justification, actions, clients, statusHistories e demais campos reais do ticket
- Ignore acoes com type = 1 (acoes internas de escalonamento/atribuicao)
- Ignore acoes onde createdBy.id = "007" (acoes de sistema)
- Suporte = createdBy com email contendo @viasoft.com.br OU createdBy.businessName === owner.businessName (quando businessName nao for vazio)
- Cliente = usuario solicitante do chamado {{solicitante}}
- Fato relatado = {{fato}}
- Causa identificada = {{causa}}
- Modulo X Rotina = {{ModuloXRotina}}
- Responda APENAS com um JSON valido, sem markdown, sem texto adicional, sem crases, sem blocos de codigo
- Preencha TODOS os campos com dados reais do JSON do ticket
- Nunca use dados ficticios como user123 ou owner@example.com
- Use SEMPRE os nomes e e-mails reais presentes no JSON fornecido

ANALISE ENCADEADA:
- Excecao: se o ticket for de Sistemas Internos, o diagnostico nao deve depender de causa, fato ou ModuloXRotina; nesses casos, preencha esses campos apenas com "Nao se aplica a Sistemas Internos" quando nao houver valor real no JSON

Actions do ticket (JSON):
{{actionsJson}}`;
    setCfgStatus('cfgPromptStatus', 'Modelo padrão restaurado no campo. Clique em salvar para aplicar.', 'ok');
}

// ============================================================
// AI USAGE — Consumo de tokens e custo estimado
// ============================================================

function fmtTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'k';
    return String(num);
}

function fmtCost(usd) {
    const v = Number(usd) || 0;
    if (v < 0.01) return '< $0,01';
    return '$' + v.toFixed(3).replace('.', ',');
}

function fmtSource(src) {
    const map = {
        'executive_summary':       'Resumo Executivo',
        'competencias_curadoria':  'Competências (Curadoria)',
    };
    return map[src] || src;
}

async function loadAiUsage() {
    if (!isCurrentUserAdmin()) return;

    const days = document.getElementById('cfgUsageDays')?.value || '30';
    const statusEl = document.getElementById('cfgUsageStatus');
    const kpiCalls  = document.getElementById('cfgKpiCalls');
    const kpiInput  = document.getElementById('cfgKpiInput');
    const kpiOutput = document.getElementById('cfgKpiOutput');
    const kpiCost   = document.getElementById('cfgKpiCost');

    if (statusEl) statusEl.textContent = 'Carregando...';

    try {
        const res = await fetch(`${API_BASE}/config/ai-usage?days=${days}`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`Erro ${res.status}`);
        const data = await res.json();
        const s = data.summary || {};

        // KPIs
        if (kpiCalls)  kpiCalls.textContent  = Number(s.total_calls || 0).toLocaleString('pt-BR');
        if (kpiInput)  kpiInput.textContent   = fmtTokens(s.total_input_tokens);
        if (kpiOutput) kpiOutput.textContent  = fmtTokens(s.total_output_tokens);
        if (kpiCost)   kpiCost.textContent    = fmtCost(s.total_cost_usd);

        // Breakdown por fonte
        const breakdownEl = document.getElementById('cfgUsageBreakdown');
        if (breakdownEl) {
            if (!data.bySource || !data.bySource.length) {
                breakdownEl.innerHTML = '<p style="font-size:13px;color:var(--muted);padding:8px 0">Nenhuma chamada registrada neste período.</p>';
            } else {
                breakdownEl.innerHTML = `
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:6px">Por origem</div>
                    ${data.bySource.map(row => `
                        <div class="cfg-usage-row">
                            <span class="cfg-usage-source">${fmtSource(row.source)}</span>
                            <span class="cfg-usage-model">${row.model || '—'}</span>
                            <span class="cfg-usage-tokens">${fmtTokens(row.tokens)} tokens</span>
                            <span class="cfg-usage-cost">${fmtCost(row.cost_usd)}</span>
                        </div>
                    `).join('')}
                `;
            }
        }

        // Mini gráfico de barras diárias
        const chartEl = document.getElementById('cfgUsageChart');
        if (chartEl) {
            if (!data.daily || !data.daily.length) {
                chartEl.innerHTML = '';
            } else {
                const maxCost = Math.max(...data.daily.map(d => Number(d.cost_usd) || 0), 0.0001);
                chartEl.innerHTML = `
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:8px">Consumo diário</div>
                    <div class="cfg-chart-wrap">
                        ${data.daily.map(d => {
                            const pct = Math.max(4, Math.round((Number(d.cost_usd) / maxCost) * 100));
                            const label = `${d.day}: ${fmtTokens(d.tokens)} tokens · ${fmtCost(d.cost_usd)}`;
                            return `<div class="cfg-chart-bar" style="height:${pct}%" title="${label}"></div>`;
                        }).join('')}
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:4px;padding:0 2px">
                        <span>${data.daily[0]?.day || ''}</span>
                        <span>${data.daily[data.daily.length-1]?.day || ''}</span>
                    </div>
                `;
            }
        }

        if (statusEl) statusEl.textContent = '';
    } catch(err) {
        if (statusEl) { statusEl.textContent = 'Erro ao carregar consumo: ' + err.message; statusEl.className = 'config-status config-status-error'; }
    }
}

/* ── Processamento de chamados pendentes (curadoria) ─────────────────────────
   O job roda inteiro no servidor (ver server/routes/curadoria.js). O frontend só
   inicia o job e consulta o progresso via polling — por isso continua rodando
   mesmo se você sair desta tela ou fechar a aba, e retoma o acompanhamento
   automaticamente se um job já estiver em andamento quando você voltar. ────── */
let _curadoriaPollInterval = null;

async function loadCuradoriaPendingCount() {
    const badge = document.getElementById('cfgCuradoriaPendingCount');
    try {
        const response = await fetch(`${API_BASE}/curadoria/pending-count`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar pendentes');
        if (badge) {
            badge.textContent = `${data.count} chamado${data.count !== 1 ? 's' : ''}`;
            badge.className = data.count > 0 ? 'config-token-status config-token-status-off' : 'config-token-status config-token-status-on';
        }
    } catch (error) {
        if (badge) { badge.textContent = 'Erro ao consultar'; badge.className = 'config-token-status config-token-status-off'; }
    }

    // Se um job já estiver rodando em segundo plano (iniciado antes desta tela abrir),
    // retoma o acompanhamento automaticamente em vez de mostrar o botão como se nada
    // estivesse acontecendo. Mesmo se o job já tiver terminado, ainda renderiza o resultado
    // (inclusive a lista de erros) — o estado fica em memória no servidor até o próximo job,
    // então sem isso os erros de uma rodada em segundo plano nunca apareceriam pra quem só
    // reabre a tela depois.
    try {
        const statusResponse = await fetch(`${API_BASE}/curadoria/process-pending/status`, { headers: authHeaders() });
        const statusData = await statusResponse.json();
        if (statusResponse.ok && statusData.startedAt) {
            renderCuradoriaProgress(statusData);
            if (statusData.running) startCuradoriaPolling();
        }
    } catch (_) { /* não crítico */ }
}

async function startCuradoriaProcessing() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/process-pending`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao iniciar processamento');
        renderCuradoriaProgress(data);
        startCuradoriaPolling();
    } catch (error) {
        setCfgStatus('cfgCuradoriaProcessStatus', `Erro ao iniciar: ${error.message}`, 'error');
    }
}

function startCuradoriaPolling() {
    if (_curadoriaPollInterval) return; // já tem um polling ativo, não duplica
    pollCuradoriaProcessingStatus();
    _curadoriaPollInterval = setInterval(pollCuradoriaProcessingStatus, 1500);
}

async function pollCuradoriaProcessingStatus() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/process-pending/status`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar status');
        renderCuradoriaProgress(data);
        if (!data.running) {
            clearInterval(_curadoriaPollInterval);
            _curadoriaPollInterval = null;
            await loadCuradoriaPendingCount();
        }
    } catch (error) {
        console.warn('[curadoria] erro ao consultar progresso:', error.message);
    }
}

// Renderiza a lista de chamados que falharam no processamento (data.recentErrors, já vem
// limitada a 20 itens mais recentes pelo backend) — sem isso, o único jeito de saber o que
// deu errado era abrir o console do navegador.
function renderCuradoriaErrorsList(errors, wrapId, listId) {
    const wrap = document.getElementById(wrapId);
    const list = document.getElementById(listId);
    if (!wrap || !list) return;
    if (!errors?.length) { wrap.style.display = 'none'; list.innerHTML = ''; return; }
    wrap.style.display = '';
    list.innerHTML = errors.map(e => `
        <div class="config-error-row">
            <span class="config-error-ticket">#${escapeHtml(String(e.ticket_id))}</span>
            <span class="config-error-msg">${escapeHtml(e.error)}</span>
            <span class="config-error-time">${e.at ? new Date(e.at).toLocaleTimeString('pt-BR') : ''}</span>
        </div>`).join('');
}

function renderCuradoriaProgress(data) {
    const btn = document.getElementById('cfgProcessPending');
    const stopBtn = document.getElementById('cfgStopProcessPending');
    const wrap = document.getElementById('cfgCuradoriaProgressWrap');
    const bar = document.getElementById('cfgCuradoriaProgressBar');
    const pctEl = document.getElementById('cfgCuradoriaProgressPct');
    const labelEl = document.getElementById('cfgCuradoriaProgressLabel');

    const done = (data.processed || 0) + (data.failed || 0);
    const pct = data.total > 0 ? Math.round((done / data.total) * 100) : 0;

    if (btn) btn.style.display = data.running ? 'none' : '';
    if (stopBtn) stopBtn.style.display = data.running ? '' : 'none';

    if (data.running || data.startedAt) {
        if (wrap) wrap.style.display = '';
        if (bar) bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = `${pct}% (${done}/${data.total})`;
    }

    if (data.running) {
        if (labelEl) labelEl.textContent = data.currentTicketId ? `Processando chamado #${data.currentTicketId}...` : 'Processando...';
        setCfgStatus('cfgCuradoriaProcessStatus', `${data.processed} concluído(s), ${data.failed} com erro`, '');
    } else if (data.startedAt) {
        const label = data.stopRequested ? 'Interrompido' : 'Concluído';
        if (labelEl) labelEl.textContent = label;
        setCfgStatus(
            'cfgCuradoriaProcessStatus',
            `${label}! ${data.processed} chamado(s) processado(s), ${data.failed} com erro.`,
            data.failed > 0 ? 'error' : 'ok'
        );
    }
    renderCuradoriaErrorsList(data.recentErrors, 'cfgCuradoriaErrorsWrap', 'cfgCuradoriaErrorsList');
}

async function stopCuradoriaProcessing() {
    try {
        await fetch(`${API_BASE}/curadoria/process-pending/stop`, { method: 'POST', headers: authHeaders() });
        setCfgStatus('cfgCuradoriaProcessStatus', 'Parando após o chamado atual...', '');
    } catch (error) {
        setCfgStatus('cfgCuradoriaProcessStatus', `Erro ao parar: ${error.message}`, 'error');
    }
}

/* ── Recálculo de estouro de SLA (cliente x suporte) — chamados já processados ───────────────
   Mesmo padrão de polling do processamento de pendentes acima, mas chamando a IA só com o
   critério de estouro de SLA (não refaz a análise comportamental inteira). ────────────────── */
let _slaEstouroPollInterval = null;

async function loadSlaEstouroCount() {
    const badge = document.getElementById('cfgSlaEstouroCount');
    try {
        const response = await fetch(`${API_BASE}/curadoria/sla-estouro/count`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar chamados');
        if (badge) {
            badge.textContent = `${data.count} chamado${data.count !== 1 ? 's' : ''}`;
            badge.className = 'config-token-status config-token-status-on';
        }
    } catch (error) {
        if (badge) { badge.textContent = 'Erro ao consultar'; badge.className = 'config-token-status config-token-status-off'; }
    }

    // Retoma o acompanhamento se um job já estiver rodando em segundo plano.
    try {
        const statusResponse = await fetch(`${API_BASE}/curadoria/sla-estouro/recalcular/status`, { headers: authHeaders() });
        const statusData = await statusResponse.json();
        if (statusResponse.ok && statusData.running) {
            renderSlaEstouroProgress(statusData);
            startSlaEstouroPolling();
        }
    } catch (_) { /* não crítico */ }
}

async function startSlaEstouroRecalc() {
    const confirmed = confirm(
        'Isso vai chamar a IA novamente para TODOS os chamados já processados, só para recalcular ' +
        'se um eventual estouro de SLA foi por culpa do cliente ou do suporte (vai gastar créditos de IA). Continuar?'
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_BASE}/curadoria/sla-estouro/recalcular`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao iniciar recálculo');
        renderSlaEstouroProgress(data);
        startSlaEstouroPolling();
    } catch (error) {
        setCfgStatus('cfgSlaEstouroStatus', `Erro ao iniciar: ${error.message}`, 'error');
    }
}

function startSlaEstouroPolling() {
    if (_slaEstouroPollInterval) return; // já tem um polling ativo, não duplica
    pollSlaEstouroStatus();
    _slaEstouroPollInterval = setInterval(pollSlaEstouroStatus, 1500);
}

async function pollSlaEstouroStatus() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/sla-estouro/recalcular/status`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar status');
        renderSlaEstouroProgress(data);
        if (!data.running) {
            clearInterval(_slaEstouroPollInterval);
            _slaEstouroPollInterval = null;
        }
    } catch (error) {
        console.warn('[curadoria] erro ao consultar progresso do recálculo de SLA:', error.message);
    }
}

function renderSlaEstouroProgress(data) {
    const btn = document.getElementById('cfgRecalcSlaEstouro');
    const stopBtn = document.getElementById('cfgStopSlaEstouroRecalc');
    const wrap = document.getElementById('cfgSlaEstouroProgressWrap');
    const bar = document.getElementById('cfgSlaEstouroProgressBar');
    const pctEl = document.getElementById('cfgSlaEstouroProgressPct');
    const labelEl = document.getElementById('cfgSlaEstouroProgressLabel');

    const done = (data.processed || 0) + (data.failed || 0);
    const pct = data.total > 0 ? Math.round((done / data.total) * 100) : 0;

    if (btn) btn.style.display = data.running ? 'none' : '';
    if (stopBtn) stopBtn.style.display = data.running ? '' : 'none';

    if (data.running || data.startedAt) {
        if (wrap) wrap.style.display = '';
        if (bar) bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = `${pct}% (${done}/${data.total})`;
    }

    if (data.running) {
        if (labelEl) labelEl.textContent = data.currentTicketId ? `Recalculando chamado #${data.currentTicketId}...` : 'Recalculando...';
        setCfgStatus('cfgSlaEstouroStatus', `${data.processed} concluído(s), ${data.failed} com erro`, '');
    } else if (data.startedAt) {
        const label = data.stopRequested ? 'Interrompido' : 'Concluído';
        if (labelEl) labelEl.textContent = label;
        setCfgStatus(
            'cfgSlaEstouroStatus',
            `${label}! ${data.processed} chamado(s) recalculado(s), ${data.failed} com erro.`,
            data.failed > 0 ? 'error' : 'ok'
        );
        if (data.recentErrors?.length) console.warn('[curadoria] erros no recálculo de SLA:', data.recentErrors);
    }
}

async function stopSlaEstouroRecalc() {
    try {
        await fetch(`${API_BASE}/curadoria/sla-estouro/recalcular/stop`, { method: 'POST', headers: authHeaders() });
        setCfgStatus('cfgSlaEstouroStatus', 'Parando após o chamado atual...', '');
    } catch (error) {
        setCfgStatus('cfgSlaEstouroStatus', `Erro ao parar: ${error.message}`, 'error');
    }
}

async function recalcularCompetencias() {
    const confirmed = confirm(
        'Isso apaga as competências já calculadas de TODOS os chamados processados. ' +
        'Elas serão recalculadas aos poucos, conforme cada atendente for aberto na tela de Curadoria ' +
        '(vai gastar créditos de IA de novo). Continuar?'
    );
    if (!confirmed) return;

    const btn = document.getElementById('cfgRecalcCompetencias');
    if (btn) { btn.disabled = true; btn.textContent = 'Recalculando...'; }
    try {
        const response = await fetch(`${API_BASE}/curadoria/competencias/reset`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao recalcular competências');
        setCfgStatus(
            'cfgRecalcCompetenciasStatus',
            `${data.reset} chamado(s) marcados para recálculo. Abra cada atendente na tela de Curadoria para gerar as novas competências.`,
            'ok'
        );
    } catch (error) {
        setCfgStatus('cfgRecalcCompetenciasStatus', `Erro ao recalcular: ${error.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Recalcular competências de todos os chamados'; }
    }
}

/* ── Carga bruta — dispara os 3 jobs de enriquecimento de uma vez ────────── */
function _formatFullLoadTimestamp(iso) {
    if (!iso) return 'Nunca rodou';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Nunca rodou';
    return d.toLocaleString('pt-BR');
}

function _setFullLoadButtonLoading(running) {
    const btn = document.getElementById('cfgTriggerFullLoad');
    if (!btn) return;
    if (!btn.dataset.originalLabel) btn.dataset.originalLabel = btn.textContent;
    btn.disabled = running;
    if (running) {
        btn.innerHTML = '<span class="config-btn-spinner"></span> Rodando...';
    } else {
        btn.textContent = btn.dataset.originalLabel;
    }
}

function _renderPipelineStep(key, barId, infoId, state) {
    const bar  = document.getElementById(barId);
    const info = document.getElementById(infoId);
    if (!bar || !info) return;
    if (!state) { bar.style.width = '0%'; info.textContent = 'Aguardando'; return; }
    const done  = (state.processed || 0) + (state.failed || 0);
    const total = state.total || 0;
    const pct   = total > 0 ? Math.round((done / total) * 100) : (state.running ? 5 : 0);
    bar.style.width  = pct + '%';
    bar.style.background = state.running ? '#3b82f6' : (state.stopRequested ? '#f59e0b' : '#22c55e');
    if (state.running) {
        info.textContent = total > 0 ? `${done}/${total} (${pct}%)` : 'Iniciando…';
    } else if (state.startedAt) {
        info.textContent = state.stopRequested
            ? `Parado — ${done}/${total}`
            : `Concluído — ${done}/${total}`;
    } else {
        info.textContent = 'Aguardando';
    }
}

function renderFullLoadStatus(data) {
    const lastRunEl = document.getElementById('cfgFullLoadLastRun');
    if (lastRunEl) {
        const sourceLabel = data.lastRun?.source === 'scheduled' ? 'automática' : data.lastRun?.source === 'manual' ? 'manual' : '';
        lastRunEl.textContent = data.lastRun?.at
            ? `${_formatFullLoadTimestamp(data.lastRun.at)}${sourceLabel ? ` (${sourceLabel})` : ''}`
            : 'Nunca rodou';
    }

    const anyRunning = !!(data.processamento?.running || data.slaEstouro?.running || data.survey?.running || data.modulo?.running);
    _setFullLoadButtonLoading(anyRunning);

    // Botão Parar tudo
    const stopBtn = document.getElementById('cfgStopFullLoad');
    if (stopBtn) stopBtn.style.display = anyRunning ? '' : 'none';

    // Mini-cards de cada etapa
    _renderPipelineStep('ia',     'cfgPipeBar-ia',     'cfgPipeInfo-ia',     data.processamento);
    _renderPipelineStep('sla',    'cfgPipeBar-sla',    'cfgPipeInfo-sla',    data.slaEstouro);
    _renderPipelineStep('survey', 'cfgPipeBar-survey', 'cfgPipeInfo-survey', data.survey);
    _renderPipelineStep('modulo', 'cfgPipeBar-modulo', 'cfgPipeInfo-modulo', data.modulo);

    // Também atualiza erros de IA se disponíveis
    if (data.processamento) {
        renderCuradoriaErrorsList(data.processamento.recentErrors || [], 'cfgCuradoriaErrorsWrap', 'cfgCuradoriaErrorsList');
    }

    setCfgStatus('cfgFullLoadStatus', anyRunning ? 'Pipeline em andamento — pode fechar esta tela, continua em segundo plano.' : (data.lastRun?.at ? 'Concluído.' : ''), anyRunning ? '' : 'ok');
}

async function loadFullLoadStatus() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/full-load/status`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar status');
        renderFullLoadStatus(data);
    } catch (error) {
        setCfgStatus('cfgFullLoadStatus', `Erro ao consultar status: ${error.message}`, 'error');
    }
}

async function triggerCuradoriaFullLoad() {
    _setFullLoadButtonLoading(true);
    try {
        const ano = (document.getElementById('cfgPipeAno')?.value || '').trim();
        const limite = (document.getElementById('cfgPipeLimite')?.value || '').trim();
        const qtd = document.getElementById('cfgPipeAnoCount')?.dataset.n || '';
        const txt = `${ano ? `os chamados de ${ano}` : 'TODOS os chamados pendentes'}${limite ? `, no máximo ${limite}` : ''}${qtd ? ` (hoje: ${qtd} pendentes${ano ? ' nesse ano' : ''})` : ''}`;
        if (!confirm(`A IA vai analisar ${txt}. Isso consome créditos da OpenAI. Continuar?`)) { _setFullLoadButtonLoading(false); return; }
        const response = await fetch(`${API_BASE}/curadoria/full-load`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ano: ano || undefined, limite: limite || undefined }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao disparar pipeline');
        renderFullLoadStatus(data);
        startFullLoadPolling();
    } catch (error) {
        _setFullLoadButtonLoading(false);
        setCfgStatus('cfgFullLoadStatus', `Erro ao iniciar: ${error.message}`, 'error');
    }
}

async function loadPipeAnoCount() {
    const el = document.getElementById('cfgPipeAnoCount');
    if (!el) return;
    const ano = (document.getElementById('cfgPipeAno')?.value || '').trim();
    try {
        const r = await fetch(`${API_BASE}/curadoria/pending-count${ano ? `?ano=${encodeURIComponent(ano)}` : ''}`, { headers: authHeaders() });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'erro');
        el.dataset.n = d.count;
        el.textContent = `${d.count.toLocaleString('pt-BR')} chamado(s) pendente(s)${ano ? ` em ${ano}` : ''}`;
    } catch (e) { el.dataset.n = ''; el.textContent = ''; }
}

async function stopFullPipeline() {
    try {
        await Promise.allSettled([
            fetch(`${API_BASE}/curadoria/process-pending/stop`,      { method: 'POST', headers: authHeaders() }),
            fetch(`${API_BASE}/curadoria/sla-estouro/recalcular/stop`, { method: 'POST', headers: authHeaders() }),
            fetch(`${API_BASE}/curadoria/survey/sync/stop`,          { method: 'POST', headers: authHeaders() }),
            fetch(`${API_BASE}/curadoria/modulo/sync/stop`,          { method: 'POST', headers: authHeaders() }),
        ]);
        setCfgStatus('cfgFullLoadStatus', 'Solicitação de parada enviada.', '');
        const stopBtn = document.getElementById('cfgStopFullLoad');
        if (stopBtn) stopBtn.disabled = true;
    } catch (e) {
        setCfgStatus('cfgFullLoadStatus', `Erro ao parar: ${e.message}`, 'error');
    }
}

async function checkFullLoadOnLoad() {
    await loadFullLoadStatus();
    try {
        const response = await fetch(`${API_BASE}/curadoria/full-load/status`, { headers: authHeaders() });
        const data = await response.json();
        const anyRunning = response.ok && !!(data.processamento?.running || data.slaEstouro?.running || data.survey?.running || data.modulo?.running);
        if (anyRunning) startFullLoadPolling();
    } catch (_) { /* não crítico */ }
}

let _fullLoadPollInterval = null;
function startFullLoadPolling() {
    if (_fullLoadPollInterval) return;
    _fullLoadPollInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE}/curadoria/full-load/status`, { headers: authHeaders() });
            const data = await response.json();
            if (!response.ok) return;
            renderFullLoadStatus(data);
            const anyRunning = !!(data.processamento?.running || data.slaEstouro?.running || data.survey?.running || data.modulo?.running);
            if (!anyRunning) {
                clearInterval(_fullLoadPollInterval);
                _fullLoadPollInterval = null;
                const stopBtn = document.getElementById('cfgStopFullLoad');
                if (stopBtn) stopBtn.disabled = false;
            }
        } catch (_) { /* não crítico */ }
    }, 1500);
}

/* ── Enriquecimento de chamados (busca detalhes na API) ─────────────────────── */
let _enrichPollInterval = null;

async function loadEnrichCount() {
    try {
        const r = await fetch(`${API_BASE}/curadoria/enriquecimento/count`, { headers: authHeaders() });
        const data = await r.json();
        const el = document.getElementById('cfgEnrichCount');
        if (el) el.textContent = `${data.count ?? '–'} chamado(s)`;
    } catch (_) {}
}

function fmtEta(ms) {
    if (!ms || ms <= 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60)  return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60)  return `${m}m ${rs}s`;
    const h = Math.floor(m / 60), rm = m % 60;
    return `${h}h ${rm}m`;
}

function renderEnrichStatus(state) {
    const progressWrap = document.getElementById('cfgEnrichProgressWrap');
    const bar          = document.getElementById('cfgEnrichProgressBar');
    const label        = document.getElementById('cfgEnrichProgressLabel');
    const pct          = document.getElementById('cfgEnrichProgressPct');
    const stats        = document.getElementById('cfgEnrichStats');
    const etaEl        = document.getElementById('cfgEnrichEta');
    const startBtn     = document.getElementById('cfgStartEnrich');
    const stopBtn      = document.getElementById('cfgStopEnrich');
    const errorsWrap   = document.getElementById('cfgEnrichErrorsWrap');
    const errorsList   = document.getElementById('cfgEnrichErrorsList');

    if (!state || (!state.running && !state.done && !state.total)) return;

    if (progressWrap) progressWrap.style.display = '';

    const total  = state.total  || 0;
    const done   = state.done   || 0;
    const pctVal = total > 0 ? Math.round((done / total) * 100) : 0;
    if (bar)   bar.style.width = `${pctVal}%`;
    if (pct)   pct.textContent = `${pctVal}%`;

    // ETA
    if (etaEl) {
        if (state.running && done > 0 && state.startedAt) {
            const elapsed  = Date.now() - new Date(state.startedAt).getTime();
            const remaining = total - done;
            const etaMs    = remaining > 0 ? (elapsed / done) * remaining : 0;
            etaEl.textContent = etaMs > 0 ? `⏱ Conclusão em ~${fmtEta(etaMs)}` : '';
        } else if (!state.running && state.finishedAt && state.startedAt) {
            const dur = new Date(state.finishedAt) - new Date(state.startedAt);
            etaEl.textContent = `Duração total: ${fmtEta(dur)}`;
        } else {
            etaEl.textContent = '';
        }
    }

    if (label) {
        const anosStr = (state.anosAlvo && state.anosAlvo.length)
            ? ` [${state.anosAlvo[0]}–${state.anosAlvo[state.anosAlvo.length-1]}]` : '';
        if (state.running && state.currentTicketId) label.textContent = `Varrendo ${state.currentTicketId}${anosStr} — ${done}/${total} processados`;
        else if (state.stopRequested)               label.textContent = 'Parando…';
        else if (!state.running && total > 0)       label.textContent = 'Concluído ✅';
        else label.textContent = `${done} / ${total}`;
    }
    if (stats) stats.textContent = `✅ ${state.updated||0} enriquecidos  |  🔍 ${state.notFound||0} não encontrados  |  ❌ ${state.failed||0} erros`;

    if (startBtn) startBtn.disabled = !!state.running;
    if (stopBtn)  stopBtn.style.display = state.running ? '' : 'none';

    if (errorsWrap && errorsList && Array.isArray(state.recentErrors) && state.recentErrors.length) {
        errorsWrap.style.display = '';
        errorsList.innerHTML = state.recentErrors.slice(0, 5).map(e =>
            `<div class="config-error-item">Ticket #${e.ticket_id}: ${e.error}</div>`
        ).join('');
    }
}

async function loadEnrichStatus() {
    try {
        const r = await fetch(`${API_BASE}/curadoria/enriquecimento/status`, { headers: authHeaders() });
        const data = await r.json();
        renderEnrichStatus(data);
        if (data.running && !_enrichPollInterval) startEnrichPolling();
    } catch (_) {}
}

async function startEnriquecimento() {
    const anosInput = (document.getElementById('cfgEnrichAnos')?.value || '').trim();
    const anos = anosInput ? anosInput.split(/[,\s]+/).map(a => parseInt(a, 10)).filter(n => !isNaN(n)) : [];
    try {
        const r = await fetch(`${API_BASE}/curadoria/enriquecimento/start`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ anos })
        });
        const data = await r.json();
        renderEnrichStatus(data);
        startEnrichPolling();
        const status = document.getElementById('cfgEnrichStatus');
        if (status) { status.textContent = anos.length ? `Buscando detalhes — anos: ${anos.join(', ')}` : 'Buscando detalhes de todos os anos…'; }
    } catch (e) {
        const status = document.getElementById('cfgEnrichStatus');
        if (status) status.textContent = `Erro: ${e.message}`;
    }
}

async function stopEnriquecimento() {
    try {
        await fetch(`${API_BASE}/curadoria/enriquecimento/stop`, { method: 'POST', headers: authHeaders() });
        const stopBtn = document.getElementById('cfgStopEnrich');
        if (stopBtn) stopBtn.disabled = true;
    } catch (_) {}
}

function startEnrichPolling() {
    if (_enrichPollInterval) return;
    _enrichPollInterval = setInterval(async () => {
        try {
            const r = await fetch(`${API_BASE}/curadoria/enriquecimento/status`, { headers: authHeaders() });
            const data = await r.json();
            if (!r.ok) return;
            renderEnrichStatus(data);
            if (!data.running) {
                clearInterval(_enrichPollInterval);
                _enrichPollInterval = null;
                loadEnrichCount(); // atualiza contagem ao terminar
            }
        } catch (_) {}
    }, 1500);
}

/* ── Satisfação do cliente (pesquisa Movidesk) — busca chamado por chamado ────
   O job roda no servidor (ver server/routes/curadoria.js), um ticket por vez,
   respeitando o rate limit do Movidesk. Mesmo padrão de fila+polling do
   processamento de chamados pendentes. ────────────────────────────────────── */
let _surveySyncPollInterval = null;

async function loadSurveyPendingCount() {
    const badge = document.getElementById('cfgSurveyPendingCount');
    try {
        const response = await fetch(`${API_BASE}/curadoria/survey/pending-count`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar pendentes');
        if (badge) {
            badge.textContent = `${data.count} chamado${data.count !== 1 ? 's' : ''}`;
            badge.className = data.count > 0 ? 'config-token-status config-token-status-off' : 'config-token-status config-token-status-on';
        }
    } catch (error) {
        if (badge) { badge.textContent = 'Erro ao consultar'; badge.className = 'config-token-status config-token-status-off'; }
    }
}

function renderSurveySyncProgress(data) {
    const btn = document.getElementById('cfgSyncSurvey');
    const stopBtn = document.getElementById('cfgStopSurveySync');
    const wrap = document.getElementById('cfgSurveySyncProgressWrap');
    const labelEl = document.getElementById('cfgSurveySyncProgressLabel');
    const pctEl = document.getElementById('cfgSurveySyncProgressPct');
    const bar = document.getElementById('cfgSurveySyncProgressBar');

    if (btn) btn.style.display = data.running ? 'none' : '';
    if (stopBtn) stopBtn.style.display = data.running ? '' : 'none';

    const done = (data.processed || 0);
    const pct = data.total > 0 ? Math.round((done / data.total) * 100) : 0;

    if (data.running || data.startedAt) {
        if (wrap) wrap.style.display = '';
        if (bar) bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = `${pct}% (${done}/${data.total})`;
    }

    if (data.running) {
        if (labelEl) labelEl.textContent = data.currentTicketId ? `Verificando chamado #${data.currentTicketId}...` : 'Iniciando...';
        setCfgStatus('cfgSurveySyncStatus', `${data.updated} atualizado(s), ${data.skipped} sem resposta de pesquisa`, '');
    } else if (data.startedAt) {
        if (data.error) {
            setCfgStatus('cfgSurveySyncStatus', `Erro na sincronização: ${data.error}`, 'error');
        } else {
            const label = data.stopRequested ? 'Interrompido' : 'Concluído';
            if (labelEl) labelEl.textContent = label;
            setCfgStatus(
                'cfgSurveySyncStatus',
                `${label}! ${data.updated} chamado(s) atualizado(s) com nota real de satisfação, ${data.skipped} sem resposta de pesquisa.`,
                'ok'
            );
        }
    }
}

async function startSurveySync() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/survey/sync`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao iniciar sincronização');
        renderSurveySyncProgress(data);
        startSurveySyncPolling();
    } catch (error) {
        setCfgStatus('cfgSurveySyncStatus', `Erro ao iniciar: ${error.message}`, 'error');
    }
}

async function stopSurveySync() {
    try {
        await fetch(`${API_BASE}/curadoria/survey/sync/stop`, { method: 'POST', headers: authHeaders() });
        setCfgStatus('cfgSurveySyncStatus', 'Parando após o chamado atual...', '');
    } catch (error) {
        setCfgStatus('cfgSurveySyncStatus', `Erro ao parar: ${error.message}`, 'error');
    }
}

function startSurveySyncPolling() {
    if (_surveySyncPollInterval) return;
    pollSurveySyncStatus();
    _surveySyncPollInterval = setInterval(pollSurveySyncStatus, 1500);
}

async function pollSurveySyncStatus() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/survey/sync/status`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar status');
        renderSurveySyncProgress(data);
        if (!data.running) {
            clearInterval(_surveySyncPollInterval);
            _surveySyncPollInterval = null;
            await loadSurveyPendingCount();
        }
    } catch (error) {
        console.warn('[survey] erro ao consultar progresso:', error.message);
    }
}

// Retoma o acompanhamento se uma sincronização já estiver rodando (ex: iniciada antes
// desta tela ser aberta) — mesmo padrão do processamento de chamados pendentes.
async function checkSurveySyncOnLoad() {
    await loadSurveyPendingCount();
    try {
        const response = await fetch(`${API_BASE}/curadoria/survey/sync/status`, { headers: authHeaders() });
        const data = await response.json();
        if (response.ok && data.running) {
            renderSurveySyncProgress(data);
            startSurveySyncPolling();
        }
    } catch (_) { /* não crítico */ }
}

/* ── Módulo x Rotina (campo customizado Movidesk) — busca chamado por chamado ──
   Mesmo padrão de fila+polling da sincronização de satisfação. ─────────────── */
let _moduloSyncPollInterval = null;

async function loadModuloPendingCount() {
    const badge = document.getElementById('cfgModuloPendingCount');
    try {
        const response = await fetch(`${API_BASE}/curadoria/modulo/pending-count`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar pendentes');
        if (badge) {
            badge.textContent = `${data.count} chamado${data.count !== 1 ? 's' : ''}`;
            badge.className = data.count > 0 ? 'config-token-status config-token-status-off' : 'config-token-status config-token-status-on';
        }
    } catch (error) {
        if (badge) { badge.textContent = 'Erro ao consultar'; badge.className = 'config-token-status config-token-status-off'; }
    }
}

function renderModuloSyncProgress(data) {
    const btn = document.getElementById('cfgSyncModulo');
    const stopBtn = document.getElementById('cfgStopModuloSync');
    const wrap = document.getElementById('cfgModuloSyncProgressWrap');
    const labelEl = document.getElementById('cfgModuloSyncProgressLabel');
    const pctEl = document.getElementById('cfgModuloSyncProgressPct');
    const bar = document.getElementById('cfgModuloSyncProgressBar');

    if (btn) btn.style.display = data.running ? 'none' : '';
    if (stopBtn) stopBtn.style.display = data.running ? '' : 'none';

    const done = (data.processed || 0);
    const pct = data.total > 0 ? Math.round((done / data.total) * 100) : 0;

    if (data.running || data.startedAt) {
        if (wrap) wrap.style.display = '';
        if (bar) bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = `${pct}% (${done}/${data.total})`;
    }

    if (data.running) {
        if (labelEl) labelEl.textContent = data.currentTicketId ? `Verificando chamado #${data.currentTicketId}...` : 'Iniciando...';
        setCfgStatus('cfgModuloSyncStatus', `${data.updated} atualizado(s), ${data.skipped} sem módulo x rotina`, '');
    } else if (data.startedAt) {
        if (data.error) {
            setCfgStatus('cfgModuloSyncStatus', `Erro na sincronização: ${data.error}`, 'error');
        } else {
            const label = data.stopRequested ? 'Interrompido' : 'Concluído';
            if (labelEl) labelEl.textContent = label;
            setCfgStatus(
                'cfgModuloSyncStatus',
                `${label}! ${data.updated} chamado(s) atualizado(s) com módulo x rotina, ${data.skipped} sem o campo preenchido.`,
                'ok'
            );
        }
    }
}

async function startModuloSync() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/modulo/sync`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao iniciar sincronização');
        renderModuloSyncProgress(data);
        startModuloSyncPolling();
    } catch (error) {
        setCfgStatus('cfgModuloSyncStatus', `Erro ao iniciar: ${error.message}`, 'error');
    }
}

async function stopModuloSync() {
    try {
        await fetch(`${API_BASE}/curadoria/modulo/sync/stop`, { method: 'POST', headers: authHeaders() });
        setCfgStatus('cfgModuloSyncStatus', 'Parando após o chamado atual...', '');
    } catch (error) {
        setCfgStatus('cfgModuloSyncStatus', `Erro ao parar: ${error.message}`, 'error');
    }
}

function startModuloSyncPolling() {
    if (_moduloSyncPollInterval) return;
    pollModuloSyncStatus();
    _moduloSyncPollInterval = setInterval(pollModuloSyncStatus, 1500);
}

async function pollModuloSyncStatus() {
    try {
        const response = await fetch(`${API_BASE}/curadoria/modulo/sync/status`, { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar status');
        renderModuloSyncProgress(data);
        if (!data.running) {
            clearInterval(_moduloSyncPollInterval);
            _moduloSyncPollInterval = null;
            await loadModuloPendingCount();
        }
    } catch (error) {
        console.warn('[modulo] erro ao consultar progresso:', error.message);
    }
}

async function checkModuloSyncOnLoad() {
    await loadModuloPendingCount();
    try {
        const response = await fetch(`${API_BASE}/curadoria/modulo/sync/status`, { headers: authHeaders() });
        const data = await response.json();
        if (response.ok && data.running) {
            renderModuloSyncProgress(data);
            startModuloSyncPolling();
        }
    } catch (_) { /* não crítico */ }
}

// ─── Aba Carga Datalake ────────────────────────────────────────────────────────
let _dlPollTimer = null;

// ── Seleção de anos ───────────────────────────────────────────────────────────
let _dlYearsInited = false;
function dlInitYears() {
    if (_dlYearsInited) return;
    const grid = document.getElementById('dlYearGrid');
    if (!grid) return;
    _dlYearsInited = true;
    const currentYear = new Date().getFullYear();
    const firstYear   = 2018;
    for (let y = currentYear; y >= firstYear; y--) {
        const id  = `dlYear_${y}`;
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding:5px 12px;border-radius:6px;border:1px solid var(--border,#333);font-size:13px;font-weight:500;user-select:none;transition:border-color .15s;';
        lbl.innerHTML = `<input type="checkbox" id="${id}" value="${y}" onchange="dlUpdateYearNote()" style="accent-color:#3b82f6;"> ${y}`;
        grid.appendChild(lbl);
    }
    dlUpdateYearNote();
}

function dlYearsSelectAll(check) {
    document.querySelectorAll('#dlYearGrid input[type=checkbox]').forEach(cb => { cb.checked = check; });
    dlUpdateYearNote();
}

function dlGetSelectedYears() {
    return [...document.querySelectorAll('#dlYearGrid input[type=checkbox]:checked')].map(cb => Number(cb.value));
}

function dlUpdateYearNote() {
    const note   = document.getElementById('dlYearNote');
    const btnFull = document.getElementById('dlBtnFull');
    if (!note) return;
    const years = dlGetSelectedYears();
    if (!years.length) {
        note.textContent = '⚡ Nenhum ano marcado → a carga full carregará TODOS os anos (pode demorar horas).';
        if (btnFull) btnFull.title = 'Carga full — todos os anos';
    } else {
        const sorted = [...years].sort();
        note.textContent = `📅 Anos selecionados: ${sorted.join(', ')} (${sorted.length} ano${sorted.length > 1 ? 's' : ''})`;
        if (btnFull) btnFull.title = `Carga full — ${sorted.join(', ')}`;
    }
}

async function dlLoad() {
    dlInitYears(); // inicializa o grid de anos na primeira abertura da aba
    try {
        const resp = await fetch('/api/loader/status', { headers: authHeaders(), cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        dlRenderStatus(data.current, data.tokenSuffix);
        dlRenderHistory(data.history || []);
        // polling automático enquanto estiver rodando
        if (data.current?.running) {
            if (!_dlPollTimer) _dlPollTimer = setInterval(dlLoad, 3000);
        } else {
            clearInterval(_dlPollTimer);
            _dlPollTimer = null;
        }
    } catch (e) {
        console.error('[datalake] erro ao buscar status:', e.message);
        // mostra erro visível no badge e restaura botões
        const badge   = document.getElementById('dlBadge');
        const meta    = document.getElementById('dlMeta');
        const btnFull = document.getElementById('dlBtnFull');
        const btnInc  = document.getElementById('dlBtnInc');
        if (badge) {
            badge.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">error</span> Erro ao buscar status';
            badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#3f1717;color:#f87171;';
        }
        if (meta) meta.textContent = e.message;
        if (btnFull) {
            btnFull.disabled = false;
            btnFull.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">download_for_offline</span> Full agora';
        }
        if (btnInc) {
            btnInc.disabled = false;
            btnInc.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">update</span> Incremental agora';
        }
        clearInterval(_dlPollTimer);
        _dlPollTimer = null;
    }
}

async function dlTrigger(mode) {
    const btn = document.getElementById(mode === 'full' ? 'dlBtnFull' : 'dlBtnInc');
    const originalHTML = mode === 'full'
        ? '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">download_for_offline</span> Full agora'
        : '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">update</span> Incremental agora';

    if (!btn || btn.disabled) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;animation:spin 1s linear infinite">autorenew</span> Iniciando…';

    const badge = document.getElementById('dlBadge');
    const meta  = document.getElementById('dlMeta');

    try {
        const years = mode === 'full' ? dlGetSelectedYears() : [];
        const classification = mode === 'full' ? (document.getElementById('dlClassification')?.value || '').trim() : '';
        const ownerTeam = mode === 'full' ? (document.getElementById('dlOwnerTeam')?.value || '').trim() : '';
        const resp = await fetch(`/api/loader/${mode}`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(mode === 'full' ? { years, classification, ownerTeam } : {}),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        dlLoad();
        if (!_dlPollTimer) _dlPollTimer = setInterval(dlLoad, 3000);
    } catch (e) {
        if (badge) {
            badge.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;">error</span> ${e.message}`;
            badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#3f1717;color:#f87171;';
        }
        if (meta) meta.textContent = 'Verifique o erro acima e tente novamente.';
        btn.disabled = false;
        btn.innerHTML = originalHTML;
    }
}

async function dlCancel() {
    const btn = document.getElementById('dlBtnCancel');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">hourglass_top</span> Cancelando…';
    try {
        const resp = await fetch('/api/loader/cancel', {
            method: 'POST',
            headers: authHeaders(),
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            console.warn('[dlCancel] erro:', data.error);
        }
        dlLoad();
    } catch (e) {
        console.error('[dlCancel] falha:', e.message);
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">stop_circle</span> Cancelar';
    }
}

// ── Pesquisa de satisfação — seleção de anos + trigger ──────────────────────
let _dlSatYearsInited = false;
let _dlSatPollTimer = null;

function dlSatInitYears() {
    if (_dlSatYearsInited) return;
    const grid = document.getElementById('dlSatYearGrid');
    if (!grid) return;
    _dlSatYearsInited = true;
    const currentYear = new Date().getFullYear();
    const firstYear   = 2018;
    for (let y = currentYear; y >= firstYear; y--) {
        const id  = `dlSatYear_${y}`;
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding:5px 12px;border-radius:6px;border:1px solid var(--border,#333);font-size:13px;font-weight:500;user-select:none;transition:border-color .15s;';
        lbl.innerHTML = `<input type="checkbox" id="${id}" value="${y}" onchange="dlSatUpdateYearNote()" style="accent-color:#3b82f6;"> ${y}`;
        grid.appendChild(lbl);
    }
    dlSatUpdateYearNote();
}

function dlSatYearsSelectAll(check) {
    document.querySelectorAll('#dlSatYearGrid input[type=checkbox]').forEach(cb => { cb.checked = check; });
    dlSatUpdateYearNote();
}

function dlSatGetSelectedYears() {
    return [...document.querySelectorAll('#dlSatYearGrid input[type=checkbox]:checked')].map(cb => Number(cb.value));
}

function dlSatUpdateYearNote() {
    const note = document.getElementById('dlSatYearNote');
    if (!note) return;
    const years = dlSatGetSelectedYears();
    if (!years.length) {
        note.textContent = '⚡ Nenhum ano marcado → busca o histórico inteiro de respostas, desde 2018.';
    } else {
        const sorted = [...years].sort();
        note.textContent = `📅 Busca respostas desde 1º de janeiro de ${sorted[0]} até hoje (ignora o filtro de meses/anos posteriores — é só um piso).`;
    }
}

async function dlSatTrigger() {
    dlSatInitYears();
    const btn = document.getElementById('dlBtnSat');
    if (!btn || btn.disabled) return;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;animation:spin 1s linear infinite">autorenew</span> Iniciando…';
    try {
        const years = dlSatGetSelectedYears();
        const resp = await fetch('/api/loader/satisfacao/sync', {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ years }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        dlSatLoad();
        if (!_dlSatPollTimer) _dlSatPollTimer = setInterval(dlSatLoad, 4000);
    } catch (e) {
        const meta = document.getElementById('dlSatMeta');
        if (meta) meta.textContent = 'Erro: ' + e.message;
        btn.disabled = false;
        btn.innerHTML = originalHTML;
    }
}

async function dlSatStop() {
    const btn = document.getElementById('dlBtnSatStop');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
        await fetch('/api/loader/satisfacao/sync/stop', { method: 'POST', headers: authHeaders() });
        dlSatLoad();
    } catch (e) {
        console.error('[dlSatStop] falha:', e.message);
    } finally {
        btn.disabled = false;
    }
}

async function dlSatLoad() {
    dlSatInitYears();
    try {
        const resp = await fetch('/api/loader/satisfacao/status', { headers: authHeaders(), cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const s = await resp.json();
        const badge   = document.getElementById('dlSatBadge');
        const meta    = document.getElementById('dlSatMeta');
        const btnSat  = document.getElementById('dlBtnSat');
        const btnStop = document.getElementById('dlBtnSatStop');
        if (s.running) {
            if (badge) {
                badge.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;animation:spin 1s linear infinite">autorenew</span> Sincronizando';
                badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#1e3a5f;color:#60a5fa;';
            }
            const anosTxt = s.years?.length ? ` (anos ${[...s.years].sort().join(', ')})` : '';
            if (meta) meta.textContent = `${s.processed} resposta(s) processada(s)${anosTxt} · ${s.updated} salva(s) · ${s.errors} erro(s)`;
            if (btnSat) { btnSat.disabled = true; btnSat.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;animation:spin 1s linear infinite">autorenew</span> Rodando…'; }
            if (btnStop) btnStop.style.display = '';
            if (!_dlSatPollTimer) _dlSatPollTimer = setInterval(dlSatLoad, 4000);
        } else {
            if (badge) {
                badge.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">radio_button_unchecked</span> Ocioso';
                badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#27272a;color:#a1a1aa;';
            }
            if (meta) meta.textContent = s.lastError
                ? `Falhou: ${s.lastError}`
                : (s.finishedAt
                    ? `Última execução: ${s.updated} salva(s), ${s.errors} erro(s), de ${s.processed} resposta(s) encontrada(s).`
                    : '–');
            if (meta) meta.style.color = s.lastError ? '#f87171' : '';
            if (btnSat) { btnSat.disabled = false; btnSat.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">sentiment_satisfied</span> Sincronizar pesquisas'; }
            if (btnStop) btnStop.style.display = 'none';
            clearInterval(_dlSatPollTimer);
            _dlSatPollTimer = null;
        }
    } catch (e) {
        console.error('[dlSat] erro ao buscar status:', e.message);
    }
}

function dlRenderStatus(cur, tokenSuffix) {
    if (!cur) return;

    const badge   = document.getElementById('dlBadge');
    const meta    = document.getElementById('dlMeta');
    const wrap    = document.getElementById('dlProgressWrap');
    const bar     = document.getElementById('dlProgressBar');
    const label   = document.getElementById('dlProgressLabel');
    const count   = document.getElementById('dlProgressCount');
    const btnFull   = document.getElementById('dlBtnFull');
    const btnInc    = document.getElementById('dlBtnInc');
    const btnCancel = document.getElementById('dlBtnCancel');
    if (!badge) return;

    if (cur.running) {
        const modeLabel  = String(cur.mode || '').startsWith('custom:') ? cronTaskLabel(cur.mode) : cur.mode === 'full' ? 'Full' : cur.mode === 'full-anos' ? 'Full (por anos)' : cur.mode === 'fix-organizacao' ? 'Correção de organização' : cur.mode === 'fix-dados-relacionados' ? 'Correção de ações/clientes' : cur.mode === 'fix-autores-acoes' ? 'Correção de autores das ações' : cur.mode === 'backfill-basico' ? 'Backfill campos básicos' : cur.mode === 'atualizacao-inteligente' ? 'Atualização inteligente' : 'Incremental';
        const phaseLabel = cur.phase === 'fetching' ? 'Buscando na API…' : 'Salvando no banco…';
        badge.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;animation:spin 1s linear infinite">autorenew</span> ${modeLabel} em andamento`;
        badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#1e3a5f;color:#60a5fa;';

        // meta: mostra ano atual quando for carga por anos
        let metaParts = [];
        if (cur.currentYear) {
            const yearProgress = cur.yearsTotal > 1 ? ` (${cur.yearsDone + 1}/${cur.yearsTotal})` : '';
            metaParts.push(`Ano: ${cur.currentYear}${yearProgress}`);
        }
        metaParts.push(`Endpoint: ${cur.endpoint || '–'}`);
        metaParts.push(`Páginas: ${cur.pagesDone}`);
        metaParts.push(`Início: ${cur.startedAt ? new Date(cur.startedAt).toLocaleTimeString('pt-BR') : '–'}`);
        meta.textContent = metaParts.join(' · ');

        const pages = document.getElementById('dlProgressPages');
        wrap.style.display = 'block';
        label.textContent = phaseLabel;
        count.textContent = cur.ticketsDone.toLocaleString('pt-BR');
        if (pages) pages.textContent = `${cur.pagesDone} pág${cur.pagesDone !== 1 ? 's' : ''}· endpoint: ${cur.endpoint || '–'}`;

        // barra de progresso: por anos se selecionados, senão cíclica
        let pct = 0;
        if (cur.yearsTotal > 1) {
            pct = Math.min(99, ((cur.yearsDone / cur.yearsTotal) * 100));
        } else {
            pct = Math.min(99, (cur.ticketsDone % 10000) / 100);
        }
        bar.style.width = pct + '%';
        if (btnFull) {
            btnFull.disabled = true;
            btnFull.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">download_for_offline</span> Full agora';
        }
        if (btnInc) {
            btnInc.disabled = true;
            btnInc.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">update</span> Incremental agora';
        }
        if (btnCancel) {
            btnCancel.style.display = '';
            btnCancel.disabled = cur.cancelRequested || cur.phase === 'cancelling';
            btnCancel.innerHTML = cur.cancelRequested
                ? '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">hourglass_top</span> Cancelando…'
                : '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">stop_circle</span> Cancelar';
        }
    } else {
        const last = cur.lastResult;
        badge.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;">check_circle</span> Ocioso`;
        badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#27272a;color:#a1a1aa;';
        const tokenInfo = tokenSuffix ? ` · Token: ${tokenSuffix}` : '';
        if (last) {
            const finTime = cur.lastFinish ? new Date(cur.lastFinish).toLocaleString('pt-BR') : '–';
            const lastModeLabel = String(last.mode || '').startsWith('custom:') ? cronTaskLabel(last.mode) : last.mode === 'full' ? 'Full' : last.mode === 'full-anos' ? 'Full (anos)' : last.mode === 'fix-organizacao' ? 'Correção de organização' : last.mode === 'fix-dados-relacionados' ? 'Correção de ações/clientes' : last.mode === 'fix-autores-acoes' ? 'Correção de autores das ações' : last.mode === 'backfill-basico' ? 'Backfill campos básicos' : last.mode === 'atualizacao-inteligente' ? 'Atualização inteligente' : 'Incremental';
            meta.textContent = `Última: ${lastModeLabel} · ${last.tickets?.toLocaleString('pt-BR') || 0} tickets · ${finTime}${tokenInfo}`;
        } else {
            meta.textContent = (cur.errors?.length ? `Erro: ${cur.errors[0]}` : '–') + tokenInfo;
        }
        wrap.style.display = 'none';
        if (btnFull) {
            btnFull.disabled = false;
            btnFull.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">download_for_offline</span> Full agora';
        }
        if (btnInc) {
            btnInc.disabled = false;
            btnInc.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">update</span> Incremental agora';
        }
        if (btnCancel) { btnCancel.style.display = 'none'; btnCancel.disabled = false; }
    }
}

function dlRenderHistory(rows) {
    const el = document.getElementById('dlHistory');
    if (!el) return;
    if (!rows.length) {
        el.innerHTML = '<div style="color:var(--muted,#71717a);font-size:13px;">Nenhuma execução registrada.</div>';
        return;
    }
    const statusStyle = { done: 'color:#4ade80', running: 'color:#60a5fa', error: 'color:#f87171', cancelled: 'color:#a1a1aa' };
    const statusIcon  = { done: 'check_circle', running: 'autorenew', error: 'error', cancelled: 'stop_circle' };
    const modeLabel   = { full: 'Full', 'full-anos': 'Full (anos)', incremental: 'Incremental', 'fix-organizacao': 'Correção de organização', 'fix-dados-relacionados': 'Correção de ações/clientes', 'fix-autores-acoes': 'Correção de autores das ações', 'backfill-basico': 'Backfill campos básicos', 'atualizacao-inteligente': 'Atualização inteligente' };

    const filtroDe = (r) => {
        const partes = [];
        if (Array.isArray(r.years) && r.years.length) partes.push(`Ano: ${r.years.join(', ')}`);
        if (r.classification) partes.push(`Classificação: ${r.classification}`);
        if (r.owner_team) partes.push(`Equipe: ${r.owner_team}`);
        return partes.length ? partes.join(' · ') : 'Todos os tickets';
    };

    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
            <tr style="border-bottom:1px solid var(--border,#333);color:var(--muted,#71717a);text-align:left;">
                <th style="padding:6px 10px;">Tipo</th>
                <th style="padding:6px 10px;">Filtro</th>
                <th style="padding:6px 10px;">Início</th>
                <th style="padding:6px 10px;">Fim</th>
                <th style="padding:6px 10px;text-align:right;">Tickets</th>
                <th style="padding:6px 10px;">Status</th>
                <th style="padding:6px 10px;">Erro</th>
            </tr>
        </thead>
        <tbody>
        ${rows.map(r => {
            const st = r.status || 'running';
            const ini = r.started_at ? new Date(r.started_at).toLocaleString('pt-BR') : '–';
            const fin = r.finished_at ? new Date(r.finished_at).toLocaleString('pt-BR') : '–';
            const dur = (r.started_at && r.finished_at)
                ? (() => { const s = Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`; })()
                : '–';
            return `<tr style="border-bottom:1px solid var(--border,#222);">
                <td style="padding:8px 10px;font-weight:600;">${cfgEsc(modeLabel[r.mode] || cronTaskLabel(r.mode))}</td>
                <td style="padding:8px 10px;color:var(--muted,#71717a);font-size:12px;">${cfgEsc(filtroDe(r))}</td>
                <td style="padding:8px 10px;font-variant-numeric:tabular-nums;">${ini}</td>
                <td style="padding:8px 10px;font-variant-numeric:tabular-nums;">${fin} <span style="color:var(--muted,#71717a);font-size:11px;">(${dur})</span></td>
                <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;">${(r.tickets_loaded || 0).toLocaleString('pt-BR')}</td>
                <td style="padding:8px 10px;">
                    <span style="display:inline-flex;align-items:center;gap:4px;${statusStyle[st]||''}">
                        <span class="material-symbols-outlined" style="font-size:14px;">${statusIcon[st]||'help'}</span>
                        ${st}
                    </span>
                </td>
                <td style="padding:8px 10px;color:#f87171;font-size:12px;">${r.error_msg ? cfgEsc(r.error_msg).slice(0, 80) : ''}</td>
            </tr>`;
        }).join('')}
        </tbody>
    </table>`;
}

// ── Cargas automáticas (crons configuráveis) ────────────────────────────────
let _cronJobs = [];
const CRON_TASK_LABEL = {
    ouvidoria: 'Ouvidoria — em aberto',
    gcc: 'GCC — em aberto',
    geral: 'Painel Geral — ano vigente',
    incremental: 'Incremental — todos os tickets',
    full: 'Full — carga completa',
};
let _cronTasks = [];

// Tarefas padrão descritas no mesmo formato das personalizadas — espelham o
// que runOuvidoria/runGcc/runGeral/runIncremental fazem no loader, pra servir
// de referência e de ponto de partida ("Usar como base").
const CRON_BUILTIN_TASKS = [
    { key: 'ouvidoria', name: 'Ouvidoria — em aberto', owner_team: 'Ouvidoria', classification: 'Ouvidoria', only_open: true, recent_days: 3, year: null },
    { key: 'gcc', name: 'GCC — em aberto', owner_team: 'GCC - Gestão de Combate ao Churn', classification: 'Gestão de Combate ao Churn', only_open: true, recent_days: 3, year: null },
    { key: 'geral', name: 'Painel Geral — ano vigente', owner_team: null, classification: null, only_open: true, recent_days: 3, year: 'vigente' },
    { key: 'incremental', name: 'Incremental — todos os tickets', owner_team: null, classification: null, only_open: true, recent_days: 1, year: null, obs: 'janela real de 25h' },
    { key: 'full', name: 'Full — carga completa', owner_team: null, classification: null, only_open: false, recent_days: null, year: null, obs: 'anos/classificação/equipe definidos em cada cron', semBase: true },
];

function cronTaskLabel(task) {
    if (CRON_TASK_LABEL[task]) return CRON_TASK_LABEL[task];
    const m = /^custom:(\d+)$/.exec(String(task || ''));
    if (m) {
        const t = _cronTasks.find(x => x.id === Number(m[1]));
        return t ? `${t.name} (personalizada)` : 'Tarefa personalizada removida';
    }
    return task;
}

function cronTaskResumo(t) {
    const partes = [];
    if (t.owner_team) partes.push(`Equipe: ${t.owner_team}`);
    if (t.classification) partes.push(`Classificação: ${t.classification}`);
    if (t.year) partes.push(t.year === 'vigente' ? 'Ano vigente' : `Ano: ${t.year}`);
    if (t.only_open) partes.push('Só em aberto');
    if (t.recent_days) partes.push(`Atualizados nos últimos ${t.recent_days} dia(s)`);
    if (t.obs) partes.push(`(${t.obs})`);
    return partes.join(' · ') || '—';
}

// ref = 'builtin:<key>' ou 'custom:<id>'
function cronTaskFromRef(ref) {
    const [tipo, v] = String(ref || '').split(':');
    if (tipo === 'builtin') return CRON_BUILTIN_TASKS.find(t => t.key === v) || null;
    if (tipo === 'custom') return _cronTasks.find(t => t.id === Number(v)) || null;
    return null;
}

// Início local de quem acabou de clicar em "Rodar agora" — até o servidor
// abrir o registro da execução (running_started_at), a conta parte daqui.
const _cronLocalStart = {};

function cronFmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// "~4 min restantes · término ~17:05", a partir da média das últimas execuções.
function cronEstimativa(j) {
    const avg = Number(j.avg_sec);
    if (!avg || !isFinite(avg)) return 'sem estimativa (primeira execução)';
    const inicio = j.running_started_at ? new Date(j.running_started_at).getTime() : (_cronLocalStart[j.id] || Date.now());
    const decorrido = (Date.now() - inicio) / 1000;
    const restante = avg - decorrido;
    const media = `média de ${cronFmtDur(avg)}${j.n_amostras ? ` em ${j.n_amostras} execuç${j.n_amostras === 1 ? 'ão' : 'ões'}` : ''}`;
    if (restante <= 0) return `passou da média (${cronFmtDur(decorrido)} rodando · ${media})`;
    const fim = new Date(Date.now() + restante * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `~${cronFmtDur(restante)} restantes · término ~${fim}`;
}

function cronFmtInterval(minutes) {
    const m = Number(minutes) || 0;
    if (m >= 1440 && m % 1440 === 0) return m === 1440 ? '1x por dia' : (m === 10080 ? '1x por semana' : `A cada ${m / 1440} dias`);
    if (m >= 60 && m % 60 === 0) return m === 60 ? 'A cada 1 hora' : `A cada ${m / 60} horas`;
    return `A cada ${m} min`;
}

const CRON_DIAS_NOME = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function cronFmtSchedule(s) {
    if (!s) return '';
    const p = [];
    if (Array.isArray(s.dias) && s.dias.length) {
        const d = s.dias;
        const seq = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
        p.push(seq && d.length > 2 ? `${CRON_DIAS_NOME[d[0]]}–${CRON_DIAS_NOME[d[d.length - 1]]}` : d.map(x => CRON_DIAS_NOME[x]).join(', '));
    }
    if (s.inicio && s.fim) p.push(`${s.inicio}–${s.fim}`);
    if (s.anchor) p.push(`alinhada às ${s.anchor}`);
    return p.join(' · ');
}

// Intervalo "Personalizado…": mostra/oculta a linha de quantidade + unidade.
function cronToggleCustomInterval() {
    const custom = document.getElementById('cronInterval').value === 'custom';
    const row = document.getElementById('cronCustomRow');
    if (row) row.style.display = custom ? '' : 'none';
}
function cronSetIntervalControls(minutes) {
    const sel = document.getElementById('cronInterval');
    const preset = [...sel.options].some(o => o.value === String(minutes) && o.value !== 'custom');
    if (preset) { sel.value = String(minutes); }
    else {
        sel.value = 'custom';
        const m = Number(minutes) || 60;
        const un = (m >= 1440 && m % 1440 === 0) ? 1440 : (m >= 60 && m % 60 === 0 ? 60 : 1);
        document.getElementById('cronCustomUnidade').value = String(un);
        document.getElementById('cronCustomValor').value = String(m / un);
    }
    cronToggleCustomInterval();
}
function cronReadIntervalMinutes() {
    const v = document.getElementById('cronInterval').value;
    if (v !== 'custom') return Number(v);
    return Math.round(Number(document.getElementById('cronCustomValor').value) * Number(document.getElementById('cronCustomUnidade').value));
}
function cronReadSchedule() {
    const dias = [...document.querySelectorAll('#cronDias input:checked')].map(i => Number(i.value));
    return {
        inicio: document.getElementById('cronJanelaInicio').value || null,
        fim: document.getElementById('cronJanelaFim').value || null,
        anchor: document.getElementById('cronAncora').value || null,
        dias,
    };
}
function cronWriteSchedule(s) {
    s = s || {};
    document.getElementById('cronJanelaInicio').value = s.inicio || '';
    document.getElementById('cronJanelaFim').value = s.fim || '';
    document.getElementById('cronAncora').value = s.anchor || '';
    document.querySelectorAll('#cronDias input').forEach(i => { i.checked = Array.isArray(s.dias) && s.dias.includes(Number(i.value)); });
    document.getElementById('cronHorarioBox').open = !!(s.inicio || s.anchor || (s.dias && s.dias.length));
    document.getElementById('cronHorarioResumo').textContent = cronFmtSchedule(s) ? `— ${cronFmtSchedule(s)}` : '';
}

async function cronLoad() {
    const el = document.getElementById('cronList');
    if (!el) return;
    try {
        const [resp, respTasks] = await Promise.all([
            fetch(`${API_BASE}/crons`, { headers: authHeaders() }),
            fetch(`${API_BASE}/crons/tasks`, { headers: authHeaders() }),
        ]);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        const dataTasks = await respTasks.json().catch(() => ({}));
        _cronTasks = respTasks.ok ? (dataTasks.tasks || []) : [];
        _cronJobs = data.jobs || [];
        cronRenderTasks();
        cronRenderList();
    } catch (e) {
        el.innerHTML = `<div style="color:#f87171;font-size:13px;">Erro ao carregar: ${cfgEsc(e.message)}</div>`;
    }
}

function cronRenderList() {
    const el = document.getElementById('cronList');
    if (!el) return;
    if (!_cronJobs.length) {
        el.innerHTML = '<div style="color:var(--muted,#71717a);font-size:13px;">Nenhuma cron cadastrada ainda.</div>';
        return;
    }
    const statusStyle = { done: 'color:#4ade80', error: 'color:#f87171', running: 'color:#60a5fa', queued: 'color:#fbbf24', cancelled: 'color:#a1a1aa' };
    const statusIcon  = { done: 'check_circle', error: 'error', running: 'sync', queued: 'hourglass_top', cancelled: 'stop_circle' };

    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
            <tr style="border-bottom:1px solid var(--border,#333);color:var(--muted,#71717a);text-align:left;">
                <th style="padding:6px 10px;">Nome</th>
                <th style="padding:6px 10px;">Tarefa</th>
                <th style="padding:6px 10px;">Intervalo</th>
                <th style="padding:6px 10px;">Última execução</th>
                <th style="padding:6px 10px;">Ativa</th>
                <th style="padding:6px 10px;"></th>
            </tr>
        </thead>
        <tbody>
        ${_cronJobs.map(j => {
            const st = j.last_status;
            const queued = st === 'queued';
            const running = st === 'running' || queued;
            const last = j.last_run_at ? new Date(j.last_run_at).toLocaleString('pt-BR') : 'Nunca rodou';
            const spin = running ? 'animation:spin 1s linear infinite;' : '';
            const statusBadge = st
                ? `<span style="display:inline-flex;align-items:center;gap:4px;${statusStyle[st] || ''}">
                     <span class="material-symbols-outlined" style="font-size:13px;${spin}">${statusIcon[st] || 'help'}</span>
                   </span>`
                : '';
            const lastLabel = queued
                ? `Na fila… <span style="color:var(--muted,#71717a);font-size:11.5px;">aguardando outra carga terminar</span>`
                : running
                ? `Executando... <span style="color:var(--muted,#71717a);font-size:11.5px;" title="Estimativa pela duração média das últimas execuções">${cfgEsc(cronEstimativa(j))}</span>`
                : last;
            return `<tr style="border-bottom:1px solid var(--border,#222);">
                <td style="padding:8px 10px;font-weight:600;">${cfgEsc(j.name)}</td>
                <td style="padding:8px 10px;">${cfgEsc(cronTaskLabel(j.task))}</td>
                <td style="padding:8px 10px;">${cronFmtInterval(j.interval_minutes)}${cronFmtSchedule(j.params && j.params.schedule) ? `<div style="color:var(--muted,#71717a);font-size:11.5px;">${cfgEsc(cronFmtSchedule(j.params.schedule))}</div>` : ''}</td>
                <td style="padding:8px 10px;font-variant-numeric:tabular-nums;">${statusBadge} ${lastLabel}${(!running && j.last_error) ? `<div style="color:#f87171;font-size:11px;margin-top:3px;max-width:420px;white-space:normal;line-height:1.35;" title="${cfgEsc(j.last_error)}">${cfgEsc(j.last_error.length > 160 ? j.last_error.slice(0, 158) + '…' : j.last_error)}</div>` : ''}</td>
                <td style="padding:8px 10px;">
                    <label style="display:inline-flex;align-items:center;cursor:pointer;">
                        <input type="checkbox" ${j.enabled ? 'checked' : ''} onchange="cronToggleEnabled(${j.id}, this.checked)">
                    </label>
                </td>
                <td style="padding:8px 10px;white-space:nowrap;">
                    <button class="config-btn config-btn-muted" style="padding:4px 8px;font-size:11.5px;" onclick="cronRunNow(${j.id})" title="${running ? 'Executando...' : 'Rodar agora'}" ${running ? 'disabled' : ''}>
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;${spin}">${running ? 'sync' : 'play_arrow'}</span>
                    </button>
                    ${running ? `<button class="config-btn config-btn-muted" style="padding:4px 8px;font-size:11.5px;color:#f87171;border-color:rgba(248,113,113,.4);" onclick="cronStop(${j.id})" title="Parar execução">
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">stop</span>
                    </button>` : ''}
                    <button class="config-btn config-btn-muted" style="padding:4px 8px;font-size:11.5px;" onclick="cronOpenRuns(${j.id},'${cfgEsc(j.name).replace(/'/g,"\\'")}')" title="Ver histórico de execuções">
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">history</span>
                    </button>
                    <button class="config-btn config-btn-muted" style="padding:4px 8px;font-size:11.5px;" onclick="cronOpenModal(${j.id})" title="Editar">
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">edit</span>
                    </button>
                    <button class="config-btn config-btn-danger" style="padding:4px 8px;font-size:11.5px;" onclick="cronDelete(${j.id})" title="Excluir">
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">delete</span>
                    </button>
                </td>
            </tr>`;
        }).join('')}
        </tbody>
    </table>`;

    const anyRunning = _cronJobs.some(j => j.last_status === 'running' || j.last_status === 'queued');
    if (anyRunning) cronSchedulePoll();
}

let _cronPollTimer = null;
function cronSchedulePoll() {
    if (_cronPollTimer) return;
    _cronPollTimer = setTimeout(() => {
        _cronPollTimer = null;
        cronLoad();
    }, 2000);
}

function cronToggleFullFields() {
    const task = document.getElementById('cronTask')?.value;
    const wrap = document.getElementById('cronFullFields');
    if (wrap) wrap.style.display = task === 'full' ? 'flex' : 'none';
}

function cronOpenModal(jobId) {
    const modal = document.getElementById('cronModal');
    const errorEl = document.getElementById('cronModalError');
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

    const job = jobId ? _cronJobs.find(j => j.id === jobId) : null;
    document.getElementById('cronModalTitle').textContent = job ? 'Editar cron automática' : 'Nova cron automática';
    document.getElementById('cronId').value = job ? job.id : '';
    document.getElementById('cronName').value = job ? job.name : '';
    document.getElementById('cronTask').value = job ? job.task : 'ouvidoria';
    cronSetIntervalControls(job ? job.interval_minutes : 120);
    cronWriteSchedule(job && job.params ? job.params.schedule : null);
    document.getElementById('cronEnabled').checked = job ? !!job.enabled : true;
    const params = job?.params || {};
    document.getElementById('cronFullYears').value = Array.isArray(params.years) ? params.years.join(', ') : '';
    document.getElementById('cronFullClass').value = params.classification || '';
    document.getElementById('cronFullTeam').value = params.ownerTeam || '';
    cronToggleFullFields();

    if (modal) modal.style.display = 'flex';
}

function cronCloseModal() {
    const modal = document.getElementById('cronModal');
    if (modal) modal.style.display = 'none';
}

async function cronSave() {
    const errorEl = document.getElementById('cronModalError');
    const showError = (msg) => { if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; } };

    const id = document.getElementById('cronId').value;
    const name = document.getElementById('cronName').value.trim();
    const task = document.getElementById('cronTask').value;
    const interval_minutes = cronReadIntervalMinutes();
    const enabled = document.getElementById('cronEnabled').checked;

    if (!name) return showError('Preencha o nome.');
    if (!Number.isFinite(interval_minutes) || interval_minutes < 1) return showError('O intervalo mínimo é 1 minuto.');
    if (interval_minutes > 24 * 24 * 60) return showError('O intervalo máximo é 24 dias.');
    const sch = cronReadSchedule();
    if ((sch.inicio && !sch.fim) || (!sch.inicio && sch.fim)) return showError('Informe o início e o fim da janela de horário (ou deixe os dois vazios).');

    let params = {};
    if (task === 'full') {
        const yearsRaw = document.getElementById('cronFullYears').value.trim();
        params = {
            years: yearsRaw ? yearsRaw.split(',').map(s => Number(s.trim())).filter(Boolean) : [],
            classification: document.getElementById('cronFullClass').value.trim(),
            ownerTeam: document.getElementById('cronFullTeam').value.trim(),
        };
    }

    // Regras de horário valem para qualquer tarefa (as de carga completa guardam também os próprios filtros).
    params.schedule = sch;
    const body = JSON.stringify({ name, task, interval_minutes, enabled, params });
    try {
        const resp = await fetch(id ? `${API_BASE}/crons/${id}` : `${API_BASE}/crons`, {
            method: id ? 'PATCH' : 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        cronCloseModal();
        cronLoad();
    } catch (e) {
        showError(e.message);
    }
}

async function cronToggleEnabled(id, enabled) {
    try {
        const resp = await fetch(`${API_BASE}/crons/${id}`, {
            method: 'PATCH',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || `HTTP ${resp.status}`); }
        cronLoad();
    } catch (e) {
        alert(`Não foi possível atualizar: ${e.message}`);
        cronLoad();
    }
}

async function cronDelete(id) {
    const job = _cronJobs.find(j => j.id === id);
    if (!confirm(`Excluir a cron "${job?.name || id}"? Essa ação não pode ser desfeita.`)) return;
    try {
        const resp = await fetch(`${API_BASE}/crons/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || `HTTP ${resp.status}`); }
        cronLoad();
    } catch (e) {
        alert(`Não foi possível excluir: ${e.message}`);
    }
}

// Correção pontual: re-sincroniza por id os tickets em aberto com ação
// pública sem autor. Andamento aparece no painel de status de carga.
async function runFixAutoresAcoes() {
    if (!confirm('Buscar de novo na API os tickets em aberto com ações sem autor? Pode levar de alguns minutos a meia hora.')) return;
    try {
        const resp = await fetch(`${API_BASE}/loader/fix-autores-acoes`, { method: 'POST', headers: authHeaders() });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        alert('Correção iniciada. Acompanhe o andamento no status da carga, nesta tela.');
    } catch (e) {
        alert(`Não foi possível iniciar: ${e.message}`);
    }
}

async function cronStop(id) {
    const job = _cronJobs.find(j => j.id === id);
    if (!confirm(`Parar a execução de "${job?.name || 'cron'}"? O que já foi salvo fica no banco.`)) return;
    try {
        const resp = await fetch(`${API_BASE}/crons/${id}/stop`, { method: 'POST', headers: authHeaders() });
        const d = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(d.error || `HTTP ${resp.status}`);
        // 'cancelling' termina no próximo ponto de checagem da carga — o polling
        // atualiza a linha quando o loader liberar.
        if (d.action !== 'cancelling' && job) { job.last_status = 'cancelled'; job.last_error = 'Parado manualmente'; }
        cronRenderList();
        cronSchedulePoll();
        setTimeout(cronLoad, 1500);
    } catch (e) {
        alert(`Não foi possível parar: ${e.message}`);
    }
}

async function cronRunNow(id) {
    try {
        const resp = await fetch(`${API_BASE}/crons/${id}/run`, { method: 'POST', headers: authHeaders() });
        if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || `HTTP ${resp.status}`); }
        const d = await resp.json().catch(() => ({}));
        const job = _cronJobs.find(j => j.id === id);
        if (job) { job.last_status = d.queued ? 'queued' : 'running'; job.running_started_at = null; }
        _cronLocalStart[id] = Date.now();
        cronRenderList();
        cronSchedulePoll();
    } catch (e) {
        alert(`Não foi possível iniciar: ${e.message}`);
    }
}

// ── Tarefas personalizadas ──────────────────────────────────────────────
function cronRenderTasks() {
    const group = document.getElementById('cronTaskCustomGroup');
    if (group) {
        group.innerHTML = _cronTasks.map(t => `<option value="custom:${t.id}">${cfgEsc(t.name)}</option>`).join('');
        group.style.display = _cronTasks.length ? '' : 'none';
    }
    const el = document.getElementById('cronTaskList');
    if (!el) return;
    const usos = {};
    _cronJobs.forEach(j => { usos[j.task] = (usos[j.task] || 0) + 1; });
    const btnBase = (ref) => `<button class="config-btn config-btn-muted" style="padding:4px 8px;font-size:11.5px;" onclick="cronTaskOpenModal(null,'${ref}')" title="Usar como base pra uma nova tarefa">
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">content_copy</span>
                    </button>`;
    const usadaPor = (n) => n ? `${n} cron${n === 1 ? '' : 's'}` : '—';
    const linhasPadrao = CRON_BUILTIN_TASKS.map(t => `<tr style="border-bottom:1px solid var(--border,#222);">
                <td style="padding:8px 10px;font-weight:600;">${cfgEsc(t.name)} <span style="font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:10px;background:rgba(148,163,184,.15);color:var(--muted,#94a3b8);margin-left:4px;">Padrão</span></td>
                <td style="padding:8px 10px;">${cfgEsc(cronTaskResumo(t))}</td>
                <td style="padding:8px 10px;">${usadaPor(usos[t.key] || 0)}</td>
                <td style="padding:8px 10px;white-space:nowrap;">${t.semBase ? '' : btnBase(`builtin:${t.key}`)}</td>
            </tr>`).join('');
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
            <tr style="border-bottom:1px solid var(--border,#333);color:var(--muted,#71717a);text-align:left;">
                <th style="padding:6px 10px;">Nome</th>
                <th style="padding:6px 10px;">Filtros</th>
                <th style="padding:6px 10px;">Usada por</th>
                <th style="padding:6px 10px;"></th>
            </tr>
        </thead>
        <tbody>
        ${linhasPadrao}
        ${_cronTasks.map(t => {
            const n = usos[`custom:${t.id}`] || 0;
            return `<tr style="border-bottom:1px solid var(--border,#222);">
                <td style="padding:8px 10px;font-weight:600;">${cfgEsc(t.name)}</td>
                <td style="padding:8px 10px;">${cfgEsc(cronTaskResumo(t))}</td>
                <td style="padding:8px 10px;">${usadaPor(n)}</td>
                <td style="padding:8px 10px;white-space:nowrap;">
                    ${btnBase(`custom:${t.id}`)}
                    <button class="config-btn config-btn-muted" style="padding:4px 8px;font-size:11.5px;" onclick="cronTaskOpenModal(${t.id})" title="Editar">
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">edit</span>
                    </button>
                    <button class="config-btn config-btn-danger" style="padding:4px 8px;font-size:11.5px;" onclick="cronTaskDelete(${t.id})" title="Excluir">
                        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">delete</span>
                    </button>
                </td>
            </tr>`;
        }).join('')}
        </tbody>
    </table>`;
}

// Opções dos selects (equipes/classificações/anos) vêm do banco via
// /crons/task-options; carregadas uma vez por abertura da tela.
let _cronTaskOptions = null;
async function cronTaskLoadOptions() {
    if (_cronTaskOptions) return _cronTaskOptions;
    try {
        const resp = await fetch(`${API_BASE}/crons/task-options`, { headers: authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        _cronTaskOptions = data;
    } catch (e) {
        console.warn('Opções de tarefa indisponíveis:', e.message);
        _cronTaskOptions = { teams: [], classifications: [], years: [] };
    }
    return _cronTaskOptions;
}

function cronTaskFillSelect(id, emptyLabel, values, fmt = v => v) {
    const sel = document.getElementById(id);
    sel.innerHTML = `<option value="">${cfgEsc(emptyLabel)}</option>`
        + values.map(v => `<option value="${cfgEsc(v)}">${cfgEsc(fmt(v))}</option>`).join('');
}

// Seleciona o valor; se não estiver na lista (ex.: equipe renomeada), inclui.
function cronTaskSetSelect(id, value, fmt = v => v) {
    const sel = document.getElementById(id);
    const v = value == null ? '' : String(value);
    if (v && ![...sel.options].some(o => o.value === v)) {
        sel.insertAdjacentHTML('beforeend', `<option value="${cfgEsc(v)}">${cfgEsc(fmt(v))}</option>`);
    }
    sel.value = v;
}

function cronTaskFillFields(t) {
    cronTaskSetSelect('cronTaskTeam', t?.owner_team || '');
    cronTaskSetSelect('cronTaskClass', t?.classification || '');
    cronTaskSetSelect('cronTaskYear', t?.year === 'vigente' ? new Date().getFullYear() : (t?.year || ''));
    cronTaskSetSelect('cronTaskDays', t?.recent_days || '', v => `Últimos ${v} dias`);
    document.getElementById('cronTaskOpen').checked = !!t?.only_open;
    const rp = document.getElementById('cronTaskRapido'); if (rp) rp.checked = !!t?.rapido;
}

// Preenche os filtros a partir de uma tarefa existente (padrão ou
// personalizada). Não mexe no nome se o usuário já digitou um.
function cronTaskApplyBase(ref) {
    const base = cronTaskFromRef(ref);
    if (!base) return;
    cronTaskFillFields(base);
    const nomeEl = document.getElementById('cronTaskName');
    if (!nomeEl.value.trim()) nomeEl.value = `${base.name} (cópia)`;
}

async function cronTaskOpenModal(taskId, baseRef) {
    const t = taskId ? _cronTasks.find(x => x.id === taskId) : null;
    const opts = await cronTaskLoadOptions();
    cronTaskFillSelect('cronTaskTeam', '— qualquer equipe —', opts.teams || []);
    cronTaskFillSelect('cronTaskClass', '— qualquer classificação —', opts.classifications || []);
    cronTaskFillSelect('cronTaskYear', '— todos os anos —', (opts.years || []).map(String));
    const errorEl = document.getElementById('cronTaskModalError');
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
    document.getElementById('cronTaskModalTitle').textContent = t ? 'Editar tarefa' : 'Nova tarefa';
    document.getElementById('cronTaskId').value = t ? t.id : '';
    document.getElementById('cronTaskName').value = t?.name || '';
    cronTaskFillFields(t);

    const baseSel = document.getElementById('cronTaskBase');
    document.getElementById('cronTaskBaseField').style.display = t ? 'none' : '';
    baseSel.innerHTML = '<option value="">— em branco —</option>'
        + '<optgroup label="Tarefas padrão">'
        + CRON_BUILTIN_TASKS.filter(b => !b.semBase).map(b => `<option value="builtin:${b.key}">${cfgEsc(b.name)}</option>`).join('')
        + '</optgroup>'
        + (_cronTasks.length ? '<optgroup label="Tarefas personalizadas">'
            + _cronTasks.map(c => `<option value="custom:${c.id}">${cfgEsc(c.name)}</option>`).join('')
            + '</optgroup>' : '');
    baseSel.value = '';
    if (!t && baseRef) { baseSel.value = baseRef; cronTaskApplyBase(baseRef); }

    document.getElementById('cronTaskModal').style.display = 'flex';
}

function cronTaskCloseModal() {
    document.getElementById('cronTaskModal').style.display = 'none';
}

async function cronTaskSave() {
    const errorEl = document.getElementById('cronTaskModalError');
    const showError = (msg) => { errorEl.textContent = msg; errorEl.style.display = 'block'; };
    const id = document.getElementById('cronTaskId').value;
    const body = {
        name: document.getElementById('cronTaskName').value.trim(),
        owner_team: document.getElementById('cronTaskTeam').value.trim(),
        classification: document.getElementById('cronTaskClass').value.trim(),
        year: document.getElementById('cronTaskYear').value,
        recent_days: document.getElementById('cronTaskDays').value,
        only_open: document.getElementById('cronTaskOpen').checked,
        rapido: !!document.getElementById('cronTaskRapido')?.checked,
    };
    if (!body.name) return showError('Preencha o nome.');
    if (!body.owner_team && !body.classification && !body.year && !body.recent_days && !body.only_open) {
        return showError('Defina ao menos um filtro: equipe, classificação, ano, "só em aberto" ou últimos N dias.');
    }
    try {
        const resp = await fetch(id ? `${API_BASE}/crons/tasks/${id}` : `${API_BASE}/crons/tasks`, {
            method: id ? 'PATCH' : 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        cronTaskCloseModal();
        cronLoad();
    } catch (e) {
        showError(e.message);
    }
}

async function cronTaskDelete(id) {
    const t = _cronTasks.find(x => x.id === id);
    if (!confirm(`Excluir a tarefa "${t?.name || id}"? Essa ação não pode ser desfeita.`)) return;
    try {
        const resp = await fetch(`${API_BASE}/crons/tasks/${id}`, { method: 'DELETE', headers: authHeaders() });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        cronLoad();
    } catch (e) {
        alert(`Não foi possível excluir: ${e.message}`);
    }
}

document.getElementById('cronTaskModalClose')?.addEventListener('click', cronTaskCloseModal);
document.getElementById('cronTaskModal')?.addEventListener('click', (e) => { if (e.target.id === 'cronTaskModal') cronTaskCloseModal(); });

// ── Histórico de execuções (log de cargas) ──────────────────────────────
const CRON_RUN_STATUS_LABEL = { done: 'Concluída', error: 'Erro', running: 'Executando', cancelled: 'Cancelada' };
const CRON_RUN_STATUS_COLOR = { done: '#4ade80', error: '#f87171', running: '#60a5fa', cancelled: '#fbbf24' };
const CHANGE_FIELD_LABELS_FALLBACK = {}; // rótulos já vêm prontos do backend (changed_fields[campo].label)

function cronFmtDateTime(v) {
    return v ? new Date(v).toLocaleString('pt-BR') : '—';
}

async function cronOpenRuns(jobId, jobName) {
    const modal = document.getElementById('cronRunsModal');
    document.getElementById('cronRunsModalTitle').textContent = `Histórico — ${jobName || ''}`;
    const el = document.getElementById('cronRunsList');
    el.innerHTML = '<div style="color:var(--muted,#71717a);font-size:13px;">Carregando…</div>';
    if (modal) modal.style.display = 'flex';
    try {
        const resp = await fetch(`${API_BASE}/crons/${jobId}/runs`, { headers: authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        cronRenderRuns(data.runs || []);
    } catch (e) {
        el.innerHTML = `<div style="color:#f87171;font-size:13px;">Erro ao carregar: ${cfgEsc(e.message)}</div>`;
    }
}

function cronRenderRuns(runs) {
    const el = document.getElementById('cronRunsList');
    if (!runs.length) {
        el.innerHTML = '<div style="color:var(--muted,#71717a);font-size:13px;">Essa cron ainda não rodou nenhuma vez.</div>';
        return;
    }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
            <tr style="border-bottom:1px solid var(--border,#333);color:var(--muted,#71717a);text-align:left;">
                <th style="padding:6px 8px;">Início</th>
                <th style="padding:6px 8px;">Status</th>
                <th style="padding:6px 8px;">Trouxe</th>
                <th style="padding:6px 8px;">Novos</th>
                <th style="padding:6px 8px;">Alterados</th>
                <th style="padding:6px 8px;"></th>
            </tr>
        </thead>
        <tbody>
        ${runs.map(r => `
            <tr style="border-bottom:1px solid var(--border,#222);${r.status !== 'running' ? 'cursor:pointer;' : ''}" ${r.status !== 'running' ? `onclick="cronOpenRunChanges(${r.id})"` : ''}>
                <td style="padding:8px;font-variant-numeric:tabular-nums;">${cfgEsc(cronFmtDateTime(r.started_at))}</td>
                <td style="padding:8px;color:${CRON_RUN_STATUS_COLOR[r.status] || '#a1a1aa'};">${cfgEsc(CRON_RUN_STATUS_LABEL[r.status] || r.status)}${r.error_msg ? ` <span title="${cfgEsc(r.error_msg)}" style="font-size:11px;">(?)</span>` : ''}</td>
                <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${r.tickets_loaded ?? 0}</td>
                <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${r.tickets_created ?? 0}</td>
                <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums;">${r.tickets_updated ?? 0}</td>
                <td style="padding:8px;">${r.status !== 'running' ? '<span class="material-symbols-outlined" style="font-size:14px;">chevron_right</span>' : ''}</td>
            </tr>`).join('')}
        </tbody>
    </table>`;
}

function cronCloseRunsModal() {
    const modal = document.getElementById('cronRunsModal');
    if (modal) modal.style.display = 'none';
}

let _cronChangesRunId = null;

async function cronOpenRunChanges(runId) {
    _cronChangesRunId = runId;
    const btnExp = document.getElementById('cronChangesExport');
    if (btnExp) btnExp.disabled = true;
    const modal = document.getElementById('cronChangesModal');
    const el = document.getElementById('cronChangesList');
    const summaryEl = document.getElementById('cronChangesSummary');
    el.innerHTML = '<div style="color:var(--muted,#71717a);font-size:13px;">Carregando…</div>';
    summaryEl.textContent = '';
    if (modal) modal.style.display = 'flex';
    try {
        const resp = await fetch(`${API_BASE}/crons/runs/${runId}/changes`, { headers: authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        const run = data.run || {};
        document.getElementById('cronChangesModalTitle').textContent = `Execução de ${cronFmtDateTime(run.started_at)}`;
        summaryEl.textContent = `Trouxe ${run.tickets_loaded ?? 0} chamado(s) — ${run.tickets_created ?? 0} novo(s), ${run.tickets_updated ?? 0} alterado(s).`;
        cronRenderChanges(data.changes || []);
        if (btnExp) btnExp.disabled = false;
    } catch (e) {
        el.innerHTML = `<div style="color:#f87171;font-size:13px;">Erro ao carregar: ${cfgEsc(e.message)}</div>`;
    }
}

function cronRenderChanges(changes) {
    const el = document.getElementById('cronChangesList');
    if (!changes.length) {
        el.innerHTML = '<div style="color:var(--muted,#71717a);font-size:13px;">Nada mudou nos chamados dessa execução (só reconfirmou o que já estava salvo).</div>';
        return;
    }
    el.innerHTML = changes.map(c => {
        const fields = c.changed_fields || {};
        const fieldRows = Object.values(fields).map(f => `
            <div style="display:flex;gap:8px;font-size:12px;padding:3px 0;">
                <span style="color:var(--muted,#71717a);min-width:140px;">${cfgEsc(f.label || '')}</span>
                <span style="color:#f87171;text-decoration:line-through;opacity:.8;">${cfgEsc(f.antes ?? '—')}</span>
                <span class="material-symbols-outlined" style="font-size:13px;color:var(--muted,#71717a);">arrow_forward</span>
                <span style="color:#4ade80;">${cfgEsc(f.depois ?? '—')}</span>
            </div>`).join('');
        return `<div style="border-bottom:1px solid var(--border,#222);padding:8px 0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span style="font-weight:600;font-size:13px;">Chamado #${cfgEsc(c.ticket_id)}</span>
                <span style="font-size:11px;padding:1px 8px;border-radius:10px;background:${c.change_type === 'created' ? 'rgba(74,222,128,.15);color:#4ade80' : 'rgba(96,165,250,.15);color:#60a5fa'};">${c.change_type === 'created' ? 'Novo' : 'Alterado'}</span>
            </div>
            ${fieldRows || '<div style="font-size:12px;color:var(--muted,#71717a);">Sem detalhe de campos.</div>'}
        </div>`;
    }).join('');
}

// Exporta o log da execução aberta: uma linha por campo alterado (chamado, tipo,
// campo, antes, depois). Busca de novo sem o limite da tela (que mostra só 500).
async function cronExportRunChanges() {
    const runId = _cronChangesRunId;
    const btn = document.getElementById('cronChangesExport');
    if (!runId || !btn) return;
    const htmlOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Gerando…';
    try {
        const resp = await fetch(`${API_BASE}/crons/runs/${runId}/changes?limit=100000`, { headers: authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        const run = data.run || {};
        const q = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
        const linhas = [['Execução', 'Chamado', 'Tipo', 'Campo', 'Antes', 'Depois'].map(q).join(';')];
        for (const c of (data.changes || [])) {
            const tipo = c.change_type === 'created' ? 'Novo' : 'Alterado';
            const campos = Object.values(c.changed_fields || {});
            if (!campos.length) {
                linhas.push([cronFmtDateTime(run.started_at), c.ticket_id, tipo, '', '', ''].map(q).join(';'));
                continue;
            }
            for (const f of campos) {
                linhas.push([cronFmtDateTime(run.started_at), c.ticket_id, tipo, f.label || '', f.antes ?? '', f.depois ?? ''].map(q).join(';'));
            }
        }
        const blob = new Blob(['\ufeffsep=;\r\n' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `log-execucao-${runId}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
        alert('Erro ao exportar: ' + e.message);
    } finally {
        btn.innerHTML = htmlOriginal;
        btn.disabled = false;
    }
}

function cronCloseChangesModal() {
    const modal = document.getElementById('cronChangesModal');
    if (modal) modal.style.display = 'none';
}

document.getElementById('cronRunsModalClose')?.addEventListener('click', cronCloseRunsModal);
document.getElementById('cronRunsModal')?.addEventListener('click', (e) => { if (e.target.id === 'cronRunsModal') cronCloseRunsModal(); });
document.getElementById('cronChangesExport')?.addEventListener('click', cronExportRunChanges);
document.getElementById('cronChangesModalClose')?.addEventListener('click', cronCloseChangesModal);
document.getElementById('cronChangesModal')?.addEventListener('click', (e) => { if (e.target.id === 'cronChangesModal') cronCloseChangesModal(); });

document.getElementById('cronModalClose')?.addEventListener('click', cronCloseModal);
document.getElementById('cronModal')?.addEventListener('click', (e) => { if (e.target.id === 'cronModal') cronCloseModal(); });

// Animação de rotação para o ícone de loading
if (!document.getElementById('dlSpinStyle')) {
    const s = document.createElement('style');
    s.id = 'dlSpinStyle';
    s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
}


document.getElementById('cronInterval')?.addEventListener('change', cronToggleCustomInterval);

// ─── Assistente de IA: parâmetros da IA nos chamados e nos incidentes ──────────────────────
// A tela é montada a partir deste esquema; o servidor valida tudo de novo (utils/aiSettings.js).
const AIA_CRIAT = { t: 'seg', k: 'criatividade', label: 'Estilo da resposta', help: 'Mais fiel segue os dados à risca; mais criativo varia o texto.', opts: [['baixa', 'Mais fiel'], ['media', 'Equilibrado'], ['alta', 'Mais criativo']] };
const AIA_EXTRA = { t: 'txt', k: 'instrucaoExtra', label: 'Orientação extra (opcional)', help: 'Uma regra sua para esta função. Ex.: "sempre confirme a versão do sistema antes de orientar".', max: 800 };
const AIA_SECOES = [
    { grupo: 'Chamados', icone: 'confirmation_number', itens: [
        { sec: 'resposta', icone: 'edit_note', titulo: 'Sugestão de resposta', desc: 'Rascunho da próxima resposta ao cliente, a partir da conversa do chamado.', campos: [
            { t: 'seg', k: 'tomPadrao', label: 'Tom inicial', help: 'O atendente ainda pode trocar o tom na hora.', opts: [['padrao', 'Padrão'], ['empatico', 'Empático'], ['objetivo', 'Objetivo']] },
            { t: 'seg', k: 'tamanho', label: 'Tamanho da resposta', help: 'Respostas longas gastam mais tokens.', opts: [['curta', 'Curta'], ['media', 'Média'], ['longa', 'Longa']] },
            AIA_CRIAT,
            { t: 'num', k: 'maxPerguntas', label: 'Pedidos de informação', help: 'Quantas informações a IA pode pedir ao cliente. 0 = nunca pedir.', min: 0, max: 6, unit: 'no máx.' },
            { t: 'num', k: 'contextoCaracteres', label: 'Quanto da conversa ler', help: 'A 1ª mensagem e as mais recentes que couberem neste tamanho.', min: 3000, max: 30000, step: 1000, unit: 'caracteres' },
            AIA_EXTRA] },
        { sec: 'corrigir', icone: 'spellcheck', titulo: 'Correção de texto', desc: 'Corrige ortografia, acentuação e pontuação sem mudar o que foi escrito.', campos: [
            { t: 'num', k: 'maxCaracteres', label: 'Tamanho máximo do texto', help: 'Textos maiores são recusados antes de gastar IA.', min: 500, max: 12000, step: 500, unit: 'caracteres' },
            AIA_EXTRA] },
        { sec: 'cliente', icone: 'person_search', titulo: 'Análise do cliente', desc: 'Sentimento, urgência percebida e risco de churn, com o histórico da organização.', campos: [
            { t: 'sel', k: 'janelaDias', num: true, label: 'Histórico recente', help: 'Período usado para contar chamados, tempo médio e serviços mais frequentes.', opts: [[30, 'Últimos 30 dias'], [90, 'Últimos 90 dias'], [180, 'Últimos 180 dias'], [365, 'Último ano']] },
            { t: 'sel', k: 'mesesHistorico', num: true, label: 'Histórico longo', help: 'Período usado para reaberturas e passagens pelo GCC.', opts: [[3, '3 meses'], [6, '6 meses'], [12, '12 meses'], [24, '24 meses']] },
            { t: 'line', k: 'termosGcc', label: 'Equipes que indicam risco', help: 'Chamados cuja equipe contenha estes termos entram como sinal de churn. Separe por vírgula.' },
            { t: 'num', k: 'contextoCaracteres', label: 'Quanto da conversa ler', help: 'Tamanho máximo da conversa enviada à IA.', min: 3000, max: 30000, step: 1000, unit: 'caracteres' },
            AIA_CRIAT, AIA_EXTRA] },
    ] },
    { grupo: 'Reincidências', icone: 'repeat', itens: [
        { sec: 'reincidencia', icone: 'repeat', titulo: 'Detecção de recorrência', desc: 'Lê o histórico completo dos chamados para achar problemas que se repetem no mesmo ticket, no mesmo cliente e entre clientes.', campos: [
            { t: 'sel', k: 'diasPadrao', num: true, label: 'Período padrão', help: 'Janela de chamados criados que entra na análise.', opts: [[7, '7 dias'], [15, '15 dias'], [30, '30 dias'], [60, '60 dias'], [90, '90 dias']] },
            { t: 'num', k: 'maxTickets', label: 'Máximo de chamados por análise', help: 'Mais chamados = análise mais completa, mais lenta e mais cara.', min: 20, max: 150, step: 10, unit: 'chamados' },
            { t: 'num', k: 'minClientesSistemico', label: 'Clientes para ser sistêmico', help: 'Mínimo de clientes diferentes para tratar como problema de sistema (padrão: 3).', min: 2, max: 10, unit: 'clientes' },
            { t: 'sel', k: 'autoHoras', num: true, label: 'Atualização automática do painel', help: 'A IA refaz a análise sozinha quando a última ficar mais velha que isso. Cada análise consome tokens; "Desligada" só atualiza pelo botão.', opts: [[0, 'Desligada'], [6, 'A cada 6 horas'], [12, 'A cada 12 horas'], [24, 'Todo dia'], [48, 'A cada 2 dias']] },
            { t: 'txt', k: 'promptBase', rows: 14, label: 'Prompt da análise', help: 'O texto que a IA recebe com as três dimensões (no chamado, por cliente e entre clientes). Em branco = prompt padrão. O formato de saída (JSON) é acrescentado automaticamente.', max: 14000, padrao: true },
            AIA_CRIAT, AIA_EXTRA] },
    ] },
    { grupo: 'Incidentes', icone: 'crisis_alert', itens: [
        { sec: 'incidenteResumo', icone: 'summarize', titulo: 'Resumo e próximos passos', desc: 'Leitura do incidente: resumo, hipóteses de causa, riscos, lacunas e ações.', campos: [
            { t: 'num', k: 'maxHipoteses', label: 'Hipóteses de causa', help: '0 = não sugerir hipóteses.', min: 0, max: 5, unit: 'no máx.' },
            { t: 'num', k: 'maxPassos', label: 'Próximos passos', help: 'Ações priorizadas sugeridas.', min: 1, max: 8, unit: 'no máx.' },
            { t: 'num', k: 'maxRiscos', label: 'Riscos', help: '0 = não listar riscos.', min: 0, max: 5, unit: 'no máx.' },
            { t: 'sw', k: 'usarMetas', label: 'Comparar com as metas de P1 a P4', help: 'A IA avisa quando reconhecimento ou resolução estão estourando a meta.' },
            { t: 'num', k: 'chamadosNoContexto', label: 'Chamados enviados à IA', help: 'Quantos chamados vinculados entram na análise.', min: 10, max: 200, step: 10, unit: 'chamados' },
            { t: 'num', k: 'eventosNoContexto', label: 'Eventos da linha do tempo', help: 'Os mais recentes entram na análise.', min: 10, max: 100, step: 10, unit: 'eventos' },
            AIA_CRIAT, AIA_EXTRA] },
        { sec: 'incidentePosmortem', icone: 'history_edu', titulo: 'Rascunho do pós-incidente', desc: 'Primeira versão da análise de causa raiz, lições aprendidas e ações corretivas, sem apontar culpados.', campos: [
            { t: 'num', k: 'maxPorques', label: 'Níveis de "por quês"', help: 'Quantos porquês encadeados a IA pode propor até a causa raiz.', min: 1, max: 7, unit: 'no máx.' },
            { t: 'num', k: 'maxAcoes', label: 'Ações corretivas', help: 'Quantas ações de prevenção ela pode sugerir.', min: 1, max: 12, unit: 'no máx.' },
            AIA_CRIAT, AIA_EXTRA] },
        { sec: 'incidenteComunicado', icone: 'campaign', titulo: 'Rascunho de comunicado', desc: 'Texto de aviso para clientes ou equipe; você revisa antes de registrar.', campos: [
            { t: 'seg', k: 'publicoPadrao', label: 'Para quem, por padrão', help: 'Já vem selecionado ao abrir o incidente.', opts: [['clientes', 'Clientes'], ['interno', 'Equipe']] },
            { t: 'seg', k: 'tipoPadrao', label: 'Tipo, por padrão', help: 'Já vem selecionado ao abrir o incidente.', opts: [['inicial', 'Primeiro aviso'], ['atualizacao', 'Atualização'], ['resolucao', 'Resolução']] },
            { t: 'seg', k: 'estilo', label: 'Linguagem para clientes', help: 'Simples evita jargão; formal soa mais institucional.', opts: [['simples', 'Simples'], ['formal', 'Formal']] },
            { t: 'num', k: 'palavrasClientes', label: 'Tamanho para clientes', help: 'Comunicados curtos são mais lidos.', min: 40, max: 400, step: 10, unit: 'palavras' },
            { t: 'num', k: 'palavrasEquipe', label: 'Tamanho para a equipe', help: 'Pode ser um pouco mais técnico.', min: 40, max: 600, step: 10, unit: 'palavras' },
            AIA_CRIAT, AIA_EXTRA] },
    ] },
];
let AIA = { settings: null, defaults: null, modelos: {}, sujo: false };
const aiaEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function aiaCampo(sec, c, S) {
    const v = S[sec][c.k], id = `aia-${sec}-${c.k}`;
    const rotulo = `<label class="aia-lbl" for="${id}">${aiaEsc(c.label)}</label><span class="aia-help">${aiaEsc(c.help || '')}</span>`;
    let ctl = '';
    if (c.t === 'sw') ctl = `<label class="aia-switch aia-switch-sm"><input type="checkbox" id="${id}" data-sec="${sec}" data-k="${c.k}" ${v ? 'checked' : ''}><span></span></label>`;
    else if (c.t === 'seg') ctl = `<div class="aia-seg" role="radiogroup" aria-label="${aiaEsc(c.label)}">${c.opts.map(([o, t]) => `<button type="button" role="radio" aria-checked="${v === o}" class="${v === o ? 'on' : ''}" data-sec="${sec}" data-k="${c.k}" data-v="${o}">${aiaEsc(t)}</button>`).join('')}</div>`;
    else if (c.t === 'sel') ctl = `<select id="${id}" class="config-input aia-sel" data-sec="${sec}" data-k="${c.k}" data-num="${c.num ? 1 : ''}">${c.opts.map(([o, t]) => `<option value="${o}" ${String(v) === String(o) ? 'selected' : ''}>${aiaEsc(t)}</option>`).join('')}</select>`;
    else if (c.t === 'num') ctl = `<div class="aia-num"><button type="button" data-step="-1" data-sec="${sec}" data-k="${c.k}" aria-label="Diminuir">−</button><input type="number" id="${id}" data-sec="${sec}" data-k="${c.k}" min="${c.min}" max="${c.max}" step="${c.step || 1}" value="${v}"><button type="button" data-step="1" data-sec="${sec}" data-k="${c.k}" aria-label="Aumentar">+</button><span>${aiaEsc(c.unit || '')}</span></div>`;
    else if (c.t === 'line') ctl = `<input type="text" id="${id}" class="config-input" data-sec="${sec}" data-k="${c.k}" value="${aiaEsc(v)}" maxlength="200">`;
    else if (c.t === 'txt') ctl = `<textarea id="${id}" class="config-input config-textarea aia-txt" data-sec="${sec}" data-k="${c.k}" maxlength="${c.max}" rows="${c.rows || 2}" placeholder="Deixe em branco para usar só o comportamento padrão">${aiaEsc(v)}</textarea><span class="aia-cont" data-cont="${id}">${String(v).length}/${c.max}</span>${c.padrao ? `<button type="button" class="aia-link" data-prompt-padrao="${sec}">Carregar o prompt padrão para editar</button>` : ''}`;
    return `<div class="aia-campo ${c.t === 'txt' || c.t === 'line' ? 'aia-largo' : ''}"><div class="aia-rot">${rotulo}</div><div class="aia-ctl">${ctl}</div></div>`;
}

function aiaRender() {
    const root = document.getElementById('aiaRoot');
    if (!root || !AIA.settings) return;
    const S = AIA.settings, G = S.geral;
    const modelos = Object.entries(AIA.modelos).map(([m, t]) => `<option value="${m}" ${G.modelo === m ? 'selected' : ''}>${aiaEsc(t)}</option>`).join('');
    const geral = `<section class="config-card aia-card">
        <header class="aia-cab"><span class="material-symbols-outlined aia-ico">tune</span><div><h3 class="config-card-title">Geral</h3><p class="aia-desc">Vale para todas as funções de IA dos chamados e dos incidentes.</p></div></header>
        <div class="aia-corpo">
            <div class="aia-campo"><div class="aia-rot"><label class="aia-lbl" for="aia-geral-modelo">Modelo de IA</label><span class="aia-help">Modelos maiores acertam mais e custam mais. O consumo aparece em "Consumo de IA".</span></div><div class="aia-ctl"><select id="aia-geral-modelo" class="config-input aia-sel" data-sec="geral" data-k="modelo">${modelos}</select></div></div>
            <div class="aia-campo aia-largo"><div class="aia-rot"><label class="aia-lbl" for="aia-geral-diretrizes">Diretrizes da empresa</label><span class="aia-help">Regras que a IA segue em TODAS as funções. Ex.: "nunca prometa prazo", "trate o cliente por senhor/senhora", "cite sempre o número do chamado".</span></div><div class="aia-ctl"><textarea id="aia-geral-diretrizes" class="config-input config-textarea aia-txt" data-sec="geral" data-k="diretrizes" maxlength="1500" rows="3" placeholder="Deixe em branco para usar só o comportamento padrão">${aiaEsc(G.diretrizes)}</textarea><span class="aia-cont" data-cont="aia-geral-diretrizes">${G.diretrizes.length}/1500</span></div></div>
            ${aiaCampo('geral', { t: 'num', k: 'limiteChamadosPor10min', label: 'Limite por pessoa nos chamados', help: 'Protege o custo: usos de IA em 10 minutos por usuário.', min: 5, max: 300, step: 5, unit: 'usos / 10 min' }, S)}
            ${aiaCampo('geral', { t: 'num', k: 'limiteIncidentesPor10min', label: 'Limite por pessoa nos incidentes', help: 'Usos de IA em 10 minutos por usuário.', min: 5, max: 300, step: 5, unit: 'usos / 10 min' }, S)}
        </div></section>`;
    const grupos = AIA_SECOES.map((g) => `<h3 class="aia-grupo"><span class="material-symbols-outlined">${g.icone}</span>${g.grupo}</h3>` + g.itens.map((it) => {
        const on = S[it.sec].ativo;
        return `<section class="config-card aia-card ${on ? '' : 'aia-off'}" data-card="${it.sec}">
            <header class="aia-cab"><span class="material-symbols-outlined aia-ico">${it.icone}</span><div class="aia-cab-txt"><h3 class="config-card-title">${it.titulo}</h3><p class="aia-desc">${it.desc}</p></div>
                <label class="aia-switch" title="${on ? 'Ligada' : 'Desligada'}"><input type="checkbox" data-sec="${it.sec}" data-k="ativo" ${on ? 'checked' : ''} aria-label="Ativar ${it.titulo}"><span></span></label></header>
            <div class="aia-corpo">${it.campos.map((c) => aiaCampo(it.sec, c, S)).join('')}</div>
            <footer class="aia-rodape"><button type="button" class="aia-link" data-padrao="${it.sec}">Voltar esta função ao padrão</button></footer>
        </section>`;
    }).join('')).join('');
    const foco = document.activeElement && document.activeElement.id;
    root.innerHTML = geral + grupos;
    if (foco) document.getElementById(foco)?.focus({ preventScroll: true });
    aiaMarcarSujo(AIA.sujo);
}

function aiaMarcarSujo(sujo) {
    AIA.sujo = sujo;
    const bar = document.getElementById('aiaBarra'); if (!bar) return;
    bar.classList.toggle('aia-sujo', sujo);
    document.getElementById('aiaBarraTxt').textContent = sujo ? 'Você tem alterações não salvas.' : 'Tudo salvo. As mudanças valem para os próximos usos da IA.';
    document.getElementById('aiaSalvar').disabled = !sujo;
    document.getElementById('aiaDescartar').disabled = !sujo;
}

function aiaAplicar(sec, k, valor) {
    AIA.settings[sec][k] = valor;
    aiaMarcarSujo(true);
}

async function loadAiAssistTab() {
    const root = document.getElementById('aiaRoot');
    if (!root || !isCurrentUserAdmin()) return;
    if (!AIA.settings) root.innerHTML = '<p class="config-card-help">Carregando…</p>';
    try {
        const r = await fetch(`${API_BASE}/config/ai-assist`, { headers: authHeaders() });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Falha ao carregar');
        AIA = { settings: d.settings, defaults: d.defaults, modelos: d.modelos, promptPadrao: d.promptReincidencia, sujo: false };
        aiaRender();
    } catch (e) { root.innerHTML = `<p class="config-status error">${aiaEsc(e.message)}</p>`; }
}

async function aiaSalvar() {
    const st = document.getElementById('aiaStatus');
    const btn = document.getElementById('aiaSalvar'); btn.disabled = true;
    try {
        const r = await fetch(`${API_BASE}/config/ai-assist`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: AIA.settings }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Falha ao salvar');
        AIA.settings = d.settings; AIA.sujo = false; aiaRender();
        st.className = 'config-status ok'; st.textContent = 'Configurações salvas.';
    } catch (e) { st.className = 'config-status error'; st.textContent = e.message; btn.disabled = false; }
    setTimeout(() => { if (st.textContent === 'Configurações salvas.') st.textContent = ''; }, 4000);
}

function aiaInit() {
    const root = document.getElementById('aiaRoot');
    if (!root || root.dataset.pronto) return;
    root.dataset.pronto = '1';
    root.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.promptPadrao) {
            if (AIA.settings[b.dataset.promptPadrao].promptBase && !confirm('Substituir o prompt atual pelo padrão?')) return;
            AIA.settings[b.dataset.promptPadrao].promptBase = AIA.promptPadrao || ''; aiaMarcarSujo(true); aiaRender(); return;
        }
        if (b.dataset.padrao) {
            AIA.settings[b.dataset.padrao] = JSON.parse(JSON.stringify(AIA.defaults[b.dataset.padrao]));
            aiaMarcarSujo(true); aiaRender(); return;
        }
        const { sec, k } = b.dataset; if (!sec) return;
        if (b.dataset.v !== undefined) { aiaAplicar(sec, k, b.dataset.v); aiaRender(); return; }
        if (b.dataset.step) {
            const inp = document.getElementById(`aia-${sec}-${k}`), passo = Number(inp.step) || 1;
            const n = Math.min(Number(inp.max), Math.max(Number(inp.min), (Number(inp.value) || 0) + passo * Number(b.dataset.step)));
            inp.value = n; aiaAplicar(sec, k, n);
        }
    });
    root.addEventListener('input', (e) => {
        const t = e.target; if (!t.dataset || !t.dataset.sec || t.type === 'checkbox') return;
        const { sec, k } = t.dataset;
        if (t.type === 'number') { if (t.value !== '') aiaAplicar(sec, k, Number(t.value)); return; }
        if (t.tagName === 'SELECT') return;
        aiaAplicar(sec, k, t.value);
        root.querySelector(`[data-cont="${t.id}"]`)?.replaceChildren(`${t.value.length}/${t.maxLength}`);
    });
    root.addEventListener('change', (e) => {
        const t = e.target; if (!t.dataset || !t.dataset.sec) return;
        const { sec, k } = t.dataset;
        if (t.type === 'checkbox') { aiaAplicar(sec, k, t.checked); if (k === 'ativo') aiaRender(); }
        else if (t.tagName === 'SELECT') { aiaAplicar(sec, k, t.dataset.num ? Number(t.value) : t.value); }
        else if (t.type === 'number') {
            const n = Math.min(Number(t.max), Math.max(Number(t.min), Number(t.value) || Number(t.min)));
            t.value = n; aiaAplicar(sec, k, n);
        }
    });
    document.getElementById('aiaSalvar').addEventListener('click', aiaSalvar);
    document.getElementById('aiaDescartar').addEventListener('click', () => loadAiAssistTab());
    document.getElementById('aiaRestaurar').addEventListener('click', () => {
        if (!confirm('Voltar TODAS as configurações do assistente de IA ao padrão? Isso só vale depois de salvar.')) return;
        AIA.settings = JSON.parse(JSON.stringify(AIA.defaults)); aiaMarcarSujo(true); aiaRender();
    });
}


// ─── Equivalência de verticais (Pessoas ↔ nomes usados nos dados) ─────────────────────────
async function loadVerticalAliases() {
    const box = document.getElementById('cfgVertAliases');
    if (!box) return;
    try {
        const r = await fetch(`${API_BASE}/config/vertical-aliases`, { headers: authHeaders() });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Erro ao carregar');
        box.value = d.texto || '';
    } catch (e) { setCfgStatus('cfgVertAliasesStatus', e.message, 'error'); }
}
async function saveVerticalAliases() {
    try {
        const r = await fetch(`${API_BASE}/config/vertical-aliases`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: document.getElementById('cfgVertAliases').value }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Erro ao salvar');
        document.getElementById('cfgVertAliases').value = d.texto || '';
        setCfgStatus('cfgVertAliasesStatus', 'Equivalências salvas. Valem para o próximo carregamento do GCC e da Satisfação.', 'ok');
    } catch (e) { setCfgStatus('cfgVertAliasesStatus', `Erro ao salvar: ${e.message}`, 'error'); }
}

// ── Telemetria: uso do Hub 360 (quem, o quê, quando, quantos cliques) ─────────
const TEL_DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function telEsc(v) { return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function telTempo(seg) {
    const s = Number(seg) || 0;
    if (s < 60) return s ? `${s}s` : '—';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}min` : `${m}min`;
}
function telQuando(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (dias <= 0 && new Date().getDate() === d.getDate()) return `hoje ${hora}`;
    return `${d.toLocaleDateString('pt-BR')} ${hora}`;
}
const telN = (n) => (Number(n) || 0).toLocaleString('pt-BR');

async function loadTelemetria() {
    const corpo = document.getElementById('telCorpo');
    const status = document.getElementById('telStatus');
    if (!corpo) return;
    const dias = document.getElementById('telDias').value;
    const selUser = document.getElementById('telUsuario');
    const usuario = selUser.value;
    status.textContent = 'Carregando…';
    try {
        const r = await fetch(`${API_BASE}/telemetria/resumo?dias=${encodeURIComponent(dias)}${usuario ? `&usuario=${encodeURIComponent(usuario)}` : ''}`, { headers: authHeaders() });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || r.statusText);
        status.textContent = '';

        // lista de usuários do filtro (preserva a seleção)
        if (selUser.options.length <= 1 && d.listaUsuarios) {
            selUser.innerHTML = '<option value="">Todos</option>' + d.listaUsuarios.map((u) => `<option value="${u.id}">${telEsc(u.name)}</option>`).join('');
            selUser.value = usuario;
        }

        const k = d.kpi || {};
        const cards = [
            ['Usuários ativos', telN(k.usuarios)], ['Acessos a abas', telN(k.acessos)], ['Cliques', telN(k.cliques)],
            ['Tempo ativo total', telTempo(k.seg_ativos)], ['Sessões', telN(k.sessoes)],
            ['Cliques por acesso', k.acessos ? (k.cliques / k.acessos).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'],
        ];
        const kpis = `<div class="tel-kpis">${cards.map(([l, v]) => `<div class="tel-kpi"><span>${l}</span><b>${v}</b></div>`).join('')}</div>`;

        const tUsuarios = `<div class="config-card"><h3 class="config-card-title">Quem mais usa</h3>
            ${d.usuarios.length ? `<div class="tel-scroll"><table class="tel-tabela"><thead><tr><th>#</th><th>Usuário</th><th class="n">Acessos</th><th class="n">Cliques</th><th class="n">Tempo ativo</th><th class="n">Dias ativos</th><th>Aba mais usada</th><th>Último acesso</th></tr></thead><tbody>
            ${d.usuarios.map((u, i) => `<tr><td>${i + 1}</td><td><b>${telEsc(u.nome)}</b><br><small>${telEsc(u.email || '')}</small></td><td class="n">${telN(u.acessos)}</td><td class="n">${telN(u.cliques)}</td><td class="n">${telTempo(u.seg_ativos)}</td><td class="n">${telN(u.dias_ativos)}</td><td>${telEsc(u.aba_top || '—')}</td><td>${telQuando(u.ultima)}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="tel-vazio">Nenhum uso registrado neste período.</p>'}</div>`;

        const maxC = Math.max(1, ...d.abas.map((a) => a.cliques));
        const tAbas = `<div class="config-card"><h3 class="config-card-title">O que mais usam (por aba)</h3>
            ${d.abas.length ? `<div class="tel-scroll"><table class="tel-tabela"><thead><tr><th>Aba</th><th class="n">Acessos</th><th class="n">Cliques</th><th class="n">Usuários</th><th class="n">Tempo ativo</th><th style="width:30%"></th></tr></thead><tbody>
            ${d.abas.map((a) => `<tr><td><b>${telEsc(a.aba)}</b></td><td class="n">${telN(a.acessos)}</td><td class="n">${telN(a.cliques)}</td><td class="n">${telN(a.usuarios)}</td><td class="n">${telTempo(a.seg_ativos)}</td><td><div class="tel-barra"><i style="width:${Math.max(2, a.cliques / maxC * 100)}%"></i></div></td></tr>`).join('')}
            </tbody></table></div>` : '<p class="tel-vazio">Sem dados.</p>'}</div>`;

        const tAlvos = `<div class="config-card"><h3 class="config-card-title">Botões e controles mais clicados</h3>
            ${d.alvos.length ? `<div class="tel-scroll"><table class="tel-tabela"><thead><tr><th>Controle</th><th>Aba</th><th class="n">Cliques</th><th class="n">Usuários</th></tr></thead><tbody>
            ${d.alvos.map((a) => `<tr><td>${telEsc(a.alvo)}</td><td>${telEsc(a.aba)}</td><td class="n">${telN(a.cliques)}</td><td class="n">${telN(a.usuarios)}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="tel-vazio">Sem cliques registrados.</p>'}</div>`;

        // mapa de calor: dia da semana x hora (horário de Brasília)
        const grade = Array.from({ length: 7 }, () => Array(24).fill(0));
        let maxH = 1;
        d.heat.forEach((h) => { grade[h.dow][h.hora] = h.n; maxH = Math.max(maxH, h.n); });
        const heat = `<div class="config-card"><h3 class="config-card-title">Quando usam (dia da semana × hora)</h3>
            <p class="config-card-help">Visitas + cliques, horário de Brasília. Mais escuro = mais uso.</p>
            <div class="tel-heat"><div></div>${Array.from({ length: 24 }, (_, h) => `<small>${h}</small>`).join('')}
            ${grade.map((linha, dow) => `<small>${TEL_DIAS_SEMANA[dow]}</small>${linha.map((n, h) => `<i title="${TEL_DIAS_SEMANA[dow]} ${h}h: ${telN(n)}" style="opacity:${n ? (0.15 + 0.85 * n / maxH).toFixed(2) : 0.06}"></i>`).join('')}`).join('')}
            </div></div>`;

        const maxS = Math.max(1, ...d.serie.map((x) => x.cliques + x.acessos));
        const serie = `<div class="config-card"><h3 class="config-card-title">Dia a dia</h3>
            ${d.serie.length ? `<div class="tel-serie">${d.serie.map((x) => `<div title="${new Date(x.dia).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}: ${telN(x.usuarios)} usuário(s), ${telN(x.acessos)} acessos, ${telN(x.cliques)} cliques"><i style="height:${Math.max(3, (x.cliques + x.acessos) / maxS * 100)}%"></i><small>${new Date(x.dia).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })}</small></div>`).join('')}</div>` : '<p class="tel-vazio">Sem dados.</p>'}</div>`;

        const sem = d.semAcesso && d.semAcesso.length
            ? `<div class="config-card"><h3 class="config-card-title">Sem nenhum acesso no período (${d.semAcesso.length})</h3>
               <div class="tel-scroll"><table class="tel-tabela"><thead><tr><th>Usuário</th><th>E-mail</th><th>Último login</th></tr></thead><tbody>
               ${d.semAcesso.map((u) => `<tr><td>${telEsc(u.name)}</td><td>${telEsc(u.email)}</td><td>${telQuando(u.last_login)}</td></tr>`).join('')}
               </tbody></table></div></div>` : '';

        corpo.innerHTML = kpis + tUsuarios + tAbas + tAlvos + heat + serie + sem;
    } catch (e) {
        status.textContent = `Não foi possível carregar a telemetria: ${e.message}`;
        status.className = 'config-status error';
    }
}

// ── Diagnóstico de chat: os atendimentos de chat chegam com os campos preenchidos? ──
async function rodarDiagnosticoChat() {
    const btn = document.getElementById('cfgChatDiagBtn');
    const status = document.getElementById('cfgChatDiagStatus');
    const box = document.getElementById('cfgChatDiagResultado');
    if (!btn) return;
    btn.disabled = true; status.textContent = 'Consultando o Movidesk…'; box.innerHTML = '';
    try {
        const tk = (document.getElementById('cfgChatDiagTickets') || {}).value || '';
        const r = await fetch(`${API_BASE}/geral/chat-diagnostico?tickets=${encodeURIComponent(tk)}&procurar=${encodeURIComponent(((document.getElementById('cfgChatDiagProcurar') || {}).value || '').trim())}`, { headers: authHeaders() });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || r.statusText);
        status.textContent = '';
        const e = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const a = d.amostra, c = d.chats;
        const linhas = [];
        if (c.total) {
            linhas.push(`<b>✅ Encontrei ${c.total} chamado(s) de chat recentes</b> (o mais recente em ${e(new Date(c.maisRecente).toLocaleString('pt-BR'))}).`);
            linhas.push(`Código de origem desses chamados: <b>${e(c.origens.join(', '))}</b>.`);
            linhas.push(`Grupos de chat: ${c.grupos.length ? e(c.grupos.join(' · ')) : '<b>nenhum preenchido</b>'}.`);
            linhas.push(`Widgets: ${c.widgets.length ? e(c.widgets.join(' · ')) : '—'}.`);
            linhas.push(`Com tempo de conversa: <b>${c.comTempoConversa}</b> de ${c.total} · com tempo de espera: <b>${c.comTempoEspera}</b> de ${c.total} · com grupo: <b>${c.comGrupo}</b> de ${c.total}.`);
            if (c.exemplos.length) linhas.push('Exemplos: ' + c.exemplos.map((x) => `#${e(x.id)} (${e(x.grupo || 'sem grupo')}, espera ${e(x.espera ?? '—')}, conversa ${e(x.conversa ?? '—')})`).join(' · '));
            linhas.push('<b>Conclusão:</b> dá para acompanhar o chat no Hub a partir dos chamados. O Hub já guarda esses chats: veja em Chamados → Chats.');
        } else {
            linhas.push('<b>⚠️ Não achei chamados com widget de chat preenchido.</b> Ou o chat ainda não gera chamado com esses campos, ou a conta não os devolve.');
            linhas.push(`Na amostra dos últimos ${a.total} chamados, as origens são: ${Object.entries(a.porOrigem).map(([k, v]) => `${e(k)} (${v})`).join(', ') || '—'}.`);
        }
        // o que a API devolve para cada chamado informado
        if (d.sonda && d.sonda.length) {
            linhas.push('<br><b>Chamados conferidos:</b>');
            d.sonda.forEach((x) => {
                if (x.erro) { linhas.push(`#${e(x.id)}: ${e(x.erro)}`); return; }
                linhas.push(`#${e(x.id)} — origem <b>${e(x.origin ?? 'vazia')}</b> · status ${e(x.status || '—')} · grupo <b>${e(x.grupo || 'vazio')}</b> · widget <b>${e(x.widget || 'vazio')}</b> · atendente ${e(x.atendente || '—')} · serviço ${e(x.servico || '—')} · espera ${e(x.espera ?? '—')} · conversa ${e(x.conversa ?? '—')}`
                    + (x.noHub === undefined ? '' : (x.noHub ? ` · <b>no Hub:</b> sim (status ${e(x.noHub.base_status)}, tempo de conversa ${e(x.noHub.tempo_conversa ?? 'vazio')})` : ' · <b>no Hub:</b> <b>NÃO</b> (a coleta não pegou este chamado)')));
            });
        }
        if (d.procura) {
            const pr = d.procura;
            linhas.push(`<br><b>Procurando "${e(pr.valor)}" no chamado #${e(pr.id)}:</b> ` + (pr.erro ? e(pr.erro)
                : (pr.encontrado.length ? pr.encontrado.map((x) => `<code>${e(x)}</code>`).join('<br>') : '<b>não encontrado em nenhum campo</b>')));
            if (!pr.erro) {
                linhas.push('Campos de chat do chamado: ' + (Object.keys(pr.camposChat).length ? Object.entries(pr.camposChat).map(([k, v]) => `${e(k)} = ${e(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' · ') : 'nenhum'));
                linhas.push('Todos os campos devolvidos: ' + e(pr.todosOsCampos.join(', ')));
            }
        }
        // por origem, entre os últimos 100 chamados: quantos têm grupo/widget
        if (a.porOrigemDetalhe) {
            linhas.push('<br><b>Origens nos últimos ' + a.total + ' chamados:</b> ' + Object.entries(a.porOrigemDetalhe).map(([k, v]) => `origem ${e(k)}: ${v.total} (com grupo ${v.comGrupo}, com widget ${v.comWidget})`).join(' · '));
        }
        if (d.erros && d.erros.length) linhas.push('<b>Avisos da API:</b><br>' + d.erros.map(e).join('<br>'));
        box.innerHTML = linhas.join('<br>');
    } catch (err) {
        status.textContent = `Não foi possível verificar: ${err.message}`;
        status.className = 'config-status error';
    } finally { btn.disabled = false; }
}
