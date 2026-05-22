# Backend Dockerfile for Vinci Clips
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fontconfig \
    fonts-dejavu \
    python3 \
    python3-pip \
    make \
    g++ \
    curl && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages faster-whisper yt-dlp bgutil-ytdlp-pot-provider

RUN mkdir -p /usr/share/fonts/truetype/google && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/Montserrat.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/Poppins-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Regular.ttf" && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/Poppins-Bold.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Bold.ttf" && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/Poppins-Black.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Black.ttf" && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/BebasNeue-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf" && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/Oswald.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf" && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/Anton-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf" && \
    curl -fL --retry 3 -o /usr/share/fonts/truetype/google/Inter.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" && \
    fc-cache -f

WORKDIR /app

# ─── faster-whisper: download CT2 model ──────────────────────────────────────
FROM base AS faster-whisper-model

RUN python3 -c "from faster_whisper import download_model; download_model('large-v3-turbo', output_dir='/whisper-models/faster-whisper-large-v3-turbo')"
# ─────────────────────────────────────────────────────────────────────────────

FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
RUN npx prisma generate

FROM deps AS dev
ENV NODE_ENV development
RUN mkdir -p temp cache logs uploads storage models
EXPOSE 8080
CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && node prisma/seed.js && npm run dev"]

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/models
COPY --from=faster-whisper-model /whisper-models/large-v3-turbo /app/models/faster-whisper-large-v3-turbo
RUN mkdir -p temp cache logs && \
    addgroup --gid 1001 nodejs && \
    adduser --disabled-password --gecos '' --uid 1001 --gid 1001 nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed.js && node src/index.js"]
