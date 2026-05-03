# Vinci Clips

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.3.5-black)](https://nextjs.org/)

AI-powered video clipping platform for turning long-form videos into short clips with transcription, AI clip analysis, reframing, captions, and downloadable generated videos.

## What It Does

- Upload local videos or import supported URLs.
- Process media with FFmpeg and local filesystem storage.
- Transcribe audio with Google Gemini.
- Analyze transcripts and suggest high-signal clips.
- Generate single-segment or multi-segment clips in background jobs.
- Track durable processing progress across page reloads.
- Reframe generated clips for social platforms and add captions.

## Tech Stack

- **Frontend:** Next.js 15, React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Node.js, Express
- **Persistence:** Local JSON database at `backend/storage/db.json`
- **Media:** Local files under `backend/uploads`
- **AI:** Google Gemini API
- **Video processing:** FFmpeg, yt-dlp
- **Docker:** Development and production Compose stacks with nginx, Redis, and Certbot support

## Documentation

- [docker-setup.md](./docker-setup.md): Docker development, local production build testing, VPS deployment, nginx, environment files, and Certbot.
- [CONTRIBUTING.md](./CONTRIBUTING.md): Contribution workflow, coding standards, PR guidance, and issue reporting.
- [PRD.md](./PRD.md): Product requirements and feature direction.
- [CLAUDE.md](./CLAUDE.md): Agent-oriented architecture notes for Claude/Codex-style coding assistants.
- [LICENSE](./LICENSE): AGPL-3.0 license.

## Quick Start With Docker

Use Docker for the most reliable setup because it includes FFmpeg, yt-dlp, Redis, frontend, and backend services.

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
GEMINI_API_KEY=your_gemini_key_here
REDIS_PASSWORD=devredispassword
NEXT_PUBLIC_API_URL=/api
CORS_ORIGIN=http://localhost
NGINX_CONF=./nginx/nginx.conf
APP_DOMAIN=localhost
```

Start the development stack:

```bash
docker compose up --build
```

Open:

```text
http://localhost:3000/upload
```

For production-style local Docker testing and VPS deployment, use [docker-setup.md](./docker-setup.md).

## Manual Local Development

Manual setup is useful when you do not want Docker. You must install Node.js 18+, FFmpeg, and yt-dlp yourself.

```bash
npm run install:all
```

Backend env:

```bash
cp backend/.env.example backend/.env
```

Frontend env:

```bash
printf 'NEXT_PUBLIC_API_URL=http://localhost:8080\n' > frontend/.env.local
```

Start both services:

```bash
npm run dev
```

Open:

```text
http://localhost:3000/upload
```

## Common Commands

```bash
npm run install:all        # Install backend and frontend dependencies
npm run dev                # Run backend and frontend locally
npm run start:backend      # Run backend only
npm run start:frontend     # Run frontend only
npm run build              # Build frontend
```

Docker:

```bash
docker compose up --build
docker compose logs -f backend frontend
docker compose down
```

Local production-style Docker:

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml up -d --build nginx frontend backend redis
```

## Production Deployment

Production deployment is Docker-based and uses nginx as the public reverse proxy. For a fresh VPS with no existing TLS certificate, use the first-time certificate bootstrap flow in [docker-setup.md](./docker-setup.md#vps-production-setup).

High-level flow:

```bash
cp .env.example .env.prod
```

Edit `.env.prod` with your real domain, email, Gemini key, Redis password, and HTTPS CORS origin:

```env
APP_DOMAIN=yourdomain.com
LETSENCRYPT_EMAIL=you@example.com
GEMINI_API_KEY=your_key
REDIS_PASSWORD=strong_random_password
NEXT_PUBLIC_API_URL=/api
CORS_ORIGIN=https://yourdomain.com
```

Then follow [VPS Production Setup](./docker-setup.md#vps-production-setup), which covers:

- Starting nginx with the HTTP config for the initial Let's Encrypt challenge.
- Issuing the first certificate with Certbot.
- Switching nginx to HTTPS.
- Testing automatic certificate renewal.
- Verifying production health checks.

Production commands must be run with `--env-file .env.prod`; Docker Compose only auto-loads `.env`, not `.env.prod`.

## Environment Files

- `.env`: Default Docker Compose environment file.
- `.env.example`: Template for Docker Compose environments.
- `.env.prod.local`: Local production-style Docker test values.
- `.env.prod`: Recommended VPS production env file created from `.env.example`.
- `backend/.env`: Used only when running the backend directly outside Docker.
- `frontend/.env.local`: Used only when running/building the frontend directly outside Docker.

Important: `NEXT_PUBLIC_API_URL` is baked into Next.js production builds. Rebuild the frontend Docker image after changing it.

## Project Layout

```text
backend/              Express API, localdb, processing routes, uploads
frontend/             Next.js app and UI components
nginx/                Local HTTP and production HTTPS nginx configs
docker-compose.yml    Docker development stack
docker-compose.prod.yml
docker-setup.md       Docker, env, VPS, and Certbot guide
CONTRIBUTING.md       Contribution workflow
PRD.md                Product requirements
CLAUDE.md             Agent notes
```

## Runtime URLs

Docker development:

```text
Frontend: http://localhost:3000
Backend:  http://localhost:8080
```

Local production-style Docker through nginx:

```text
App: http://localhost/upload
API: http://localhost/api
```

## License

Vinci Clips is licensed under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).
