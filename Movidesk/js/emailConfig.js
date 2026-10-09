// ── emailConfig.js — Configurações → E-mail (SMTP) ─────────────────────────────────────────────
async function emailCfgCarregar() {
    try {
        const res = await fetch(`${API_BASE}/email-config`, { headers: authHeaders() });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Falha ao ler a configuração');
        document.getElementById('cfgEmailHost').value = d.host || '';
        document.getElementById('cfgEmailPort').value = d.port || '';
        document.getElementById('cfgEmailUser').value = d.user || '';
        document.getElementById('cfgEmailFrom').value = d.from || '';
        document.getElementById('cfgEmailUrl').value = d.publicUrl || '';
        const pass = document.getElementById('cfgEmailPass');
        pass.value = '';
        pass.placeholder = d.senhaDefinida ? '•••••••• (definida — deixe em branco para manter)' : 'Cole a senha de app';
        const dest = document.getElementById('cfgEmailTesteDest');
        if (dest && !dest.value && typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email) dest.value = _currentUser.email;
        setCfgStatus('cfgEmailStatus', d.configurado
            ? `E-mail configurado${d.origem === 'env' ? ' (pelo .env do servidor)' : ''}.`
            : 'E-mail ainda não configurado: preencha usuário e senha de app.', d.configurado ? 'ok' : '');
    } catch (e) {
        setCfgStatus('cfgEmailStatus', `Erro: ${e.message}`, 'error');
    }
}

async function emailCfgSalvar() {
    const v = (id) => document.getElementById(id).value.trim();
    const btn = document.getElementById('cfgEmailSalvar');
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/email-config`, {
            method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ host: v('cfgEmailHost'), port: v('cfgEmailPort'), user: v('cfgEmailUser'), pass: document.getElementById('cfgEmailPass').value, from: v('cfgEmailFrom'), publicUrl: v('cfgEmailUrl') })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Falha ao salvar');
        await emailCfgCarregar();
        setCfgStatus('cfgEmailStatus', 'Configuração salva. Use "Enviar teste" para conferir.', 'ok');
    } catch (e) {
        setCfgStatus('cfgEmailStatus', `Erro ao salvar: ${e.message}`, 'error');
    } finally { btn.disabled = false; }
}

async function emailCfgTestar() {
    const btn = document.getElementById('cfgEmailTesteBtn');
    const para = document.getElementById('cfgEmailTesteDest').value.trim();
    btn.disabled = true;
    setCfgStatus('cfgEmailTesteStatus', 'Enviando…');
    try {
        const res = await fetch(`${API_BASE}/email-config/teste`, {
            method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ para })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Falha ao enviar');
        setCfgStatus('cfgEmailTesteStatus', `E-mail enviado para ${d.para}. Confira a caixa de entrada (e o spam).`, 'ok');
    } catch (e) {
        setCfgStatus('cfgEmailTesteStatus', e.message, 'error');
    } finally { btn.disabled = false; }
}
