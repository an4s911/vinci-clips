# Backend Dockerfile for Vinci Clips
FROM node:22-alpine AS base

RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    python3 \
    py3-pip \
    ttf-dejavu \
    make \
    g++ \
    curl && \
    pip3 install --break-system-packages yt-dlp bgutil-ytdlp-pot-provider

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

# ─── whisper.cpp: compile binary (used by dev + prod) ────────────────────────
FROM base AS whisper-compile

RUN apk add --no-cache cmake git

RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp /whisper.cpp

RUN cmake -S /whisper.cpp -B /whisper.cpp/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF && \
    cmake --build /whisper.cpp/build -j$(nproc) --config Release

# ─── whisper.cpp: download model (prod only — dev mounts it as a volume) ─────
FROM whisper-compile AS whisper-model

RUN mkdir -p /whisper-models && \
    curl -fL --retry 3 \
        -o /whisper-models/ggml-large-v3-turbo.bin \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" && \
    curl -fL --retry 3 \
        -o /whisper-models/ggml-base.en.bin \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
# ─────────────────────────────────────────────────────────────────────────────

FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
RUN npx prisma generate

FROM deps AS dev
ENV NODE_ENV development
COPY --from=whisper-compile /whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN chmod 755 /usr/local/bin/whisper-cli && mkdir -p temp cache logs uploads storage models
EXPOSE 8080
CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && node prisma/seed.js && npm run dev"]

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY . .
COPY --from=whisper-compile /whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN mkdir -p /app/models
COPY --from=whisper-model /whisper-models/ggml-large-v3-turbo.bin /app/models/ggml-large-v3-turbo.bin
COPY --from=whisper-model /whisper-models/ggml-base.en.bin /app/models/ggml-base.en.bin
RUN mkdir -p temp cache logs && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app && \
    chmod 755 /usr/local/bin/whisper-cli

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed.js && node src/index.js"]
