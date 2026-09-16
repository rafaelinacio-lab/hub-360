const crypto = require('crypto');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const BCRYPT_ROUNDS = 12;

// ===== Senha =====

function generateInitialPassword() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  // Suporte a hashes antigos no formato salt:hash (pbkdf2)
  if (hash.includes(':') && !hash.startsWith('$2')) {
    const [salt, storedHash] = hash.split(':');
    if (!salt || !storedHash) return false;
    const testHash = crypto
      .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
      .toString('hex');
    const actual = Buffer.from(storedHash, 'hex');
    return actual.length === 64 && crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), actual);
  }
  return bcrypt.compare(password, hash);
}

// ===== Token de sessão =====

function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// ===== MFA (TOTP) =====

async function generateTOTPSecret(email, appName = 'Dashboard Movidesk') {
  const secret = speakeasy.generateSecret({
    name: `${appName} (${email})`,
    issuer: appName,
    length: 32
  });
  const qrCode = await qrcode.toDataURL(secret.otpauth_url);
  return { secret: secret.base32, qrCode, manualEntry: secret.base32 };
}

function verifyTOTP(secret, token) {
  if (!secret || !token) return false;
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 2
  });
}

// ===== Backup codes =====

function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

function verifyBackupCode(code, codesJson) {
  if (!codesJson) return { valid: false, remaining: codesJson };
  let codes = JSON.parse(codesJson);
  const normalizedCode = code.toUpperCase().replace(/-/g, '');
  const index = codes.findIndex(c => {
    return c.code.toUpperCase().replace(/-/g, '') === normalizedCode && !c.used;
  });
  if (index > -1) {
    codes[index].used = true;
    return { valid: true, remaining: JSON.stringify(codes) };
  }
  return { valid: false, remaining: codesJson };
}

// ===== Validadores =====

function validatePasswordStrength(password) {
  const errors = [];
  if (typeof password !== 'string') return { valid: false, errors: ['Senha deve ser texto'] };
  if (password.length < 8)           errors.push('Senha deve ter no mínimo 8 caracteres');
  if (!/[A-Z]/.test(password))       errors.push('Senha deve conter ao menos uma letra maiúscula');
  if (!/[a-z]/.test(password))       errors.push('Senha deve conter ao menos uma letra minúscula');
  if (!/[0-9]/.test(password))       errors.push('Senha deve conter ao menos um número');
  if (!/[!@#$%^&*]/.test(password))  errors.push('Senha deve conter ao menos um caractere especial (!@#$%^&*)');
  return { valid: errors.length === 0, errors };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// createSessionPayload mantido por compatibilidade (não usado internamente)
function createSessionPayload(userId, email, role) {
  return {
    userId, email, role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
  };
}

module.exports = {
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
};
