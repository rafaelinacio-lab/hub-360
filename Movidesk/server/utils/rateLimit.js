'use strict';
// Limite de requisições em memória (janela fixa), sem dependência externa.
// Serve para um único processo — é o caso do painel (1 container). A chave
// padrão é o usuário logado (req.user.id) ou, antes do login, o IP.

function rateLimit({ windowMs, max, name, keyFn }) {
  const hits = new Map(); // chave -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.min(windowMs, 60 * 1000)).unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    const restante = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(restante));
    if (entry.count > max) {
      const retrySec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retrySec));
      console.warn(`[rate-limit] ${name}: ${key} bloqueado por ${retrySec}s`);
      return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${Math.ceil(retrySec / 60)} min.` });
    }
    next();
  };
}

module.exports = { rateLimit };
