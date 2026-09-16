const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const { generateInitialPassword, hashPassword, validateEmail } = require('../utils/auth');

// GET /users
router.get('/', authMiddleware, requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.vertical, u.is_active, u.first_access,
              u.last_login, r.name as role, m.is_enabled as mfa_enabled, u.created_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN mfa_settings m ON u.id = m.user_id
       ORDER BY u.created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /users error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar usuários' });
  }
});

// Perfis disponíveis para atribuição e configuração de acesso.
// Esta rota precisa ficar antes de /:id.
router.get('/roles', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(`SELECT id, name, description, permissions FROM roles ORDER BY name`);
    return res.json(result.rows);
  } catch (_) { return res.status(500).json({ error: 'Erro ao buscar perfis' }); }
});

router.post('/roles', authMiddleware, requireRole('admin'), async (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase();
  const description = String(req.body?.description || '').trim();
  if (!/^[a-z][a-z0-9_-]{2,49}$/.test(name)) {
    return res.status(400).json({ error: 'Use de 3 a 50 caracteres: letras minusculas, numeros, hifen ou sublinhado.' });
  }
  if (['admin', 'supervisor', 'atendente', 'guest'].includes(name)) return res.status(400).json({ error: 'Este nome e reservado para um perfil padrao.' });
  try {
    const result = await db.query(`INSERT INTO roles (name, description, permissions) VALUES ($1, $2, '[]') RETURNING id, name, description`, [name, description || null]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) return res.status(409).json({ error: 'Ja existe um perfil com este nome.' });
    return res.status(500).json({ error: 'Erro ao criar perfil' });
  }
});

router.put('/roles/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const description = String(req.body?.description || '').trim();
  try {
    const result = await db.query(`UPDATE roles SET description = $1 WHERE id = $2 RETURNING id, name, description`, [description || null, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Perfil nao encontrado' });
    return res.json(result.rows[0]);
  } catch (_) { return res.status(500).json({ error: 'Erro ao atualizar perfil' }); }
});

router.delete('/roles/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const role = await db.query(`SELECT name FROM roles WHERE id = $1`, [req.params.id]);
    if (!role.rows[0]) return res.status(404).json({ error: 'Perfil nao encontrado' });
    if (['admin', 'supervisor', 'atendente', 'guest'].includes(role.rows[0].name)) return res.status(400).json({ error: 'Perfis padrao nao podem ser removidos.' });
    const users = await db.query(`SELECT COUNT(*)::int AS total FROM users WHERE role_id = $1`, [req.params.id]);
    if (users.rows[0].total > 0) return res.status(409).json({ error: 'Reatribua os usuarios deste perfil antes de remove-lo.' });
    await db.query(`DELETE FROM roles WHERE id = $1`, [req.params.id]);
    return res.json({ success: true });
  } catch (_) { return res.status(500).json({ error: 'Erro ao remover perfil' }); }
});

// GET /users/roles (deve vir ANTES de /:id para não conflitar)
// GET /users/access-logs
router.get('/access-logs', authMiddleware, requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT l.*, u.email, u.name FROM access_logs l
       LEFT JOIN users u ON l.user_id = u.id
       WHERE l.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY l.created_at DESC LIMIT 1000`
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar logs' });
  }
});


// GET /users/:id
router.get('/:id', authMiddleware, requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.vertical, u.is_active, u.first_access,
              u.last_login, r.name as role, r.id as role_id,
              m.is_enabled as mfa_enabled, u.created_at, u.updated_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN mfa_settings m ON u.id = m.user_id
       WHERE u.id = $1`,
      [req.params.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    return res.json(user);
  } catch (err) {
    console.error('GET /users/:id error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

// POST /users
router.post('/', authMiddleware, requireRole('admin'), async (req, res) => {
  const { email, name, role, vertical } = req.body;

  if (!email || !name || !role)
    return res.status(400).json({ error: 'Email, nome e role são obrigatórios' });
  if (!validateEmail(email))
    return res.status(400).json({ error: 'Email inválido' });

  try {
    const roleResult = await db.query(`SELECT id FROM roles WHERE name = $1`, [role]);
    const roleRow = roleResult.rows[0];
    if (!roleRow) return res.status(400).json({ error: 'Role inválida' });

    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const insertResult = await db.query(
      `INSERT INTO users (email, name, vertical, password_hash, role_id, is_active, first_access)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE) RETURNING id`,
      [email.toLowerCase(), name, vertical || null, passwordHash, roleRow.id]
    );

    await db.query(
      `INSERT INTO access_logs (user_id, action, resource, success) VALUES ($1, 'user_created', $2, TRUE)`,
      [req.user.id, email]
    );

    return res.status(201).json({
      id: insertResult.rows[0]?.id,
      email: email.toLowerCase(),
      name,
      role,
      vertical: vertical || null,
      initialPassword,
      message: 'Usuário criado com sucesso. Compartilhe a senha inicial com segurança.'
    });
  } catch (err) {
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'Email já cadastrado' });
    }
    console.error('POST /users error:', err.message);
    return res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// PUT /users/:id
router.put('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (req.body.is_active !== undefined && typeof req.body.is_active !== 'boolean') return res.status(400).json({ error: 'is_active deve ser booleano' });
  if (String(id) === String(req.user.id) && (req.body.is_active === false || (req.body.role && req.body.role !== 'admin'))) return res.status(400).json({ error: 'Não é possível remover seu próprio acesso administrativo' });
  const { name, role, is_active, vertical } = req.body;

  if (!name && role === undefined && is_active === undefined && vertical === undefined)
    return res.status(400).json({ error: 'Forneça pelo menos um campo para atualizar' });

  try {
    let roleId = null;
    if (role) {
      const roleResult = await db.query(`SELECT id FROM roles WHERE name = $1`, [role]);
      const roleRow = roleResult.rows[0];
      if (!roleRow) return res.status(400).json({ error: 'Role inválida' });
      roleId = roleRow.id;
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (name)              { fields.push(`name = $${idx++}`);       values.push(name); }
    if (roleId)            { fields.push(`role_id = $${idx++}`);    values.push(roleId); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(Boolean(is_active)); }
    if (vertical !== undefined)  { fields.push(`vertical = $${idx++}`);  values.push(vertical); }
    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await db.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Usuário não encontrado' });

    await db.query(
      `INSERT INTO access_logs (user_id, action, resource, success) VALUES ($1, 'user_updated', $2, TRUE)`,
      [req.user.id, id]
    );

    if (is_active === false) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await db.query('DELETE FROM mfa_challenges WHERE user_id = $1', [id]);
    }
    return res.json({ message: 'Usuário atualizado com sucesso' });
  } catch (err) {
    console.error('PUT /users/:id error:', err.message);
    return res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }
});

// DELETE /users/:id (soft delete)
router.delete('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (id == req.user.id)
    return res.status(400).json({ error: 'Não é possível desativar sua própria conta' });

  try {
    const result = await db.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [id]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Usuário não encontrado' });

    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await db.query(
      `INSERT INTO access_logs (user_id, action, resource, success) VALUES ($1, 'user_deactivated', $2, TRUE)`,
      [req.user.id, id]
    );

    return res.json({ message: 'Usuário desativado com sucesso' });
  } catch (err) {
    console.error('DELETE /users/:id error:', err.message);
    return res.status(500).json({ error: 'Erro ao desativar usuário' });
  }
});

// POST /users/:id/reset-password
router.post('/:id/reset-password', authMiddleware, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  try {
    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const result = await db.query(
      `UPDATE users SET password_hash = $1, first_access = TRUE,
       failed_login_attempts = 0, locked_until = NULL WHERE id = $2`,
      [passwordHash, id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Usuário não encontrado' });

    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await db.query(
      `INSERT INTO access_logs (user_id, action, resource, success) VALUES ($1, 'password_reset', $2, TRUE)`,
      [req.user.id, id]
    );

    return res.json({
      message: 'Senha resetada com sucesso',
      initialPassword,
      warning: 'Compartilhe a senha com segurança'
    });
  } catch (err) {
    console.error('POST /users/:id/reset-password error:', err.message);
    return res.status(500).json({ error: 'Erro ao resetar senha' });
  }
});

// GET /users/access-logs/:userId
router.get('/access-logs/:userId', authMiddleware, requireRole('admin', 'supervisor'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM access_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.userId]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar logs' });
  }
});

module.exports = router;
