const crypto = require('crypto');

function getKey() {
  const value = process.env.ENCRYPTION_KEY || '';
  if (Buffer.byteLength(value) < 32 || value.startsWith('sua-chave-secreta')) {
    throw new Error('Configure ENCRYPTION_KEY com uma chave secreta de pelo menos 32 bytes');
  }
  // Preserve the legacy key derivation to read existing encrypted configuration.
  const key = Buffer.from(value.substring(0, 32));
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY deve usar caracteres ASCII');
  return key;
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v2', iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
}

function decryptToken(value) {
  const parts = String(value).split(':');
  if (parts[0] === 'v2' && parts.length === 4) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(parts[1], 'hex'));
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]).toString('utf8');
  }
  if (parts.length !== 2) throw new Error('Formato de token criptografado inválido');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), Buffer.from(parts[0], 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(parts[1], 'hex')), decipher.final()]).toString('utf8');
}
module.exports = { encryptToken, decryptToken, validateEncryptionKey: getKey };
