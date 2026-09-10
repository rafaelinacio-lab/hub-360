
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

// Atualiza o dashboard com dados do banco a cada 1 minuto (sem disparar sync na API)
let _dashboardRefreshIntervalId = null;

function startDashboardRefreshLoop() {
    if (_dashboardRefreshIntervalId) return;
    _dashboardRefreshIntervalId = setInterval(async () => {
        try {
            await fetchOpenTickets();
        } catch (e) {
            console.warn('Dashboard refresh silencioso falhou:', e.message);
        }
    }, 60 * 1000);
}

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
    if (tab === 'curadoria') { loadCuradoriaPendingCount(); checkSurveySyncOnLoad(); checkModuloSyncOnLoad(); loadScoreWeightsConfig(); checkFullLoadOnLoad(); loadSlaEstouroCount(); loadEnrichCount(); loadEnrichStatus(); }
    if (tab === 'curadoria-avancado') loadCuradoriaAvancadoTab();
    if (tab === 'acesso') loadTabPermissionsConfig();
}

// ─── Acesso: quais abas cada perfil vê no menu ─────────────────────────────
const CFG_ACCESS_DEFAULTS = { supervisor: ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk'], atendente: ['dashboard', 'chamados', 'ouvidoria', 'gcc', 'jira', 'movidesk'], guest: ['dashboard'] };
const CFG_TAB_LABELS = { dashboard: 'Dashboard', chamados: 'Curadoria', ouvidoria: 'Ouvidoria', gcc: 'GCC', jira: 'Jira', movidesk: 'Movidesk' };
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
        const checks = Object.entries(CFG_TAB_LABELS).map(([key, label]) => `<label class="config-checkbox-label"><input type="checkbox" class="cfg-access-checkbox" data-role="${cfgEsc(role.name)}" value="${key}" ${allowed.includes(key) ? 'checked' : ''}> ${label}</label>`).join('');
        return `<div class="config-form-stack" style="margin:0 0 18px;padding-bottom:18px;border-bottom:1px solid #e5e7eb;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><label class="config-form-label" style="margin:0;"><strong>${cfgEsc(cfgRoleLabel(role.name))}</strong></label>${role.description ? `<span style="font-size:12px;color:#666;">${cfgEsc(role.description)}</span>` : ''}${canDelete ? `<button type="button" class="config-btn config-btn-danger" style="margin-left:auto;" onclick="deleteProfileConfig(${Number(role.id)})">Remover</button>` : ''}</div>
            <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;">${checks}</div>
        </div>`;
    }).join('') || '<p class="config-card-help">Nenhum perfil disponível.</p>';
}

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

// A sincronização com o Movidesk roda fora do app agora (scripts/sync-movidesk.js,
// agendado no Windows Task Scheduler) — aqui só exibimos quando foi a última vez
// que esse script gravou algo no banco, sem nenhum botão pra disparar nada.
async function loadLastSyncedAt() {
    const el = document.getElementById('cfgLastSyncedAt');
    if (!el) return;

    try {
        const response = await fetch(`${API_BASE}/config/autosync`, {
            headers: authHeaders()
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar última sincronização');

        if (data.lastSyncedAt) {
            const d = new Date(data.lastSyncedAt);
            el.textContent = d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            el.className = 'config-token-status config-token-status-on';
        } else {
            el.textContent = 'Nunca sincronizado';
            el.className = 'config-token-status config-token-status-off';
        }
    } catch (error) {
        el.textContent = 'Erro ao consultar';
        el.className = 'config-token-status config-token-status-off';
    }
}

async function loadAdminStats() {
    try {
        const response = await fetch(`${API_BASE}/tickets/stats/overview`, {
            headers: authHeaders()
        });
        if (!response.ok) throw new Error('Falha ao carregar estatisticas');
        const stats = await response.json();

        const grid = document.getElementById('cfgStatsGrid');
        if (!grid) return;
        const values = grid.querySelectorAll('strong');
        if (values.length < 4) return;

        values[0].textContent = stats.total || 0;
        values[1].textContent = stats.novo || 0;
        values[2].textContent = stats.emAtendimento || 0;
        values[3].textContent = stats.parado || 0;
    } catch {
        setCfgStatus('cfgMovideskStatus', 'Nao foi possivel carregar as estatisticas.', 'error');
    }
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

async function loginSubmit(event) {
    event.preventDefault();
    const email = document.getElementById('loginEmail')?.value?.trim();
    const password = document.getElementById('loginPassword')?.value?.trim();
    const btn = document.getElementById('loginSubmit');
    setLoginError('');

    if (!email || !password) {
        setLoginError('Informe e-mail e senha.');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Entrando...';
    }

    try {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Falha no login');
        }

        if (data.requiresMFA) {
            throw new Error('MFA habilitado neste usuário. O fluxo de confirmação ainda não está implementado nesta tela.');
        }

        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        _currentUser = data.user;
        setLoginError('');
        hideLoginScreen();
        await initializeApp();
    } catch (error) {
        setLoginError(error.message || 'Erro ao entrar.');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Entrar';
        }
    }
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

async function loadDbConfig() {
    if (!isCurrentUserAdmin()) {
        setCfgStatus('cfgDbStatus', 'Somente admin pode consultar as configurações do banco.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/database`, {
            headers: authHeaders()
        });
        const raw = await response.text();
        let data = {};
        if (raw) {
            try { data = JSON.parse(raw); } catch { data = { error: raw }; }
        }
        if (!response.ok) throw new Error(data.error || 'Falha ao consultar banco');

        const host = document.getElementById('cfgDbHost');
        const port = document.getElementById('cfgDbPort');
        const name = document.getElementById('cfgDbName');
        const user = document.getElementById('cfgDbUser');
        const password = document.getElementById('cfgDbPassword');
        const dialect = document.getElementById('cfgDbDialect');

        if (host) host.value = data.host || '';
        if (port) port.value = data.port || '';
        if (name) name.value = data.name || '';
        if (user) user.value = data.user || '';
        if (password) password.value = data.password || '';
        if (dialect) dialect.value = data.dialect || 'postgres';

        setCfgStatus('cfgDbStatus', data.configured ? 'Configurações do banco carregadas.' : 'Banco ainda não configurado.');
    } catch (error) {
        setCfgStatus('cfgDbStatus', `Erro ao consultar banco: ${error.message}`, 'error');
    }
}

async function saveDbConfig() {
    if (!isCurrentUserAdmin()) {
        setCfgStatus('cfgDbStatus', 'Somente admin pode salvar as configurações do banco.', 'error');
        return;
    }

    const host = document.getElementById('cfgDbHost')?.value?.trim();
    const port = document.getElementById('cfgDbPort')?.value?.trim();
    const name = document.getElementById('cfgDbName')?.value?.trim();
    const user = document.getElementById('cfgDbUser')?.value?.trim();
    const password = document.getElementById('cfgDbPassword')?.value?.trim();
    const dialect = document.getElementById('cfgDbDialect')?.value || 'postgres';

    if (!host || !port || !name || !user || !password) {
        setCfgStatus('cfgDbStatus', 'Preencha host, porta, nome, usuário e senha.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/database`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ host, port, name, user, password, dialect })
        });
        const raw = await response.text();
        let data = {};
        if (raw) {
            try { data = JSON.parse(raw); } catch { data = { error: raw }; }
        }
        if (!response.ok) throw new Error(data.error || 'Falha ao salvar banco');

        setCfgStatus('cfgDbStatus', 'Configurações do banco salvas com sucesso.', 'ok');
        await loadDbConfig();
    } catch (error) {
        setCfgStatus('cfgDbStatus', `Erro ao salvar banco: ${error.message}`, 'error');
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

// ===== CONDIÇÕES DA REQUISIÇÃO MOVIDESK =====
let _cfgTeamConditions = [];

function renderTeamConditions() {
    const container = document.getElementById('cfgTeamConditionsList');
    if (!container) return;

    if (!_cfgTeamConditions.length) {
        container.innerHTML = '<p style="font-size: 12px; color: #666; margin: 0 0 10px;">Nenhuma condição adicional cadastrada.</p>';
        return;
    }

    container.innerHTML = _cfgTeamConditions.map((condition, index) => `
        <div class="config-form-row" style="border: 1px solid #dce3ed; border-radius: 8px; padding: 12px; margin-bottom: 10px;">
                <input data-team-condition="ownerTeam" data-index="${index}" type="text" class="config-input" placeholder="Equipe do owner *" value="${escapeHtml(condition.ownerTeam || '')}">
                <input data-team-condition="serviceFirstLevel" data-index="${index}" type="text" class="config-input" placeholder="Serviço da equipe" value="${escapeHtml(condition.serviceFirstLevel || '')}">
                <button type="button" class="config-btn config-btn-muted" data-remove-team-condition="${index}">Remover</button>
        </div>`).join('');

    container.querySelectorAll('[data-team-condition]').forEach((input) => {
        input.addEventListener('input', (event) => {
            const index = Number(event.target.dataset.index);
            _cfgTeamConditions[index][event.target.dataset.teamCondition] = event.target.value;
        });
    });
    container.querySelectorAll('[data-remove-team-condition]').forEach((button) => {
        button.addEventListener('click', () => {
            _cfgTeamConditions.splice(Number(button.dataset.removeTeamCondition), 1);
            renderTeamConditions();
        });
    });
}

function addTeamCondition() {
    _cfgTeamConditions.push({
        ownerTeam: document.getElementById('cfgOwnerTeam')?.value?.trim() || '',
        serviceFirstLevel: document.getElementById('cfgServiceFirstLevel')?.value?.trim() || ''
    });
    renderTeamConditions();
}

async function loadMovideskConditions() {
    if (!isCurrentUserAdmin()) return;

    try {
        const response = await fetch(`${API_BASE}/config/movidesk-conditions`, {
            headers: authHeaders()
        });
        
        if (!response.ok) {
            console.warn('Falha ao carregar condições Movidesk, usando padrões');
            setDefaultMovideskConditions();
            return;
        }

        const data = await response.json();

        // Carregar status
        const statuses = data.statuses || ['New', 'InAttendance', 'Stopped'];
        document.getElementById('cfgStatusNew').checked = statuses.includes('New');
        document.getElementById('cfgStatusInAttendance').checked = statuses.includes('InAttendance');
        document.getElementById('cfgStatusStopped').checked = statuses.includes('Stopped');
        document.getElementById('cfgStatusInProgress').checked = statuses.includes('InProgress');

        // Carregar filtro de serviço
        document.getElementById('cfgServiceFirstLevel').value = data.serviceFirstLevel || '';

        // Carregar filtro de campo customizado
        document.getElementById('cfgCustomFieldId').value = data.customFieldId || '23946';
        document.getElementById('cfgCustomFieldValue').value = data.customFieldValue || 'Suporte Técnico';

        // Carregar limite
        document.getElementById('cfgSyncLimit').value = data.syncLimit || '100';

        // Carregar ownerTeam
        document.getElementById('cfgOwnerTeam').value = data.ownerTeam || 'VIASOFT - Sistemas Internos';
        _cfgTeamConditions = Array.isArray(data.teamConditions) ? data.teamConditions.map(condition => ({
            ownerTeam: condition.ownerTeam || '',
            serviceFirstLevel: condition.serviceFirstLevel || ''
        })) : [];
        renderTeamConditions();

        // Carregar status base excluídos
        const excludedStatuses = data.excludedBaseStatuses || ['Resolved', 'Closed', 'Canceled'];
        document.getElementById('cfgExcludedResolved').checked = excludedStatuses.includes('Resolved');
        document.getElementById('cfgExcludedClosed').checked = excludedStatuses.includes('Closed');
        document.getElementById('cfgExcludedCanceled').checked = excludedStatuses.includes('Canceled');

        // Carregar campos de select e expand
        document.getElementById('cfgSelectFields').value = data.selectFields || 'id,subject,status,baseStatus,createdDate,lastActionDate,lastUpdate,serviceFirstLevelId,serviceFirstLevel,serviceSecondLevel,slaAgreement,slaAgreementRule,slaSolutionTime,slaResponseTime,slaSolutionDate,slaSolutionDateIsPaused,slaResponseDate,slaRealResponseDate,justification,ownerTeam';
        document.getElementById('cfgExpandRelations').value = data.expandRelations || 'owner,actions($select=id,type,origin,status,createdDate,description;$expand=createdBy),customFieldValues($expand=items),clients($expand=organization)';
    } catch (error) {
        console.error('Erro ao carregar condições Movidesk:', error);
        setDefaultMovideskConditions();
    }
}

function setDefaultMovideskConditions() {
    document.getElementById('cfgStatusNew').checked = true;
    document.getElementById('cfgStatusInAttendance').checked = true;
    document.getElementById('cfgStatusStopped').checked = true;
    document.getElementById('cfgStatusInProgress').checked = false;
    document.getElementById('cfgServiceFirstLevel').value = '';
    document.getElementById('cfgCustomFieldId').value = '23946';
    document.getElementById('cfgCustomFieldValue').value = 'Suporte Técnico';
    document.getElementById('cfgSyncLimit').value = '100';
    document.getElementById('cfgOwnerTeam').value = 'VIASOFT - Sistemas Internos';
    _cfgTeamConditions = [];
    renderTeamConditions();
    document.getElementById('cfgExcludedResolved').checked = true;
    document.getElementById('cfgExcludedClosed').checked = true;
    document.getElementById('cfgExcludedCanceled').checked = true;
    document.getElementById('cfgSelectFields').value = 'id,subject,status,baseStatus,createdDate,lastActionDate,lastUpdate,serviceFirstLevelId,serviceFirstLevel,serviceSecondLevel,slaAgreement,slaAgreementRule,slaSolutionTime,slaResponseTime,slaSolutionDate,slaSolutionDateIsPaused,slaResponseDate,slaRealResponseDate,justification,ownerTeam';
    document.getElementById('cfgExpandRelations').value = 'owner,actions($select=id,type,origin,status,createdDate,description;$expand=createdBy),customFieldValues($expand=items),clients($expand=organization)';
}

async function saveMovideskConditions() {
    if (!isCurrentUserAdmin()) {
        setCfgStatus('cfgMovideskConditionsStatus', 'Somente admin pode salvar as condições Movidesk.', 'error');
        return;
    }

    const statuses = [];
    if (document.getElementById('cfgStatusNew').checked) statuses.push('New');
    if (document.getElementById('cfgStatusInAttendance').checked) statuses.push('InAttendance');
    if (document.getElementById('cfgStatusStopped').checked) statuses.push('Stopped');
    if (document.getElementById('cfgStatusInProgress').checked) statuses.push('InProgress');

    if (statuses.length === 0) {
        setCfgStatus('cfgMovideskConditionsStatus', 'Selecione pelo menos um status.', 'error');
        return;
    }

    const serviceFirstLevel = document.getElementById('cfgServiceFirstLevel')?.value?.trim() || '';
    const customFieldId = document.getElementById('cfgCustomFieldId')?.value?.trim() || '';
    const customFieldValue = document.getElementById('cfgCustomFieldValue')?.value?.trim() || '';
    const syncLimit = parseInt(document.getElementById('cfgSyncLimit')?.value || '100');

    if (syncLimit < 1 || syncLimit > 500) {
        setCfgStatus('cfgMovideskConditionsStatus', 'Limite deve estar entre 1 e 500.', 'error');
        return;
    }

    // Novos campos
    const ownerTeam = document.getElementById('cfgOwnerTeam')?.value?.trim() || '';
    // Ler diretamente da tela no momento do salvamento. Assim, alterações por
    // preenchimento automático do navegador também entram na requisição.
    const teamConditions = Array.from(document.querySelectorAll('[data-team-condition="ownerTeam"]')).map((ownerInput) => {
        const index = ownerInput.dataset.index;
        const serviceInput = document.querySelector(`[data-team-condition="serviceFirstLevel"][data-index="${index}"]`);
        return {
            ownerTeam: ownerInput.value.trim(),
            serviceFirstLevel: serviceInput?.value?.trim() || ''
        };
    });
    _cfgTeamConditions = teamConditions;
    if (teamConditions.some(condition => !condition.ownerTeam)) {
        setCfgStatus('cfgMovideskConditionsStatus', 'Informe a equipe em cada condição adicional.', 'error');
        return;
    }
    
    const excludedBaseStatuses = [];
    if (document.getElementById('cfgExcludedResolved').checked) excludedBaseStatuses.push('Resolved');
    if (document.getElementById('cfgExcludedClosed').checked) excludedBaseStatuses.push('Closed');
    if (document.getElementById('cfgExcludedCanceled').checked) excludedBaseStatuses.push('Canceled');

    const selectFields = document.getElementById('cfgSelectFields')?.value?.trim() || '';
    const expandRelations = document.getElementById('cfgExpandRelations')?.value?.trim() || '';

    if (!selectFields.trim()) {
        setCfgStatus('cfgMovideskConditionsStatus', 'Campos a sincronizar não pode estar vazio.', 'error');
        return;
    }

    if (!expandRelations.trim()) {
        setCfgStatus('cfgMovideskConditionsStatus', 'Relações a expandir não pode estar vazio.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/config/movidesk-conditions`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                statuses,
                serviceFirstLevel,
                customFieldId,
                customFieldValue,
                syncLimit,
                ownerTeam,
                teamConditions,
                excludedBaseStatuses,
                selectFields,
                expandRelations
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || 'Falha ao salvar condições');
        }

        setCfgStatus('cfgMovideskConditionsStatus', 'Condições salvas com sucesso. Próxima sincronização usará os novos filtros.', 'ok');
    } catch (error) {
        setCfgStatus('cfgMovideskConditionsStatus', `Erro: ${error.message}`, 'error');
    }
}

function resetMovideskConditions() {
    setDefaultMovideskConditions();
    setCfgStatus('cfgMovideskConditionsStatus', 'Padrões restaurados. Clique em "Salvar condições" para aplicar.', 'ok');
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
        const response = await fetch(`${API_BASE}/curadoria/full-load`, { method: 'POST', headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Falha ao disparar pipeline');
        renderFullLoadStatus(data);
        startFullLoadPolling();
    } catch (error) {
        _setFullLoadButtonLoading(false);
        setCfgStatus('cfgFullLoadStatus', `Erro ao iniciar: ${error.message}`, 'error');
    }
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

