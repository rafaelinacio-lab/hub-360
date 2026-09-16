// Per-process bounds. Multi-replica deployments should enforce a shared limit at the gateway.
function rateLimit({ limit = 20, windowMs = 60000 } = {}) {
  const entries = new Map();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, entry] of entries) if (entry.until <= now) entries.delete(key);
    const key = String(req.user?.id || req.ip);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= 10000) return res.status(429).json({ error: 'Tente novamente mais tarde' });
      entries.set(key, entry = { count: 0, until: now + windowMs });
    }
    if (++entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.until - now) / 1000)));
      return res.status(429).json({ error: 'Limite de requisições atingido' });
    }
    next();
  };
}
module.exports = { rateLimit };
