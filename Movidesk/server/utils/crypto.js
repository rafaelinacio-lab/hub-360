const crypto = require('crypto');

// Criptografia dos segredos salvos na tabela config (token do Movidesk, chave
// da OpenAI, senha do banco).
//
// ENCRYPTION_KEY é obrigatória — sem ela o servidor não sobe. Antes havia um
// valor padrão fixo aqui no código, o que na prática deixava os segredos
// "criptografados" com uma chave pública (qualquer um com o repositório
// decifrava o banco).
//
// Formato atual (v2): "v2:<iv>:<tag>:<cifra>" — AES-256-GCM (autenticado) com
// a chave derivada da ENCRYPTION_KEY por scrypt.
// Formato antigo (legado): "<iv>:<cifra>" — AES-256-CBC com a ENCRYPTION_KEY
// cortada/completada para 32 caracteres. Continua sendo LIDO (com
// LEGACY_ENCRYPTION_KEY, se definida, senão com a própria ENCRYPTION_KEY)
// para não perder o que já está salvo; reencryptLegacyValues() em config.js
// regrava esses valores no formato v2 no boot.

const MIN_KEY_LENGTH = 32;
const RAW_KEY = process.env.ENCRYPTION_KEY || '';
if (RAW_KEY.length < MIN_KEY_LENGTH) {
  throw new Error(
    `ENCRYPTION_KEY ausente ou curta demais (mínimo ${MIN_KEY_LENGTH} caracteres). ` +
    'Defina no .env — gere uma com: openssl rand -hex 32'
  );
}

const KDF_SALT = 'hub360:config-secrets:v2';
const KEY_V2 = crypto.scryptSync(RAW_KEY, KDF_SALT, 32);
const PREFIX_V2 = 'v2:';

function legacyKey() {
  const raw = process.env.LEGACY_ENCRYPTION_KEY || RAW_KEY;
  return Buffer.from(raw.padEnd(32, '0').substring(0, 32));
}

function isLegacyEncrypted(value) {
  return typeof value === 'string' && !value.startsWith(PREFIX_V2) && value.split(':').length === 2;
}

function encryptToken(token) {
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY_V2, iv);
    const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX_V2}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    console.error('Erro ao criptografar token:', error.message);
    throw new Error('Erro ao criptografar token');
  }
}

function decryptToken(encryptedData) {
  try {
    const value = String(encryptedData || '');
    if (value.startsWith(PREFIX_V2)) {
      const [ivHex, tagHex, dataHex] = value.slice(PREFIX_V2.length).split(':');
      if (!ivHex || !tagHex || dataHex === undefined) throw new Error('Formato v2 inválido');
      const decipher = crypto.createDecipheriv('aes-256-gcm', KEY_V2, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    }

    const parts = value.split(':');
    if (parts.length !== 2) throw new Error('Formato de token criptografado inválido');
    const decipher = crypto.createDecipheriv('aes-256-cbc', legacyKey(), Buffer.from(parts[0], 'hex'));
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Erro ao descriptografar token:', error.message);
    throw new Error('Erro ao descriptografar token');
  }
}

module.exports = {
  encryptToken,
  decryptToken,
  isLegacyEncrypted
};
