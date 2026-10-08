# ── Build stage ──
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Runtime stage ──
FROM node:20-alpine
WORKDIR /app

# Segurança: roda como non-root
RUN addgroup -g 1001 -S painel && \
    adduser -S painel -u 1001

# Chromium sem janela para a automação da tela do Movidesk (Avisos automáticos → Gatilhos). A biblioteca
# playwright-core entra pelo package.json (npm install playwright-core) — ver docs/ARCHITECTURE.md.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY --from=deps --chown=painel:painel /app/node_modules ./node_modules
COPY --chown=painel:painel . .

USER painel

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server/server.js"]
