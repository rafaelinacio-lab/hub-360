const express = require('express');
const router = express.Router();
const db = require('../db/remote');
const {
  generateInitialPassword,
  generateToken,
  hashPassword,
  verifyPassword,
  generateTOTPSecret,
  verifyTOTP,
  generateBackupCodes,
  verifyBackupCode,
  createSessionPayload,
  validatePasswordStrength,
  validateEmail
} = require('../utils/auth');
const { isGoogleSsoConfigured, verifyGoogleIdToken, GOOGLE_CLIENT_ID, ALLOWED_DOMAIN } = require('../utils/googleAuth');

// ===== Middleware de Autenticação =====

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const result = await db.query(
      `SELECT s.*, u.id as uid, u.email, u.role_id
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    const session = result.rows[0];
    if (!session) return res.status(401).json({ error: 'Sessão inválida ou expirada' });

    req.user = { id: session.uid, email: session.email, roleId: session.role_id };
    req.sessionToken = token;
    next();
  } catch (err) {
    console.error('authMiddleware error:', err.message);
    return res.status(500).json({ error: 'Erro ao verificar sessão' });
  }
}

function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT r.name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`,
        [req.user.id]
      );
      const row = result.rows[0];
      if (!row || !allowedRoles.includes(row.name)) {
        return res.status(403).json({ error: 'Acesso negado. Permissão insuficiente.' });
      }
      next();
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao verificar permissão' });
    }
  };
}

// ===== SSO Google (login único do painel — Movidesk + aba Jira) =====

// GET /auth/google-config — rota pública: o front-end precisa do Client ID
// para inicializar o botão do Google Identity Services antes de logar.
router.get('/google-config', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID, allowedDomain: ALLOWED_DOMAIN, configured: isGoogleSsoConfigured() });
});

// POST /auth/google — troca o ID token do Google por uma sessão do painel.
// Qualquer conta @ALLOWED_DOMAIN (já validada pelo Google) consegue entrar:
// - Se já está cadastrada em Pessoas, usa o perfil (role) e a vertical de lá.
// - Se não está cadastrada, ganha automaticamente o perfil "guest" (só vê a
//   Dashboard) — um admin pode promover essa pessoa depois, em Pessoas.
// A única forma de bloquear alguém é desativar o cadastro dela em Pessoas.
router.post('/google', async (req, res) => {
  const { credential } = req.body || {};

  let googleUser;
  try {
    googleUser = await verifyGoogleIdToken(credential);
  } catch (err) {
    console.warn('POST /auth/google verify falhou:', err.message);
    return res.status(err.status || 401).json({ error: err.publicMessage || 'Falha no login com Google.' });
  }

  try {
    const userResult = await db.query(
      `SELECT u.*, r.name as role FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.email = $1`,
      [googleUser.email]
    );
    let user = userResult.rows[0];

    if (user && !user.is_active) {
      await db.query(
        `INSERT INTO access_logs (user_id, action, resource, success) VALUES ($1, 'login_google', $2, FALSE)`,
        [user.id, 'conta desativada']
      ).catch(() => {});
      return res.status(403).json({
        error: 'Sua conta foi desativada neste painel. Peça a um admin para reativar em Pessoas.'
      });
    }

    if (!user) {
      const guestRoleResult = await db.query(`SELECT id FROM roles WHERE name = 'guest'`);
      const guestRoleId = guestRoleResult.rows[0]?.id;
      if (!guestRoleId) {
        return res.status(500).json({ error: 'Perfil "guest" não configurado no servidor (roles).' });
      }
      const insertResult = await db.query(
        `INSERT INTO users (email, name, role_id, is_active, first_access)
         VALUES ($1, $2, $3, TRUE, FALSE) RETURNING *`,
        [googleUser.email, googleUser.name || googleUser.email, guestRoleId]
      );
      user = { ...insertResult.rows[0], role: 'guest' };
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO sessions (user_id, token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, token, req.ip, req.get('user-agent'), expiresAt]
    );
    await db.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);
    // Atualiza a foto da conta Google a cada login — acompanha trocas de foto
    // sem precisar de nenhuma ação manual.
    if (googleUser.picture) {
      await db.query(`UPDATE users SET google_picture_url = $1 WHERE id = $2`, [googleUser.picture, user.id]).catch(() => {});
    }
    await db.query(
      `INSERT INTO access_logs (user_id, action, ip_address, success) VALUES ($1, 'login_google', $2, TRUE)`,
      [user.id, req.ip]
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        vertical: user.vertical || null,
        firstAccess: false,
        picture: googleUser.picture
      }
    });
  } catch (err) {
    console.error('POST /auth/google error:', err.message);
    return res.status(500).json({ error: 'Erro na autenticação com Google' });
  }
});

// ===== POST /auth/login (legado — mantido no backend, não é mais usado pelo front-end) =====

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });

  try {
    const userResult = await db.query(
      `SELECT u.*, r.name as role FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );
    const user = userResult.rows[0];

    if (!user || !user.is_active)
      return res.status(401).json({ error: 'Usuário não encontrado ou inativo' });

    if (user.locked_until && new Date(user.locked_until) > new Date())
      return res.status(429).json({ error: 'Conta temporariamente bloqueada. Tente novamente mais tarde.' });

    const valid = await verifyPassword(password, user.password_hash || '');
    if (!valid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const lockUntil = newAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await db.query(
        `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
        [newAttempts, lockUntil, user.id]
      );
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }

    // Reset tentativas falhas
    await db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [user.id]
    );

    // Verificar MFA
    const mfaResult = await db.query(
      `SELECT is_enabled FROM mfa_settings WHERE user_id = $1 AND is_enabled = TRUE`,
      [user.id]
    );
    const mfa = mfaResult.rows[0];

    if (mfa) {
      const tempToken = generateToken();
      await db.query(
        `INSERT INTO sessions (user_id, token, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')`,
        [user.id, tempToken, req.ip, req.get('user-agent')]
      );
      return res.json({
        requiresMFA: true,
        tempToken,
        message: 'Forneça o código MFA para completar o login'
      });
    }

    // Sessão completa
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO sessions (user_id, token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, token, req.ip, req.get('user-agent'), expiresAt]
    );
    await db.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);
    await db.query(
      `INSERT INTO access_logs (user_id, action, ip_address, success) VALUES ($1, 'login', $2, TRUE)`,
      [user.id, req.ip]
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        vertical: user.vertical || null,
        firstAccess: user.first_access
      }
    });
  } catch (err) {
    console.error('POST /login error:', err.message);
    return res.status(500).json({ error: 'Erro na autenticação' });
  }
});

// ===== POST /auth/verify-mfa =====

router.post('/verify-mfa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code)
    return res.status(400).json({ error: 'Token temporário e código MFA são obrigatórios' });

  try {
    const sessionResult = await db.query(
      `SELECT s.*, u.email, u.name, u.role_id, u.vertical, r.name as role
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       JOIN roles r ON u.role_id = r.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [tempToken]
    );
    const session = sessionResult.rows[0];
    if (!session) return res.status(401).json({ error: 'Sessão inválida ou expirada' });

    const mfaResult = await db.query(
      `SELECT * FROM mfa_settings WHERE user_id = $1`,
      [session.user_id]
    );
    const mfa = mfaResult.rows[0];
    if (!mfa) return res.status(500).json({ error: 'Erro ao verificar MFA' });

    let verified = verifyTOTP(mfa.totp_secret, code);
    let usedBackup = false;

    if (!verified) {
      const backupResult = verifyBackupCode(code, mfa.backup_codes);
      if (backupResult.valid) {
        await db.query(
          `UPDATE mfa_settings SET backup_codes = $1 WHERE user_id = $2`,
          [backupResult.remaining, session.user_id]
        );
        verified = true;
        usedBackup = true;
      }
    }

    if (!verified) return res.status(401).json({ error: 'Código MFA inválido' });

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query(`DELETE FROM sessions WHERE token = $1`, [tempToken]);
    await db.query(
      `INSERT INTO sessions (user_id, token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.user_id, token, req.ip, req.get('user-agent'), expiresAt]
    );
    await db.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [session.user_id]);
    await db.query(
      `INSERT INTO access_logs (user_id, action, ip_address, success)
       VALUES ($1, $2, $3, TRUE)`,
      [session.user_id, usedBackup ? 'login_backup_code' : 'login_mfa_success', req.ip]
    );

    return res.json({
      token,
      user: {
        id: session.user_id,
        email: session.email,
        name: session.name,
        roleId: session.role_id,
        role: session.role,
        vertical: session.vertical || null
      }
    });
  } catch (err) {
    console.error('POST /verify-mfa error:', err.message);
    return res.status(500).json({ error: 'Erro ao verificar MFA' });
  }
});

// ===== POST /auth/first-access =====

router.post('/first-access', async (req, res) => {
  const { email, initialPassword, newPassword } = req.body;
  if (!email || !initialPassword || !newPassword)
    return res.status(400).json({ error: 'Email, senha inicial e nova senha são obrigatórios' });

  const validation = validatePasswordStrength(newPassword);
  if (!validation.valid)
    return res.status(400).json({ error: 'Senha fraca', details: validation.errors });

  try {
    const userResult = await db.query(
      `SELECT * FROM users WHERE email = $1 AND first_access = TRUE`,
      [email.toLowerCase()]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado ou já completou primeiro acesso' });

    const valid = await verifyPassword(initialPassword, user.password_hash || '');
    if (!valid) return res.status(401).json({ error: 'Senha inicial incorreta' });

    const newHash = await hashPassword(newPassword);
    await db.query(
      `UPDATE users SET password_hash = $1, first_access = FALSE, updated_at = NOW() WHERE id = $2`,
      [newHash, user.id]
    );
    await db.query(
      `INSERT INTO access_logs (user_id, action, success) VALUES ($1, 'first_access_completed', TRUE)`,
      [user.id]
    );

    return res.json({ message: 'Senha alterada com sucesso', nextStep: 'mfa-setup' });
  } catch (err) {
    console.error('POST /first-access error:', err.message);
    return res.status(500).json({ error: 'Erro ao atualizar senha' });
  }
});

// ===== POST /auth/setup-mfa =====

router.post('/setup-mfa', authMiddleware, async (req, res) => {
  try {
    const { secret, qrCode } = await generateTOTPSecret(req.user.email);
    await db.query(
      `INSERT INTO mfa_settings (user_id, totp_secret, is_enabled, created_at)
       VALUES ($1, $2, FALSE, NOW())
       ON CONFLICT (user_id) DO UPDATE SET totp_secret = $2, is_enabled = FALSE, updated_at = NOW()`,
      [req.user.id, secret]
    );
    return res.json({ qrCode, secret, message: 'Escaneie o código QR com seu autenticador' });
  } catch (err) {
    console.error('POST /setup-mfa error:', err.message);
    return res.status(500).json({ error: 'Erro ao configurar MFA' });
  }
});

// ===== POST /auth/verify-and-enable-mfa =====

router.post('/verify-and-enable-mfa', authMiddleware, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código MFA é obrigatório' });

  try {
    const mfaResult = await db.query(
      `SELECT * FROM mfa_settings WHERE user_id = $1 AND is_enabled = FALSE`,
      [req.user.id]
    );
    const mfa = mfaResult.rows[0];
    if (!mfa) return res.status(400).json({ error: 'MFA não foi inicializado' });

    if (!verifyTOTP(mfa.totp_secret, code))
      return res.status(401).json({ error: 'Código TOTP inválido' });

    const backupCodes = generateBackupCodes(10);
    const backupCodesJson = JSON.stringify(backupCodes.map(c => ({ code: c, used: false })));

    await db.query(
      `UPDATE mfa_settings
       SET is_enabled = TRUE, backup_codes = $1, verified_at = NOW(), updated_at = NOW()
       WHERE user_id = $2`,
      [backupCodesJson, req.user.id]
    );
    await db.query(
      `INSERT INTO access_logs (user_id, action, success) VALUES ($1, 'mfa_enabled', TRUE)`,
      [req.user.id]
    );

    return res.json({
      message: 'MFA ativado com sucesso',
      backupCodes,
      warning: 'Guarde os códigos de backup em um local seguro!'
    });
  } catch (err) {
    console.error('POST /verify-and-enable-mfa error:', err.message);
    return res.status(500).json({ error: 'Erro ao ativar MFA' });
  }
});

// ===== POST /auth/logout =====

router.post('/logout', authMiddleware, async (req, res) => {
  try {
    await db.query(`DELETE FROM sessions WHERE token = $1`, [req.sessionToken]);
    await db.query(
      `INSERT INTO access_logs (user_id, action, success) VALUES ($1, 'logout', TRUE)`,
      [req.user.id]
    );
    return res.json({ message: 'Desconectado com sucesso' });
  } catch (err) {
    console.error('POST /logout error:', err.message);
    return res.status(500).json({ error: 'Erro ao fazer logout' });
  }
});

// ===== GET /auth/me =====

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.name, r.name as role, u.first_access,
              m.is_enabled as mfa_enabled, u.vertical, u.google_picture_url AS picture
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN mfa_settings m ON u.id = m.user_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    return res.json(user);
  } catch (err) {
    console.error('GET /me error:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.requireRole = requireRole;
