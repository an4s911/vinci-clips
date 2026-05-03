# Backend Dockerfile for Vinci Clips
FROM node:22-alpine AS base

RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    python3 \
    ttf-dejavu \
    yt-dlp \
    make \
    g++

WORKDIR /app

FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
RUN npx prisma generate

FROM deps AS dev
ENV NODE_ENV development
RUN mkdir -p temp cache logs uploads storage
EXPOSE 8080
CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && npm run dev"]

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p temp cache logs && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
