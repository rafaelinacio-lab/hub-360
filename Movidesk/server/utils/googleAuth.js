const { OAuth2Client } = require('google-auth-library');

// ── SSO Google (Workspace) ─────────────────────────────────────────────────
// Login unificado do painel (Movidesk + aba Jira): o usuário entra com a
// conta Google corporativa, o front-end (login.html) manda o `credential`
// (ID token) do Google Identity Services para o backend, e aqui a gente
// valida a assinatura e confere se o token realmente foi emitido para o
// nosso GOOGLE_CLIENT_ID antes de confiar no e-mail/domínio.

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'viasoft.com.br').trim().toLowerCase();

const client = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function isGoogleSsoConfigured() {
  return Boolean(GOOGLE_CLIENT_ID);
}

/**
 * Valida o ID token do Google e devolve os dados do usuário.
 * Lança erro (com .publicMessage amigável) se o token for inválido, o
 * e-mail não estiver verificado ou o domínio não for o permitido.
 */
async function verifyGoogleIdToken(credential) {
  if (!client) {
    const err = new Error('GOOGLE_CLIENT_ID não configurado no servidor (.env)');
    err.publicMessage = 'Login com Google não está configurado no servidor.';
    err.status = 500;
    throw err;
  }
  if (!credential) {
    const err = new Error('credential ausente');
    err.publicMessage = 'Token de login do Google não informado.';
    err.status = 400;
    throw err;
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    const wrapped = new Error('Falha ao verificar o token do Google: ' + err.message);
    wrapped.publicMessage = 'Token de login inválido ou expirado.';
    wrapped.status = 401;
    throw wrapped;
  }

  const email = (payload.email || '').trim().toLowerCase();
  const emailDomain = email.split('@')[1] || '';
  const hd = (payload.hd || '').trim().toLowerCase();

  if (!payload.email_verified || hd !== ALLOWED_DOMAIN || emailDomain !== ALLOWED_DOMAIN) {
    const err = new Error(`domínio não permitido (${hd || 'desconhecido'})`);
    err.publicMessage = `Acesso restrito a contas @${ALLOWED_DOMAIN}.`;
    err.status = 403;
    throw err;
  }

  return {
    email,
    name: payload.name || email,
    picture: payload.picture || null,
  };
}

module.exports = {
  isGoogleSsoConfigured,
  verifyGoogleIdToken,
  GOOGLE_CLIENT_ID,
  ALLOWED_DOMAIN,
};
