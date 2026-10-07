// Configurações → SLA e horas: controle de horas da Política de SLA (POL-SLA-001).
// Servidor: /api/sla-horas (server/routes/slaHoras.js) · regras puras em server/utils/slaPolitica.js. Só Suporte Técnico.
const SH = { aba: 'apuracao', cfg: null, padrao: null, statusConhecidos: null, apuracao: null, extrato: null };
const shEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shH = (h) => Number(h || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const shPct = (p) => (p == null ? '—' : `${Number(p).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
const shMin = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)}min`);
const shData = (v) => (v ? new Date(v).toLocaleDateString('pt-BR') : '—');
const shDataHora = (v) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const shCorPct = (p) => (p == null ? 'var(--t3)' : p >= 90 ? '#10b981' : p >= 80 ? '#f59e0b' : '#ef4444');
const shPlano = { padrao: 'Padrão', premium: 'Premium' };

async function shApi(caminho, metodo = 'GET', corpo) {
    const r = await fetch(`${API_BASE}/sla-horas${caminho}`, { method: metodo, headers: { ...authHeaders(), ...(corpo ? { 'Content-Type': 'application/json' } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Falha (${r.status})`);
    return d;
}
function shMsg(id, texto, erro) { const el = document.getElementById(id); if (el) { el.textContent = texto || ''; el.style.color = erro ? '#ef4444' : ''; } }

async function slaHorasCarregar() {
    const root = document.getElementById('shRoot'); if (!root) return;
    try { const c = await shApi('/config'); SH.cfg = c.config; SH.padrao = c.padrao; shRender(); }
    catch (e) { root.innerHTML = `<p class="config-status error">${shEsc(e.message)}</p>`; }
}
function shAba(a) { SH.aba = a; shRender(); }
function shRender() {
    const abas = [['apuracao', 'Apuração mensal'], ['extrato', 'Extrato de horas técnicas'], ['clientes', 'Clientes e planos'], ['parametros', 'Parâmetros da política']];
    document.getElementById('shRoot').innerHTML = `
      <div class="config-card">
        <h3 class="config-card-title">SLA e horas — Política POL-SLA-001</h3>
        <p class="config-card-help">Controle das <b>horas úteis</b> de cada chamado (Primeira Resposta e Resolução do Suporte, janela 08:30–12:00 e 13:30–18:00, sem feriados, descontando pausas) e do
          <b>extrato de horas técnicas</b> de crédito geradas quando o cumprimento mensal fica abaixo de 90%. Vale <b>só para chamados da classificação Suporte Técnico</b>;
          os demais seguem a previsão de solução do próprio chamado.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${abas.map(([k, r]) => `<button type="button" class="config-btn ${SH.aba === k ? '' : 'config-btn-muted'}" onclick="shAba('${k}')">${r}</button>`).join('')}</div>
      </div><div id="shCorpo"></div>`;
    ({ apuracao: shRenderApuracao, extrato: shRenderExtrato, clientes: shRenderClientes, parametros: shRenderParametros })[SH.aba]();
}

/* ── Apuração mensal ───────────────────────────────────────────── */
function shMesAnterior() { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function shRenderApuracao() {
    SH.comp = SH.comp || shMesAnterior();
    document.getElementById('shCorpo').innerHTML = `<div class="config-card">
        <h3 class="config-card-title">Apuração por competência (mês de encerramento)</h3>
        <p class="config-card-help">Cada chamado de Suporte Técnico entra no mês em que foi <b>encerrado</b>. Está dentro do SLA só se <b>todos</b> os marcos medidos foram cumpridos.
          O marco <b>Contorno ainda não é medido</b> (a equipe precisa definir como registrá-lo no Movidesk). Clientes sem plano cadastrado usam o plano padrão (${shPlano[SH.cfg.planoPadrao]}).</p>
        <label>Competência <input type="month" id="shComp" class="config-input" style="width:180px" value="${SH.comp}"></label>
        <button class="config-btn" type="button" onclick="shApurar()">Apurar</button> <span id="shApMsg" class="config-status"></span>
        <div id="shApRes" style="margin-top:12px"></div></div><div id="shDetalhe"></div>`;
    if (SH.apuracao && SH.apuracao.competencia === SH.comp) shDesenharApuracao();
}
async function shApurar() {
    SH.comp = document.getElementById('shComp').value; if (!SH.comp) return shMsg('shApMsg', 'Escolha a competência.', true);
    shMsg('shApMsg', 'Apurando… (pode levar alguns segundos)'); document.getElementById('shDetalhe').innerHTML = '';
    try { SH.apuracao = await shApi(`/apuracao?competencia=${SH.comp}`); shMsg('shApMsg', ''); shDesenharApuracao(); }
    catch (e) { shMsg('shApMsg', e.message, true); }
}
function shDesenharApuracao() {
    const a = SH.apuracao, box = document.getElementById('shApRes'); if (!box) return;
    setTimeout(shMostrarStatusAuto, 0);
    if (!a.clientes.length) { box.innerHTML = '<p class="config-card-help">Nenhum chamado de Suporte Técnico encerrado nesta competência.</p>'; return; }
    box.innerHTML = `<p style="margin:0 0 8px"><b>${a.total.clientes}</b> cliente(s) · <b>${a.chamados}</b> chamado(s) encerrados · avaliados <b>${a.total.avaliados}</b> · cumprimento geral
        <b style="color:${shCorPct(a.total.pct)}">${shPct(a.total.pct)}</b></p>
      <div style="overflow:auto;max-height:520px"><table class="config-table" style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left"><th>Cliente</th><th>Plano</th><th>Avaliados</th><th>Dentro</th><th>Fora</th><th>Global</th><th>Crítica+Alta</th><th>Crédito sugerido</th><th>Lançado</th><th></th></tr></thead><tbody>
        ${a.clientes.map((c) => `<tr style="border-top:1px solid var(--border)"><td>${shEsc(c.nome)}</td><td>${shPlano[c.plano]}${c.planoDefinido ? '' : ' <span title="Cliente sem plano cadastrado: assumido o plano padrão" style="color:var(--t3)">*</span>'}</td>
          <td>${c.avaliados}</td><td>${c.dentro}</td><td style="color:${c.fora ? '#ef4444' : 'inherit'}">${c.fora}</td>
          <td style="font-weight:800;color:${shCorPct(c.pct)}">${shPct(c.pct)}</td><td>${shPct(c.pctCriticaAlta)}</td>
          <td>${c.creditoSugerido ? `<b>${shH(c.creditoSugerido)} h</b>` : '—'}${c.gatilhoCritico ? ' <span title="Primeira Resposta de chamado Crítico acima do dobro do prazo (Anexo A.6)">⚡</span>' : ''}${c.acumula ? ` <span title="Menos de ${SH.cfg.minimoElegiveis} chamados avaliados: a apuração acumula (Seção 20.5)" style="color:#f59e0b">acumula</span>` : ''}</td>
          <td>${c.creditoLancado != null ? `${shH(c.creditoLancado)} h` : '—'}</td>
          <td><button class="config-btn config-btn-muted" type="button" onclick="shDetalheCliente('${shEsc(c.organizacao_id || 'sem:' + c.nome).replace(/'/g, '&#39;')}')">Chamados</button></td></tr>`).join('')}
        </tbody></table></div>
      <div style="margin-top:12px"><p class="config-card-help" style="margin:0 0 6px"><b>Lançamento automático:</b> ${SH.cfg.automatico.ativo ? `ligado — ao fechar cada mês o Hub apura e lança as horas técnicas sozinho (a partir de ${SH.cfg.automatico.desde}), uma vez por cliente e competência.` : '<span style="color:#f59e0b">desligado (ligue em Parâmetros)</span>'}
        Clientes com menos de ${SH.cfg.minimoElegiveis} chamados avaliados acumulam até 3 meses. <span id="shAutoSt"></span></p>
        <button class="config-btn config-btn-muted" type="button" onclick="shGerarCreditos()">Rodar a apuração automática agora</button>
        <button class="config-btn config-btn-muted" type="button" title="Reconsulta no Movidesk os chamados desta competência cujas respostas estão sem autor, para identificar a Primeira Resposta" onclick="shRepararAutores()">Corrigir autores das ações desta competência</button>
        <span id="shGerMsg" class="config-status"></span></div>`;
}
async function shMostrarStatusAuto() {
    try {
        const st = (await shApi('/automatico/status')).status, el = document.getElementById('shAutoSt'); if (!el) return;
        el.textContent = !st ? 'Ainda não rodou desde o último deploy (roda 2 minutos após subir e a cada hora).'
            : st.ok ? `Última rodada: ${shDataHora(st.em)} — ${st.lancados} crédito(s) lançado(s), ${st.acumulando} cliente(s) acumulando.` : `Última rodada falhou (${shDataHora(st.em)}): ${st.erro}`;
    } catch (_) { /* informativo */ }
}
async function shRepararAutores() {
    if (!confirm(`Reconsultar no Movidesk os chamados de ${SH.comp} cujas respostas estão sem autor? Roda em segundo plano (alguns minutos) e depois é só apurar de novo.`)) return;
    try {
        await shApi('/reparar-autores', 'POST', { competencia: SH.comp }); shMsg('shGerMsg', 'Reparo iniciado — acompanhando…');
        const t = setInterval(async () => {
            try {
                const r = (await shApi('/automatico/status')).reparo;
                shMsg('shGerMsg', r.rodando ? `Reparando autores: ${r.feitos}/${r.total}${r.falhas ? ` (${r.falhas} falha(s))` : ''}…` : `Reparo concluído: ${r.feitos}/${r.total} chamado(s) reconsultado(s). Apure de novo para ver o efeito.`);
                if (!r.rodando) clearInterval(t);
            } catch (_) { clearInterval(t); }
        }, 3000);
    } catch (e) { shMsg('shGerMsg', e.message, true); }
}
async function shDetalheCliente(org) {
    const box = document.getElementById('shDetalhe'); box.innerHTML = '<div class="config-card"><p class="config-card-help">Carregando…</p></div>';
    try {
        const d = await shApi(`/apuracao/detalhe?competencia=${SH.comp}&org=${encodeURIComponent(org)}`);
        const m = (x, c) => (!x.aplica ? '<span style="color:var(--t3)">n/a</span>' : x.dentro === null ? `<span style="color:var(--t3)" title="${shEsc((c && c.prMotivo && x.nome === 'Primeira Resposta') ? c.prMotivo : 'Sem registro para medir')}">não medido${(c && c.prMotivo && x.nome === 'Primeira Resposta') ? `<br><small>${shEsc(c.prMotivo)}</small>` : ''}</span>`
            : `<span style="color:${x.dentro ? '#10b981' : '#ef4444'};font-weight:700">${shMin(x.minutos)}</span> <span style="color:var(--t3)">/ ${shMin(x.prazo)}</span>`);
        box.innerHTML = `<div class="config-card"><h3 class="config-card-title">${shEsc(d.cliente ? d.cliente.nome : '')} — chamados de ${SH.comp} (plano ${d.cliente ? shPlano[d.cliente.plano] : ''})</h3>
          <div style="overflow:auto;max-height:420px"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left"><th>Chamado</th><th>Severidade</th><th>Primeira Resposta</th><th>Resolução do Suporte</th><th>Situação</th><th>Encerrado</th></tr></thead><tbody>
          ${d.chamados.map((c) => `<tr style="border-top:1px solid var(--border)"><td><a href="https://viasoft.movidesk.com/Ticket/Edit/${shEsc(c.id)}" target="_blank" rel="noopener">#${shEsc(c.id)}</a> <span style="color:var(--t3)">${shEsc((c.assunto || '').slice(0, 50))}</span></td>
          <td>${shEsc(c.severidade || 'sem urgência')}</td><td>${m(c.marcos.pr, c)}${c.prOrigem === 'estimado' ? ' <span title="Autor sem perfil registrado: identificado como equipe pelo nome (estimativa)" style="color:#f59e0b">~</span>' : ''}${c.prPor ? `<br><small style="color:var(--t3)">${shEsc(c.prPor)}</small>` : ''}</td><td>${m(c.marcos.resolucao, c)}</td>
          <td>${c.dentro === null ? '<span style="color:var(--t3)">não avaliado</span>' : c.dentro ? '<span style="color:#10b981">dentro</span>' : '<span style="color:#ef4444">fora</span>'}</td><td>${shDataHora(c.encerrado_em)}</td></tr>`).join('')}
          </tbody></table></div></div>`;
        box.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { box.innerHTML = `<div class="config-card"><p class="config-status error">${shEsc(e.message)}</p></div>`; }
}
async function shGerarCreditos() {
    shMsg('shGerMsg', 'Rodando… (pode levar alguns segundos por mês apurado)');
    try {
        const r = await shApi('/creditos/gerar', 'POST', {});
        const msg = r.ignorado ? `Nada feito: ${r.ignorado}.` : `${r.lancados.length} crédito(s) lançado(s); ${r.semCredito} cliente(s) sem crédito (cumprimento ≥ 90%); ${r.acumulando.length} acumulando para o próximo mês.`;
        SH.apuracao = await shApi(`/apuracao?competencia=${SH.comp}`); shDesenharApuracao(); shMsg('shGerMsg', msg);
    } catch (e) { shMsg('shGerMsg', e.message, true); }
}

/* ── Extrato de horas técnicas ─────────────────────────────────────── */
async function shRenderExtrato() {
    const c = document.getElementById('shCorpo'); c.innerHTML = '<div class="config-card"><p class="config-card-help">Carregando…</p></div>';
    try {
        const r = await shApi('/extrato/resumo'); SH.extrato = r.clientes;
        c.innerHTML = `<div class="config-card"><h3 class="config-card-title">Saldo de horas técnicas por cliente</h3>
          <p class="config-card-help">Créditos valem ${SH.cfg.validadeMeses} meses, não são conversíveis em dinheiro e só servem para serviços remotos e personalização. O uso consome primeiro o crédito que vence antes.</p>
          ${r.clientes.length ? `<div style="overflow:auto;max-height:480px"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left"><th>Cliente</th><th>Concedido</th><th>Usado</th><th>Disponível</th><th>Próximo a vencer</th><th>Expirado</th></tr></thead><tbody>
          ${r.clientes.map((x) => `<tr style="border-top:1px solid var(--border);cursor:pointer" onclick="shAbrirExtrato('${shEsc(x.organizacao_id).replace(/'/g, '&#39;')}','${shEsc(x.nome).replace(/'/g, '&#39;')}')"><td>${shEsc(x.nome)}</td><td>${shH(x.concedido)} h</td><td>${shH(x.usado)} h</td>
          <td style="font-weight:800">${shH(x.disponivel)} h</td><td>${x.aVencer ? `${shH(x.aVencer.horas)} h até ${shData(x.aVencer.validade)}` : '—'}</td><td style="color:${x.expirado ? '#f59e0b' : 'inherit'}">${shH(x.expirado)} h</td></tr>`).join('')}</tbody></table></div>`
            : '<p class="config-card-help">Ainda não há créditos lançados. Eles nascem da Apuração mensal.</p>'}</div><div id="shExtratoDet"></div>`;
    } catch (e) { c.innerHTML = `<div class="config-card"><p class="config-status error">${shEsc(e.message)}</p></div>`; }
}
async function shAbrirExtrato(org, nome) {
    const box = document.getElementById('shExtratoDet'); box.innerHTML = '<div class="config-card"><p class="config-card-help">Carregando…</p></div>';
    try {
        const d = await shApi(`/extrato/${encodeURIComponent(org)}`);
        const rot = { credito: 'Crédito', uso: 'Uso', ajuste: 'Ajuste' };
        box.innerHTML = `<div class="config-card"><h3 class="config-card-title">${shEsc(nome)} — disponível: ${shH(d.saldo.disponivel)} h</h3>
          <div style="overflow:auto;max-height:320px"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left"><th>Data</th><th>Tipo</th><th>Horas</th><th>Competência</th><th>Validade</th><th>Motivo</th><th>Por</th></tr></thead><tbody>
          ${d.lancamentos.map((l) => `<tr style="border-top:1px solid var(--border)"><td>${shDataHora(l.criado_em)}</td><td>${l.tipo === 'credito' && !l.horas ? 'Apurado (sem crédito)' : (rot[l.tipo] || l.tipo)}</td><td style="color:${l.tipo === 'uso' || l.horas < 0 ? '#ef4444' : l.horas ? '#10b981' : 'var(--t3)'};font-weight:700">${l.tipo === 'uso' ? '−' : ''}${shH(l.horas)}</td>
          <td>${shEsc(l.competencia || '—')}</td><td>${shData(l.validade)}</td><td>${shEsc(l.motivo || '')}</td><td>${shEsc(l.criado_por || '')}</td></tr>`).join('')}</tbody></table></div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:end">
            <label>Horas <input id="shUsoH" type="number" step="0.25" min="0.25" class="config-input" style="width:110px"></label>
            <label style="flex:1;min-width:260px">Motivo / serviço prestado <input id="shUsoM" class="config-input" maxlength="400" placeholder="Ex.: personalização do relatório de comissões (chamado 123456)"></label>
            <button class="config-btn" type="button" onclick="shRegistrar('uso','${shEsc(org).replace(/'/g, '&#39;')}','${shEsc(nome).replace(/'/g, '&#39;')}')">Registrar uso</button>
            <button class="config-btn config-btn-muted" type="button" title="Só administrador: corrige o saldo (use + ou −)" onclick="shRegistrar('ajuste','${shEsc(org).replace(/'/g, '&#39;')}','${shEsc(nome).replace(/'/g, '&#39;')}')">Ajuste (admin)</button>
            <span id="shUsoMsg" class="config-status"></span></div></div>`;
        box.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { box.innerHTML = `<div class="config-card"><p class="config-status error">${shEsc(e.message)}</p></div>`; }
}
async function shRegistrar(tipo, org, nome) {
    const horas = Number(document.getElementById('shUsoH').value), motivo = document.getElementById('shUsoM').value;
    if (!horas) return shMsg('shUsoMsg', 'Informe as horas.', true);
    try { await shApi(`/extrato/${tipo}`, 'POST', { organizacao_id: org, nome, horas, motivo }); await shAbrirExtrato(org, nome); shMsg('shUsoMsg', 'Registrado.'); }
    catch (e) { shMsg('shUsoMsg', e.message, true); }
}

/* ── Clientes e planos ────────────────────────────────────────────── */
async function shRenderClientes() {
    const c = document.getElementById('shCorpo');
    try {
        const r = await shApi(`/clientes?q=${encodeURIComponent(SH.q || '')}`);
        const sel = (id, atual) => `<select id="${id}" class="config-input" style="width:130px"><option value="padrao" ${atual === 'padrao' ? 'selected' : ''}>Padrão</option><option value="premium" ${atual === 'premium' ? 'selected' : ''}>Premium</option></select>`;
        c.innerHTML = `<div class="config-card"><h3 class="config-card-title">Plano de suporte por cliente</h3>
          <p class="config-card-help">Quem não estiver na lista usa o plano padrão (${shPlano[SH.cfg.planoPadrao]}). O Premium tem prazos mais curtos (Anexo A.2). Procure a organização pelo nome para cadastrar.</p>
          <input id="shBusca" class="config-input" style="max-width:360px" placeholder="Buscar organização (mín. 2 letras)" value="${shEsc(SH.q || '')}" onkeydown="if(event.key==='Enter')shBuscar()"> <button class="config-btn" type="button" onclick="shBuscar()">Buscar</button>
          ${r.busca.length ? `<div style="margin-top:10px">${r.busca.map((o, i) => `<div style="display:flex;gap:8px;align-items:center;padding:4px 0">${shEsc(o.organizacao_nome)} ${sel('shNovo' + i, 'premium')}
            <button class="config-btn config-btn-muted" type="button" onclick="shSalvarPlano('${shEsc(o.organizacao_id).replace(/'/g, '&#39;')}','${shEsc(o.organizacao_nome).replace(/'/g, '&#39;')}','shNovo${i}')">Definir</button></div>`).join('')}</div>` : ''}
          <span id="shClMsg" class="config-status"></span></div>
        <div class="config-card"><h3 class="config-card-title">Clientes com plano definido (${r.definidos.length})</h3>
          ${r.definidos.length ? r.definidos.map((o, i) => `<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--border)"><span style="flex:1">${shEsc(o.organizacao_nome || o.organizacao_id)}</span>${sel('shDef' + i, o.plano)}
            <button class="config-btn config-btn-muted" type="button" onclick="shSalvarPlano('${shEsc(o.organizacao_id).replace(/'/g, '&#39;')}','${shEsc(o.organizacao_nome || '').replace(/'/g, '&#39;')}','shDef${i}')">Salvar</button>
            <button class="config-btn config-btn-muted" type="button" onclick="shRemoverPlano('${shEsc(o.organizacao_id).replace(/'/g, '&#39;')}')">Remover</button></div>`).join('') : '<p class="config-card-help">Nenhum ainda — todos usam o plano padrão.</p>'}</div>`;
    } catch (e) { c.innerHTML = `<div class="config-card"><p class="config-status error">${shEsc(e.message)}</p></div>`; }
}
function shBuscar() { SH.q = document.getElementById('shBusca').value.trim(); shRenderClientes(); }
async function shSalvarPlano(org, nome, selId) {
    try { await shApi(`/clientes/${encodeURIComponent(org)}`, 'PUT', { plano: document.getElementById(selId).value, nome }); SH.q = ''; await shRenderClientes(); shMsg('shClMsg', 'Plano salvo.'); }
    catch (e) { shMsg('shClMsg', e.message, true); }
}
async function shRemoverPlano(org) {
    try { await shApi(`/clientes/${encodeURIComponent(org)}`, 'PUT', { plano: null }); await shRenderClientes(); } catch (e) { shMsg('shClMsg', e.message, true); }
}

/* ── Parâmetros ─────────────────────────────────────────────────────── */
async function shRenderParametros() {
    const c = document.getElementById('shCorpo'), g = SH.cfg;
    if (!SH.statusConhecidos) { try { SH.statusConhecidos = (await shApi('/status-conhecidos')).status; } catch (_) { SH.statusConhecidos = []; } }
    const nomes = [...new Set([...g.pausas, ...SH.statusConhecidos.map((s) => s.status)])];
    const cont = Object.fromEntries(SH.statusConhecidos.map((s) => [s.status, s.n]));
    const prazos = (plano) => `<table style="font-size:13px"><thead><tr style="text-align:left"><th>Severidade</th><th>Primeira Resposta (min)</th><th>Contorno (min)</th><th>Resolução (min)</th></tr></thead><tbody>
      ${['Crítica', 'Alta', 'Média', 'Baixa'].map((s) => `<tr><td>${s}</td>${['pr', 'contorno', 'resolucao'].map((k) => `<td><input class="config-input" style="width:100px" type="number" min="1" data-pl="${plano}" data-sev="${s}" data-k="${k}" value="${g.planos[plano][s][k] ?? ''}" placeholder="n/a"></td>`).join('')}</tr>`).join('')}</tbody></table>`;
    c.innerHTML = `<div class="config-card"><h3 class="config-card-title">Parâmetros da política</h3>
      <p class="config-card-help">Tudo aqui é editável: a política pode mudar (Seção 24) sem alterar código. Prazos em <b>minutos úteis</b> (60 = 1 h; 480 = 1 dia útil de 8 h). Só administrador salva.</p>
      <h4>Lançamento automático das horas técnicas</h4>
      <label style="display:block"><input type="checkbox" id="shAutoAtivo" ${g.automatico.ativo ? 'checked' : ''}> Apurar e lançar sozinho ao fechar cada mês</label>
      <label>Apurar a partir de <input type="month" id="shAutoDesde" class="config-input" style="width:170px" value="${g.automatico.desde}"></label>
      <p class="config-card-help">A política vale desde 01/08/2026. Meses anteriores à data acima nunca são lançados. Cuidado ao antecipar a data: ao salvar e na próxima rodada, os meses entre ela e hoje passam a gerar crédito.</p>
      <h4>Janela de atendimento (segunda a sexta)</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${g.janela.map((j, i) => `<span><input type="time" class="config-input" id="shJi${i}" value="${j[0]}"> às <input type="time" class="config-input" id="shJf${i}" value="${j[1]}"></span>`).join('')}</div>
      <h4>Feriados (um por linha: AAAA-MM-DD Nome)</h4>
      <p class="config-card-help">Já vem com os nacionais de 2026 e o estadual do PR — <b>confira</b> e acrescente os municipais de Pato Branco/PR e os de 2027.</p>
      <textarea id="shFeriados" class="config-input" style="min-height:140px;width:100%">${shEsc(g.feriados.map((f) => `${f.data} ${f.nome}`).join('\n'))}</textarea>
      <h4>Status que pausam o relógio</h4>
      <p class="config-card-help">Marque os status do Movidesk em que a contagem fica suspensa (aguardando cliente/terceiro/validação e chamado encerrado). A lista vem das ações dos últimos 12 meses.</p>
      <div style="columns:2;max-height:240px;overflow:auto">${nomes.map((n, i) => `<label style="display:block"><input type="checkbox" class="shPausa" value="${shEsc(n)}" ${g.pausas.some((p) => P_sem(p) === P_sem(n)) ? 'checked' : ''}> ${shEsc(n)} <span style="color:var(--t3)">${cont[n] ? cont[n] + ' ações' : ''}</span></label>`).join('')}</div>
      <h4>Autores automáticos (não valem como Primeira Resposta)</h4>
      <p class="config-card-help">Nomes (um por linha) de usuários usados por automações, como os Avisos automáticos. A Primeira Resposta exige interação humana (Seção 2).</p>
      <textarea id="shAutores" class="config-input" style="min-height:70px;width:100%">${shEsc(g.autoresAutomaticos.join('\n'))}</textarea>
      <h4>Plano padrão</h4>
      <select id="shPlanoPadrao" class="config-input" style="width:160px"><option value="padrao" ${g.planoPadrao === 'padrao' ? 'selected' : ''}>Padrão</option><option value="premium" ${g.planoPadrao === 'premium' ? 'selected' : ''}>Premium</option></select>
      <h4>Prazos — Suporte Padrão (Anexo A.1)</h4>${prazos('padrao')}
      <h4>Prazos — Suporte Premium (Anexo A.2)</h4>${prazos('premium')}
      <h4>Créditos por desempenho mensal (Anexo A.5)</h4>
      <div id="shCred">${g.creditos.map((f, i) => `<div>cumprimento ≥ <input class="config-input shCredMin" style="width:80px" type="number" step="0.01" value="${f.min}">% → <input class="config-input shCredH" style="width:80px" type="number" step="0.5" value="${f.horas}"> h técnicas</div>`).join('')}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
        <label>Gatilho Crítico (A.6), horas mín. <input id="shGat" class="config-input" style="width:90px" type="number" value="${g.gatilhoCriticoHoras}"></label>
        <label>Limite mensal (A.7), horas <input id="shLim" class="config-input" style="width:90px" type="number" value="${g.limiteMensalHoras}"></label>
        <label>Validade do crédito (meses) <input id="shVal" class="config-input" style="width:90px" type="number" value="${g.validadeMeses}"></label>
        <label>Mínimo de chamados avaliados <input id="shMinEl" class="config-input" style="width:90px" type="number" value="${g.minimoElegiveis}"></label></div>
      <div style="margin-top:14px"><button class="config-btn" type="button" onclick="shSalvarParametros()">Salvar parâmetros</button>
        <button class="config-btn config-btn-muted" type="button" onclick="shRestaurar()">Restaurar o padrão da política</button> <span id="shParMsg" class="config-status"></span></div></div>`;
}
const P_sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
async function shSalvarParametros() {
    const g = JSON.parse(JSON.stringify(SH.cfg));
    g.janela = g.janela.map((_, i) => [document.getElementById('shJi' + i).value, document.getElementById('shJf' + i).value]);
    g.feriados = document.getElementById('shFeriados').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ data: l.slice(0, 10), nome: l.slice(11).trim() }));
    g.pausas = [...document.querySelectorAll('.shPausa:checked')].map((x) => x.value);
    g.autoresAutomaticos = document.getElementById('shAutores').value.split('\n').map((l) => l.trim()).filter(Boolean);
    g.planoPadrao = document.getElementById('shPlanoPadrao').value;
    document.querySelectorAll('input[data-pl]').forEach((i) => { g.planos[i.dataset.pl][i.dataset.sev][i.dataset.k] = i.value === '' ? null : Number(i.value); });
    g.creditos = [...document.querySelectorAll('.shCredMin')].map((x, i) => ({ min: Number(x.value), horas: Number(document.querySelectorAll('.shCredH')[i].value) }));
    g.automatico = { ativo: document.getElementById('shAutoAtivo').checked, desde: document.getElementById('shAutoDesde').value || '2026-08' };
    g.gatilhoCriticoHoras = Number(document.getElementById('shGat').value); g.limiteMensalHoras = Number(document.getElementById('shLim').value);
    g.validadeMeses = Number(document.getElementById('shVal').value); g.minimoElegiveis = Number(document.getElementById('shMinEl').value);
    try { SH.cfg = (await shApi('/config', 'PUT', { config: g })).config; SH.apuracao = null; shMsg('shParMsg', 'Parâmetros salvos. A próxima apuração já usa os novos valores.'); }
    catch (e) { shMsg('shParMsg', e.message, true); }
}
async function shRestaurar() {
    if (!confirm('Voltar todos os parâmetros ao padrão da política? Os feriados cadastrados também serão substituídos.')) return;
    try { SH.cfg = (await shApi('/config', 'PUT', { config: SH.padrao })).config; SH.apuracao = null; shRenderParametros(); } catch (e) { shMsg('shParMsg', e.message, true); }
}
