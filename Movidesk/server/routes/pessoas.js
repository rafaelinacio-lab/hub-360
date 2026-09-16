const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { validateEmail } = require('../utils/auth');
const { authMiddleware, requireRole } = require('./auth');

const ALLOWED_VERTICALS = [
  'Agronegócio','Agrotitan Fazendas','Analytics - B.I','Automação Comercial',
  'Combustíveis','Comitê de IA','Construshow','CRM','Filt','Fisco Contábil',
  'GCC','Oracle Cloud','Ouvidoria','Serviços','Sistema para RH','Sistemas Internos',
  'Supermercados','Tecnologia','Viabot','Voors'
];

// GET /api/pessoas
router.get('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.is_active, u.first_access,
              u.last_login, u.created_at, u.vertical, r.name AS role
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

  if (!email || !name || !role || !vertical)
    return res.status(400).json({ error: 'Email, nome, perfil e vertical são obrigatórios' });
  if (!validateEmail(email))
    return res.status(400).json({ error: 'Email inválido' });
  if (!ALLOWED_VERTICALS.includes(vertical))
    return res.status(400).json({ error: 'Vertical inválida' });

  try {
    const roleResult = await db.query('SELECT id FROM roles WHERE name = $1', [role]);
    const roleRow = roleResult.rows[0];
    if (!roleRow) return res.status(400).json({ error: 'Perfil inválido' });

    // Sem senha: o acesso é liberado só cadastrando o e-mail aqui — o login em
    // si é feito com a conta Google corporativa (SSO), conferida em /auth/google.
    const insertResult = await db.query(
      `INSERT INTO users (email, name, vertical, role_id, is_active, first_access)
       VALUES ($1, $2, $3, $4, TRUE, FALSE) RETURNING id`,
      [email.toLowerCase().trim(), name.trim(), vertical.trim(), roleRow.id]
    );

    return res.status(201).json({
      id: insertResult.rows[0]?.id,
      email: email.toLowerCase().trim(),
      name: name.trim(),
      role,
      vertical: vertical.trim()
    });
  } catch (err) {
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    }
    console.error('POST /pessoas error:', err.message);
    return res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// PUT /api/pessoas/:id
router.put('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (req.body.is_active !== undefined && typeof req.body.is_active !== 'boolean') return res.status(400).json({ error: 'is_active deve ser booleano' });
  if (String(id) === String(req.user.id) && (req.body.is_active === false || (req.body.role && req.body.role !== 'admin'))) return res.status(400).json({ error: 'Não é possível remover seu próprio acesso administrativo' });
  const { email, name, role, is_active, vertical } = req.body;

  if (email === undefined && name === undefined && role === undefined &&
      is_active === undefined && vertical === undefined)
    return res.status(400).json({ error: 'Nenhum campo fornecido' });

  if (email !== undefined && !validateEmail(email))
    return res.status(400).json({ error: 'Email inválido' });
  if (vertical !== undefined && !ALLOWED_VERTICALS.includes(vertical))
    return res.status(400).json({ error: 'Vertical inválida' });

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
    if (vertical !== undefined) { fields.push(`vertical = $${idx++}`);  values.push((vertical || '').trim()); }
    fields.push('updated_at = NOW()');
    values.push(id);

    const result = await db.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Usuário não encontrado' });

    if (is_active === false) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await db.query('DELETE FROM mfa_challenges WHERE user_id = $1', [id]);
    }
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

// GET /api/pessoas/foto/:email — rota pública
router.get('/foto/:email', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const email = req.params.email;
  if (!/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });
  const emailFileName = email.replace('@', '_');
  const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const dirs = [
    '\\\\192.168.90.149\\htdocs\\painel_ti\\usuarios\\fotos',
    'Z:\\painel_ti\\usuarios\\fotos'
  ];

  let foundFile = null;
  for (const dir of dirs) {
    for (const ext of extensions) {
      const filePath = path.join(dir, `${emailFileName}${ext}`);
      if (fs.existsSync(filePath)) { foundFile = filePath; break; }
    }
    if (foundFile) break;
  }

  if (!foundFile) return res.status(404).json({ error: 'Foto não encontrada' });

  const ext = path.extname(foundFile).toLowerCase();
  const mimeMap = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp' };
  res.setHeader('Content-Type', mimeMap[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const stream = fs.createReadStream(foundFile);
  stream.on('error', () => res.status(500).json({ error: 'Erro ao ler arquivo' }));
  stream.pipe(res);
});

// GET /api/pessoas/foto-por-nome/:name — rota pública
router.get('/foto-por-nome/:name', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const name = req.params.name;
  if (!name || name.length < 2) return res.status(400).json({ error: 'Nome muito curto' });

  const dirs = [
    '\\\\192.168.90.149\\htdocs\\painel_ti\\usuarios\\fotos',
    'Z:\\painel_ti\\usuarios\\fotos'
  ];

  let files = [];
  for (const dir of dirs) {
    try { files = fs.readdirSync(dir) || []; break; } catch {}
  }
  if (!files.length) return res.status(500).json({ error: 'Pasta de fotos inacessível' });

  const nameParts = name.toLowerCase().split(' ').filter(p => p.length > 0);
  let bestMatch = null, bestScore = 0;

  files.forEach(filename => {
    const lower = filename.toLowerCase();
    let score = nameParts.reduce((s, p) => s + (lower.includes(p) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestMatch = filename; }
  });

  if (!bestMatch || bestScore === 0) return res.status(404).json({ error: 'Nenhuma foto encontrada' });

  let fullPath = null;
  for (const dir of dirs) {
    const p = path.join(dir, bestMatch);
    if (fs.existsSync(p)) { fullPath = p; break; }
  }
  if (!fullPath) return res.status(404).json({ error: 'Arquivo não encontrado' });

  const ext = path.extname(fullPath).toLowerCase();
  const mimeMap = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp' };
  res.setHeader('Content-Type', mimeMap[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const stream = fs.createReadStream(fullPath);
  stream.on('error', () => res.status(500).json({ error: 'Erro ao ler arquivo' }));
  stream.pipe(res);
});

module.exports = router;
