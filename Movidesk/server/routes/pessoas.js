const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { validateEmail } = require('../utils/auth');
const { authMiddleware, requireRole } = require('./auth');
const { enviarBoasVindas } = require('../utils/emailBoasVindas');
const { rateLimit } = require('../utils/rateLimit');

const ALLOWED_VERTICALS = [
  'Agronegócio','Agrotitan Fazendas','Analytics - B.I','Automação Comercial',
  'Combustíveis','Comitê de IA','Construshow','CRM','Filt','Fisco Contábil',
  'GCC','Oracle Cloud','Ouvidoria','Serviços','Sistema para RH','Sistemas Internos',
  'Supermercados','Tecnologia','Viabot','Voors'
];

// Vertical pode ser uma LISTA ("Agronegócio; Construshow"): a tela marca várias e verticalScope.js também lê assim
// (separador ; ou |). Valida cada uma contra ALLOWED_VERTICALS (sem diferenciar maiúscula/acento) e devolve a lista
// normalizada ("A; B") ou { invalidas: [...] }.
const semAcentoV = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
function normalizarVerticais(entrada) {
  const itens = [...new Set(String(entrada == null ? '' : entrada).split(/[;|]/).map((x) => x.trim()).filter(Boolean))];
  const porChave = new Map(ALLOWED_VERTICALS.map((v) => [semAcentoV(v), v]));
  const invalidas = itens.filter((x) => !porChave.has(semAcentoV(x)));
  if (invalidas.length) return { invalidas };
  return { lista: itens.map((x) => porChave.get(semAcentoV(x))).join('; ') };
}

// GET /api/pessoas
router.get('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.is_active, u.first_access,
              u.last_login, u.created_at, u.vertical, r.name AS role,
              u.google_picture_url AS google_picture
       FROM users u
       JOIN roles r ON u.role_id = r.id
       ORDER BY u.is_active DESC, u.name ASC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /pessoas error:', err.message);
    return res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// GET /api/pessoas/roles
router.get('/roles', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query('SELECT id, name FROM roles ORDER BY id');
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao listar perfis' });
  }
});

// POST /api/pessoas
router.post('/', authMiddleware, requireRole('admin'), async (req, res) => {
  const { email, name, role, vertical } = req.body;

  // vertical é opcional: sem nenhuma, o perfil vê todas as verticais em todos os painéis (regra única, verticalScope.js)
  if (!email || !name || !role)
    return res.status(400).json({ error: 'Email, nome e perfil são obrigatórios' });
  if (!validateEmail(email))
    return res.status(400).json({ error: 'Email inválido' });
  const vert = normalizarVerticais(vertical);
  if (vert.invalidas)
    return res.status(400).json({ error: `Vertical inválida${vert.invalidas ? ': ' + vert.invalidas.join(', ') : ''}` });

  try {
    const roleResult = await db.query('SELECT id FROM roles WHERE name = $1', [role]);
    const roleRow = roleResult.rows[0];
    if (!roleRow) return res.status(400).json({ error: 'Perfil inválido' });

    // Sem senha: o acesso é liberado só cadastrando o e-mail aqui — o login em
    // si é feito com a conta Google corporativa (SSO), conferida em /auth/google.
    const insertResult = await db.query(
      `INSERT INTO users (email, name, vertical, role_id, is_active, first_access)
       VALUES ($1, $2, $3, $4, TRUE, FALSE) RETURNING id`,
      [email.toLowerCase().trim(), name.trim(), vert.lista || null, roleRow.id]
    );

    // E-mail de boas-vindas com o link e o passo a passo. Falha no envio não desfaz o cadastro: só é informada.
    const env = await enviarBoasVindas({ nome: name.trim(), email: email.toLowerCase().trim(), perfil: role, verticais: vert.lista });

    return res.status(201).json({
      id: insertResult.rows[0]?.id,
      email: email.toLowerCase().trim(),
      name: name.trim(),
      role,
      vertical: vert.lista,
      emailBoasVindas: env.ok ? 'enviado' : env.motivo
    });
  } catch (err) {
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    }
    console.error('POST /pessoas error:', err.message);
    return res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// POST /api/pessoas/:id/reenviar-boas-vindas — reenvia o e-mail de boas-vindas (admin)
const reenvioLimiter = rateLimit({ name: 'pessoas/boas-vindas', windowMs: 10 * 60 * 1000, max: 20, keyFn: (req) => `u:${req.user && req.user.id}` });
router.post('/:id/reenviar-boas-vindas', authMiddleware, requireRole('admin'), reenvioLimiter, async (req, res) => {
  try {
    const r = await db.query(`SELECT u.email, u.name, u.vertical, u.is_active, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.params.id]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (!u.is_active) return res.status(400).json({ error: 'Usuário desativado: ative antes de reenviar.' });
    const env = await enviarBoasVindas({ nome: u.name, email: u.email, perfil: u.role, verticais: u.vertical });
    if (!env.ok) return res.status(env.motivo === 'nao_configurado' ? 503 : 502).json({ error: env.motivo === 'nao_configurado' ? 'Envio de e-mail não configurado no servidor (SMTP_USER/SMTP_PASS).' : 'Não foi possível enviar o e-mail agora.' });
    return res.json({ ok: true, para: u.email });
  } catch (err) {
    console.error('POST /pessoas/:id/reenviar-boas-vindas error:', err.message);
    return res.status(500).json({ error: 'Erro ao reenviar o e-mail' });
  }
});

// PUT /api/pessoas/:id
router.put('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { email, name, role, is_active, vertical } = req.body;

  if (email === undefined && name === undefined && role === undefined &&
      is_active === undefined && vertical === undefined)
    return res.status(400).json({ error: 'Nenhum campo fornecido' });

  if (email !== undefined && !validateEmail(email))
    return res.status(400).json({ error: 'Email inválido' });
  // vazio é permitido (admin não precisa de vertical); a tela já exige uma para os demais perfis
  const vert = vertical !== undefined ? normalizarVerticais(vertical) : null;
  if (vert && vert.invalidas)
    return res.status(400).json({ error: `Vertical inválida: ${vert.invalidas.join(', ')}` });

  try {
    let roleId = null;
    if (role) {
      const roleResult = await db.query('SELECT id FROM roles WHERE name = $1', [role]);
      const roleRow = roleResult.rows[0];
      if (!roleRow) return res.status(400).json({ error: 'Perfil inválido' });
      roleId = roleRow.id;
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (email !== undefined)    { fields.push(`email = $${idx++}`);     values.push(email.toLowerCase().trim()); }
    if (name !== undefined)     { fields.push(`name = $${idx++}`);      values.push(name.trim()); }
    if (roleId !== null)        { fields.push(`role_id = $${idx++}`);   values.push(roleId); }
    if (is_active !== undefined){ fields.push(`is_active = $${idx++}`); values.push(Boolean(is_active)); }
    if (vertical !== undefined) { fields.push(`vertical = $${idx++}`);  values.push(vert.lista || ''); }
    fields.push('updated_at = NOW()');
    values.push(id);

    const result = await db.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Usuário não encontrado' });

    return res.json({ message: 'Atualizado com sucesso' });
  } catch (err) {
    console.error('PUT /pessoas/:id error:', err.message);
    return res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

// DELETE /api/pessoas/:id
router.delete('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (String(id) === String(req.user.id))
    return res.status(400).json({ error: 'Não é possível excluir seu próprio usuário' });

  try {
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await db.query('DELETE FROM mfa_settings WHERE user_id = $1', [id]);
    const result = await db.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Usuário não encontrado' });
    return res.json({ message: 'Usuário excluído com sucesso' });
  } catch (err) {
    console.error('DELETE /pessoas/:id error:', err.message);
    return res.status(500).json({ error: 'Erro ao excluir usuário' });
  }
});

// POST /api/pessoas/:id/revoke-sessions — encerra todas as sessões ativas do
// usuário (ex: computador perdido, saída da empresa). Da próxima vez ele
// precisa logar de novo com a conta Google.
router.post('/:id/revoke-sessions', authMiddleware, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const userResult = await db.query('SELECT id FROM users WHERE id = $1', [id]);
    if (!userResult.rows[0])
      return res.status(404).json({ error: 'Usuário não encontrado' });

    await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return res.json({ message: 'Sessões encerradas com sucesso' });
  } catch (err) {
    console.error('POST /pessoas/:id/revoke-sessions error:', err.message);
    return res.status(500).json({ error: 'Erro ao encerrar sessões' });
  }
});

// ── Fotos da pasta de TI ────────────────────────────────────────────────
// Exigem sessão (antes eram públicas). As pastas vêm de PHOTOS_DIRS no .env
// (separadas por ";"), em vez do compartilhamento de rede fixo no código.
const fs = require('fs');
const path = require('path');
const PHOTO_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const PHOTO_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
function photoDirs() {
  return String(process.env.PHOTOS_DIRS || '').split(';').map(d => d.trim()).filter(Boolean);
}
function sendPhoto(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', PHOTO_MIME[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Erro ao ler arquivo' }); else res.end(); });
  stream.pipe(res);
}

// GET /api/pessoas/foto/:email
router.get('/foto/:email', authMiddleware, (req, res) => {
  const email = String(req.params.email || '');
  // Só e-mail simples — bloqueia "../" e separadores de caminho.
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(email) || email.includes('..')) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  const base = email.replace('@', '_');
  for (const dir of photoDirs()) {
    for (const ext of PHOTO_EXTS) {
      const filePath = path.join(dir, `${base}${ext}`);
      if (fs.existsSync(filePath)) return sendPhoto(res, filePath);
    }
  }
  return res.status(404).json({ error: 'Foto não encontrada' });
});

// GET /api/pessoas/foto-por-nome/:name
router.get('/foto-por-nome/:name', authMiddleware, (req, res) => {
  const name = String(req.params.name || '');
  if (name.length < 2) return res.status(400).json({ error: 'Nome muito curto' });

  const nameParts = name.toLowerCase().split(' ').filter(Boolean);
  let best = null, bestScore = 0;
  for (const dir of photoDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir) || []; } catch { continue; }
    for (const filename of files) {
      if (!PHOTO_EXTS.includes(path.extname(filename).toLowerCase())) continue;
      const lower = filename.toLowerCase();
      const score = nameParts.reduce((acc, p) => acc + (lower.includes(p) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = path.join(dir, filename); }
    }
    if (best) break;
  }
  if (!best) return res.status(404).json({ error: 'Nenhuma foto encontrada' });
  return sendPhoto(res, best);
});

module.exports = router;
