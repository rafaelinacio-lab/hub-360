// ── pessoasImportar.js — Configurações → Acesso → Pessoas → "Importar planilha" ─────────────────────────────────
// Cadastro em massa: o admin sobe um .xlsx ou .csv (Nome, E-mail, Perfil, Verticais), confere a prévia com a validação de cada linha
// (e-mail, perfil, verticais, repetidos e já cadastrados) e importa. A planilha é lida AQUI, no navegador (o .xlsx usa ExcelJS, carregado só
// quando preciso); o servidor recebe lotes de 25 linhas em POST /api/pessoas/importar, valida tudo de novo e devolve o resultado por linha.
let _pi = { linhas: [], resultados: null, trabalhando: false };
const piEsc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const piSemAc = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const PI_PERFIS = { admin: 'admin', administrador: 'admin', supervisor: 'supervisor', atendente: 'atendente', guest: 'guest', 'sem perfil': 'guest' };
const PI_PERFIL_ROTULO = { admin: 'Admin', supervisor: 'Supervisor', atendente: 'Atendente', guest: 'Sem perfil' };
const PI_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const piVerticaisPermitidas = () => [...document.querySelectorAll('#pmVertical input[type=checkbox]')].map((i) => i.value);

function piErro(msg) { const e = document.getElementById('piErro'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }

async function pessoasImportarAbrir() {
    _pi = { linhas: [], resultados: null, trabalhando: false };
    piErro('');
    document.getElementById('piArquivo').value = '';
    document.getElementById('piPasso1').style.display = '';
    document.getElementById('piPasso2').style.display = 'none';
    ['piImportar', 'piBaixarRes'].forEach((id) => { document.getElementById(id).style.display = 'none'; });
    document.getElementById('piFechar').textContent = 'Cancelar';
    // perfis do servidor para o "perfil padrão"
    try {
        const r = await fetch(`${PESSOAS_API}/roles`, { headers: authHeaders() });
        const roles = r.ok ? await r.json() : [];
        const sel = document.getElementById('piPerfilPadrao');
        const nomes = roles.map((x) => x.name).filter((n) => PI_PERFIL_ROTULO[n]);
        sel.innerHTML = (nomes.length ? nomes : ['guest', 'atendente', 'supervisor', 'admin']).map((n) => `<option value="${n}">${PI_PERFIL_ROTULO[n]}</option>`).join('');
        sel.value = nomes.includes('atendente') || !nomes.length ? 'atendente' : nomes[0];
    } catch (_) { /* usa a lista fixa */ }
    // pessoas já cadastradas (para marcar "já cadastrado" na prévia)
    try { if (typeof _pessoasAllUsers === 'undefined' || !_pessoasAllUsers || !_pessoasAllUsers.length) await pessoasLoad(); } catch (_) { /* a prévia segue sem essa marcação; o servidor confere */ }
    document.getElementById('pessoaImportModal').style.display = 'flex';
}
function pessoasImportarFechar() { if (_pi.trabalhando) return; document.getElementById('pessoaImportModal').style.display = 'none'; }

// ── leitura do arquivo ──
let _excelJsPromise = null;
function piCarregarExcelJS() {
    if (window.ExcelJS) return Promise.resolve();
    if (_excelJsPromise) return _excelJsPromise;
    _excelJsPromise = new Promise((ok, falha) => {
        const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
        s.onload = ok; s.onerror = () => { _excelJsPromise = null; falha(new Error('Não foi possível carregar a biblioteca de planilhas (sem internet?). Salve como .csv e tente de novo.')); };
        document.head.appendChild(s);
    });
    return _excelJsPromise;
}
// CSV com separador ; , ou tab, aspas e BOM
function piCsv(texto) {
    texto = texto.replace(/^﻿/, '');
    const primeira = texto.split(/\r?\n/, 1)[0] || '';
    const sep = [';', '\t', ','].map((c) => [c, primeira.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    const linhas = []; let linha = [], campo = '', aspas = false;
    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        if (aspas) { if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += c; }
        else if (c === '"') aspas = true;
        else if (c === sep) { linha.push(campo); campo = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && texto[i + 1] === '\n') i++; linha.push(campo); campo = ''; linhas.push(linha); linha = []; }
        else campo += c;
    }
    if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}
async function piLerMatriz(arquivo) {
    if (/\.xlsx$/i.test(arquivo.name)) {
        await piCarregarExcelJS();
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await arquivo.arrayBuffer());
        const ws = wb.worksheets[0]; if (!ws) throw new Error('A planilha está vazia.');
        const m = [];
        ws.eachRow({ includeEmpty: false }, (row) => { const v = []; for (let c = 1; c <= Math.max(row.cellCount, 6); c++) { const cel = row.getCell(c); v.push(cel && cel.text != null ? String(cel.text) : ''); } m.push(v); });
        return m;
    }
    if (/\.xls$/i.test(arquivo.name)) throw new Error('Arquivo .xls antigo: salve como .xlsx ou .csv.');
    const buf = await arquivo.arrayBuffer();
    let t = new TextDecoder('utf-8').decode(buf);
    if (t.includes('�')) t = new TextDecoder('windows-1252').decode(buf);   // CSV salvo pelo Excel em português
    return piCsv(t);
}
function piMapaColunas(cab) {
    const idx = {}; cab.forEach((h, i) => {
        const t = piSemAc(h);
        if (idx.nome == null && /^(nome|name|colaborador|pessoa)/.test(t)) idx.nome = i;
        else if (idx.email == null && /e-?mail|correio/.test(t)) idx.email = i;
        else if (idx.perfil == null && /perfil|papel|role|acesso/.test(t)) idx.perfil = i;
        else if (idx.verticais == null && /vertical|verticais/.test(t)) idx.verticais = i;
    });
    return idx;
}
async function pessoasImportarLer(arquivo) {
    if (!arquivo) return;
    piErro('');
    try {
        const m = (await piLerMatriz(arquivo)).filter((l) => l.some((c) => String(c).trim() !== ''));
        if (m.length < 2) throw new Error('Não encontrei linhas de dados. A primeira linha deve ter os títulos das colunas.');
        const idx = piMapaColunas(m[0]);
        if (idx.email == null || idx.nome == null) throw new Error('Não achei as colunas "Nome" e "E-mail" na primeira linha. Baixe o modelo para ver o formato.');
        _pi.linhas = m.slice(1, 1001).map((l, i) => ({ n: i + 2, nome: String(l[idx.nome] || '').trim(), email: String(l[idx.email] || '').trim().toLowerCase(), perfil: idx.perfil != null ? String(l[idx.perfil] || '').trim() : '', verticais: idx.verticais != null ? String(l[idx.verticais] || '').trim() : '' }));
        if (m.length - 1 > 1000) piErro('O arquivo tem mais de 1000 linhas: só as 1000 primeiras foram lidas. Importe o restante em outro arquivo.');
        document.getElementById('piPasso2').style.display = 'flex';
        pessoasImportarRevisar();
    } catch (e) { piErro(e.message || 'Não foi possível ler o arquivo.'); }
}

// ── prévia e validação (o servidor valida de novo) ──
function pessoasImportarRevisar() {
    if (_pi.resultados) return;
    const existentes = new Set(((typeof _pessoasAllUsers !== 'undefined' && _pessoasAllUsers) || []).map((u) => String(u.email).toLowerCase()));
    const atualizar = document.getElementById('piExistentes').value === 'atualizar', padrao = document.getElementById('piPerfilPadrao').value || 'atendente';
    const permitidas = new Map(piVerticaisPermitidas().map((v) => [piSemAc(v), v])), vistos = new Set();
    _pi.linhas.forEach((l) => {
        l.erro = ''; l.acao = 'novo';
        const rot = piSemAc(l.perfil) || padrao; l.perfilFinal = PI_PERFIS[rot] || rot;
        const vs = [...new Set(l.verticais.split(/[;|]/).map((x) => x.trim()).filter(Boolean))];
        const ruins = vs.filter((v) => !permitidas.has(piSemAc(v)));
        l.verticaisFinal = vs.filter((v) => permitidas.has(piSemAc(v))).map((v) => permitidas.get(piSemAc(v))).join('; ');
        if (!l.nome) l.erro = 'Falta o nome';
        else if (!l.email) l.erro = 'Falta o e-mail';
        else if (!PI_EMAIL.test(l.email)) l.erro = 'E-mail inválido';
        else if (!PI_PERFIL_ROTULO[l.perfilFinal]) l.erro = `Perfil inválido: ${l.perfil}`;
        else if (ruins.length) l.erro = `Vertical inválida: ${ruins.join(', ')}`;
        else if (vistos.has(l.email)) l.acao = 'repetido';
        else if (existentes.has(l.email)) l.acao = atualizar ? 'atualizar' : 'existente';
        if (!l.erro) vistos.add(l.email);
    });
    const c = (a) => _pi.linhas.filter((l) => !l.erro && l.acao === a).length, erros = _pi.linhas.filter((l) => l.erro).length;
    const novos = c('novo'), atu = c('atualizar');
    document.getElementById('piResumo').innerHTML = `${_pi.linhas.length} linha(s): <span style="color:#16a34a">${novos} nova(s)</span>` +
        (atu ? ` · <span style="color:#2563eb">${atu} para atualizar</span>` : '') + (c('existente') ? ` · ${c('existente')} já cadastrada(s) (serão ignoradas)` : '') + (c('repetido') ? ` · ${c('repetido')} repetida(s) no arquivo` : '') +
        (erros ? ` · <span style="color:#dc2626">${erros} com erro (não serão importadas)</span>` : '');
    const rot = { novo: ['Nova', '#16a34a'], atualizar: ['Atualizar', '#2563eb'], existente: ['Já cadastrada — ignorar', '#6b7280'], repetido: ['Repetida no arquivo', '#6b7280'] };
    document.getElementById('piLinhas').innerHTML = _pi.linhas.map((l) => `<tr><td>${l.n}</td><td>${piEsc(l.nome)}</td><td>${piEsc(l.email)}</td><td>${piEsc(PI_PERFIL_ROTULO[l.perfilFinal] || l.perfil)}${l.perfilFinal === 'admin' ? ' <b style="color:#dc2626" title="Acesso total">⚠</b>' : ''}</td><td>${piEsc(l.verticaisFinal || l.verticais || '— (vê todas)')}</td>` +
        `<td style="font-weight:600;color:${l.erro ? '#dc2626' : rot[l.acao][1]}">${l.erro ? piEsc(l.erro) : rot[l.acao][0]}</td></tr>`).join('');
    const total = novos + atu, btn = document.getElementById('piImportar');
    btn.style.display = ''; btn.disabled = !total; btn.textContent = total ? `Importar ${total} pessoa(s)` : 'Nada para importar';
}

// ── importação em lotes ──
async function pessoasImportarExecutar() {
    const alvo = _pi.linhas.filter((l) => !l.erro && (l.acao === 'novo' || l.acao === 'atualizar'));
    if (!alvo.length || _pi.trabalhando) return;
    const admins = alvo.filter((l) => l.perfilFinal === 'admin').length;
    if (!confirm(`Importar ${alvo.length} pessoa(s)?${admins ? `\n\n⚠ ${admins} delas terão perfil ADMIN (acesso total).` : ''}${document.getElementById('piEmail').checked ? '\n\nElas receberão o e-mail de boas-vindas.' : ''}`)) return;
    _pi.trabalhando = true; _pi.resultados = []; piErro('');
    const btn = document.getElementById('piImportar'); btn.disabled = true;
    const enviarEmail = document.getElementById('piEmail').checked, atualizarExistentes = document.getElementById('piExistentes').value === 'atualizar';
    try {
        for (let i = 0; i < alvo.length; i += 25) {
            const lote = alvo.slice(i, i + 25);
            btn.textContent = `Importando… ${Math.min(i + 25, alvo.length)}/${alvo.length}`;
            const r = await fetch(`${PESSOAS_API}/importar`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ enviarEmail, atualizarExistentes, pessoas: lote.map((l) => ({ nome: l.nome, email: l.email, perfil: l.perfilFinal, verticais: l.verticaisFinal })) }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `Falha ao importar (HTTP ${r.status})`);
            _pi.resultados.push(...d.resultados);
        }
    } catch (e) { piErro(`${e.message}. O que já foi importado ficou salvo: confira a lista de pessoas antes de tentar de novo.`); }
    _pi.trabalhando = false;
    const res = _pi.resultados, n = (s) => res.filter((x) => x.status === s).length;
    const sem = res.filter((x) => x.status === 'criado' && x.envio && x.envio !== 'enviado').length;
    document.getElementById('piResumo').innerHTML = `<span style="color:#16a34a">${n('criado')} criada(s)</span>` + (n('atualizado') ? ` · <span style="color:#2563eb">${n('atualizado')} atualizada(s)</span>` : '') + (n('ignorado') ? ` · ${n('ignorado')} ignorada(s)` : '') + (n('erro') ? ` · <span style="color:#dc2626">${n('erro')} com erro</span>` : '') +
        (sem ? ` · <span style="color:#d97706">${sem} sem e-mail de boas-vindas (envio não configurado ou falhou; use ✉️ na lista para reenviar)</span>` : '');
    const porEmail = new Map(res.map((x) => [x.email, x]));
    document.getElementById('piLinhas').innerHTML = _pi.linhas.map((l) => { const x = porEmail.get(l.email); const st = x ? (x.status === 'criado' ? ['Criada' + (x.envio === 'enviado' ? ' · e-mail enviado' : x.envio ? ' · e-mail não enviado' : ''), '#16a34a'] : x.status === 'atualizado' ? ['Atualizada', '#2563eb'] : x.status === 'ignorado' ? [x.motivo || 'Ignorada', '#6b7280'] : [x.motivo || 'Erro', '#dc2626']) : [l.erro || 'Não enviada', l.erro ? '#dc2626' : '#6b7280'];
        return `<tr><td>${l.n}</td><td>${piEsc(l.nome)}</td><td>${piEsc(l.email)}</td><td>${piEsc(PI_PERFIL_ROTULO[l.perfilFinal] || l.perfil)}</td><td>${piEsc(l.verticaisFinal || '— (vê todas)')}</td><td style="font-weight:600;color:${st[1]}">${piEsc(st[0])}</td></tr>`; }).join('');
    btn.style.display = 'none'; document.getElementById('piBaixarRes').style.display = ''; document.getElementById('piFechar').textContent = 'Fechar';
    try { pessoasLoad(); } catch (_) { /* a lista atualiza ao reabrir a aba */ }
}
function piBaixar(nome, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function pessoasImportarBaixarResultado() {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`, rot = { criado: 'Criada', atualizado: 'Atualizada', ignorado: 'Ignorada', erro: 'Erro' };
    const linhas = (_pi.resultados || []).map((x) => [x.nome, x.email, rot[x.status] || x.status, x.motivo || '', x.envio || ''].map(q).join(';'));
    piBaixar(`importacao-pessoas-${new Date().toISOString().slice(0, 10)}.csv`, new Blob(['﻿' + ['Nome;E-mail;Resultado;Motivo;E-mail de boas-vindas', ...linhas].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
}

// ── modelo ──
async function pessoasImportarModelo(tipo) {
    const cab = ['Nome', 'E-mail', 'Perfil', 'Verticais'], ex = [['Maria da Silva', 'maria.silva@viasoft.com.br', 'atendente', 'Agronegócio; Construshow'], ['João Souza', 'joao.souza@viasoft.com.br', 'supervisor', '']];
    if (tipo === 'csv') { piBaixar('modelo-importacao-pessoas.csv', new Blob(['﻿' + [cab, ...ex].map((l) => l.map((v) => `"${v}"`).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' })); return; }
    try {
        await piCarregarExcelJS();
        const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Pessoas'), op = wb.addWorksheet('Opções');
        ws.addRow(cab); ex.forEach((l) => ws.addRow(l));
        ws.getRow(1).font = { bold: true }; ws.columns = [{ width: 32 }, { width: 38 }, { width: 16 }, { width: 50 }];
        const perfis = ['admin', 'supervisor', 'atendente', 'sem perfil'], verts = piVerticaisPermitidas();
        op.addRow(['Perfis', 'Verticais (use as que quiser, separadas por ";")']); op.getRow(1).font = { bold: true };
        for (let i = 0; i < Math.max(perfis.length, verts.length); i++) op.addRow([perfis[i] || '', verts[i] || '']);
        op.columns = [{ width: 18 }, { width: 46 }];
        for (let r = 2; r <= 500; r++) ws.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"admin,supervisor,atendente,sem perfil"'] };
        piBaixar('modelo-importacao-pessoas.xlsx', new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) { piErro(e.message || 'Não foi possível gerar o modelo .xlsx; baixe o .csv.'); }
}
