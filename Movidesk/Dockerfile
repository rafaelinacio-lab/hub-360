# ── Build stage ──
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Runtime stage ──
FROM node:22-alpine
WORKDIR /app

# Segurança: roda como non-root
RUN addgroup -g 1001 -S painel && \
    adduser -S painel -u 1001

COPY --from=deps --chown=painel:painel /app/node_modules ./node_modules
COPY --chown=painel:painel . .

USER painel

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server/server.js"]
