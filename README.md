# Vinci Clips

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.3.5-black)](https://nextjs.org/)

AI-powered video clipping platform for turning long-form videos into short clips with transcription, AI clip analysis, reframing, captions, and downloadable generated videos.

## What It Does

- Upload local videos or import supported URLs.
- Process media with FFmpeg and local filesystem storage.
- Import YouTube URLs with yt-dlp, with optional cookie and user-agent settings for server/VPS deployments.
- Transcribe audio with Google Gemini.
- Analyze transcripts and suggest high-signal clips.
- Generate single-segment or multi-segment clips in background jobs.
- Track durable processing progress across page reloads.
- Reframe generated clips for social platforms and add captions.
- Multi-user ready auth with Postgres-backed sessions.

## Tech Stack

- **Frontend:** Next.js 15, React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Node.js 22, Express
- **Persistence:** PostgreSQL 18 via Prisma ORM
- **Sessions:** Redis-backed express-session with HttpOnly cookies
- **Media:** Local files under `backend/uploads`
- **AI:** Google Gemini API
- **Video processing:** FFmpeg, yt-dlp
- **Docker:** Development and production Compose stacks with nginx, Redis, Postgres, and Certbot support

## Documentation

- [docker-setup.md](./docker-setup.md): Docker development, local production build testing, VPS deployment, nginx, environment files, and Certbot.
- [CONTRIBUTING.md](./CONTRIBUTING.md): Contribution workflow, coding standards, PR guidance, and issue reporting.
- [PRD.md](./PRD.md): Product requirements and feature direction.
- [CLAUDE.md](./CLAUDE.md): Agent-oriented architecture notes for Claude/Codex-style coding assistants.
- [LICENSE](./LICENSE): AGPL-3.0 license.

## Quick Start With Docker

Use Docker for the most reliable setup because it includes FFmpeg, yt-dlp, Redis, Postgres, frontend, and backend services.

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
GEMINI_API_KEY=your_gemini_key_here
REDIS_PASSWORD=devredispassword
POSTGRES_PASSWORD=devpostgrespassword
POSTGRES_PORT=5433
SESSION_SECRET=$(openssl rand -base64 48)
NEXT_PUBLIC_API_URL=/api
CORS_ORIGIN=http://localhost
APP_DOMAIN=localhost
```

`POSTGRES_PORT` only changes the host port published by Docker Compose. Omit it
to use the default `5432`.

Start the development stack:

```bash
docker compose up --build
```

Create the first admin user:

```bash
docker compose exec backend npm run auth:create-user -- --email admin@example.com --password 'yourpassword'
```

Open:

```text
http://localhost:3000/login
```

For production-style local Docker testing and VPS deployment, use [docker-setup.md](./docker-setup.md).

## Manual Local Development

Manual setup requires Node.js 22+, FFmpeg, yt-dlp, a running PostgreSQL 18 instance, and a running Redis instance.

```bash
npm run install:all
```

Backend env:

```bash
cp backend/.env.example backend/.env
# Edit DATABASE_URL, SESSION_SECRET, REDIS_PASSWORD, GEMINI_API_KEY
```

Generate Prisma client and run migrations:

```bash
cd backend
npx prisma migrate deploy
```

Create the first admin user:

```bash
npm run auth:create-user -- --email admin@example.com --password 'yourpassword'
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
http://localhost:3000/login
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

Database and auth (Docker):

```bash
# Create admin user
docker compose exec backend npm run auth:create-user -- --email admin@example.com --password 'yourpassword'

# Reset admin password
docker compose exec backend npm run auth:create-user -- --email admin@example.com --password 'newpassword' --reset

# Run pending migrations manually
docker compose exec backend npm run db:migrate

# Open Prisma Studio (dev only)
docker compose exec backend npx prisma studio
```

Local production-style Docker:

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.prod.local -f docker-compose.prod.yml exec backend npm run auth:create-user -- --email admin@example.com --password 'yourpassword'
```

## Production Deployment

Production deployment is Docker-based and uses nginx as the public reverse proxy. For a fresh VPS with no existing TLS certificate, use the first-time certificate bootstrap flow in [docker-setup.md](./docker-setup.md#vps-production-setup).

High-level flow:

```bash
cp .env.example .env.prod
```

Edit `.env.prod` with your real domain, email, keys, and passwords:

```env
APP_DOMAIN=yourdomain.com
LETSENCRYPT_EMAIL=you@example.com
GEMINI_API_KEY=your_key
REDIS_PASSWORD=strong_random_password
POSTGRES_PASSWORD=strong_random_password
SESSION_SECRET=strong_random_secret
NEXT_PUBLIC_API_URL=/api
CORS_ORIGIN=https://yourdomain.com
```

For Gemini free tier or constrained deployments, use:

```env
CHUNK_DURATION_SEC=180
CHUNK_OVERLAP_SEC=20
CHUNK_CONCURRENCY=1
```

For higher usage, use:

```env
CHUNK_DURATION_SEC=300
CHUNK_OVERLAP_SEC=30
CHUNK_CONCURRENCY=4
```

Then follow [VPS Production Setup](./docker-setup.md#vps-production-setup).

After starting the stack, create the admin user:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec backend npm run auth:create-user -- --email admin@yourdomain.com --password 'strongpassword'
```

## Environment Files

- `.env`: Default Docker Compose environment file.
- `.env.example`: Template for Docker Compose environments.
- `.env.prod.local`: Local production-style Docker test values.
- `.env.prod`: Recommended VPS production env file created from `.env.example`.
- `backend/.env`: Used only when running the backend directly outside Docker.
- `frontend/.env.local`: Used only when running/building the frontend directly outside Docker.

Important: `NEXT_PUBLIC_API_URL` is baked into Next.js production builds. Rebuild the frontend Docker image after changing it.

## YouTube URL Imports

YouTube imports use `yt-dlp` in the backend container. Local imports may work
without extra settings, but VPS and datacenter IPs are often challenged by
YouTube. In that case, configure:

```env
YTDLP_COOKIES_PATH=/app/storage/yt-dlp-cookies.txt
YTDLP_USER_AGENT=
```

`YTDLP_COOKIES_PATH` must point to a Netscape-format cookies file inside the
backend container. For Docker deployments, place that file under
`backend/storage/` on the host because it is mounted at `/app/storage` in the
container. `YTDLP_USER_AGENT` is optional and should match the browser/profile
used to export the cookies when needed.

Client-facing import and transcription failures are sanitized by the backend.
The API returns `failureReason` and `processingJob.errorCode`; frontend pages
should render those values rather than exposing raw `yt-dlp`, FFmpeg, or model
provider errors.

## Transcription Chunking

Long audio is split into overlapping chunks before Gemini transcription. Lower concurrency is safer for Gemini free tier; higher concurrency is faster but can trigger rate limits or `503` high-demand errors.

Free tier or constrained deployments:

```env
CHUNK_DURATION_SEC=180
CHUNK_OVERLAP_SEC=20
CHUNK_CONCURRENCY=1
```

Higher usage:

```env
CHUNK_DURATION_SEC=300
CHUNK_OVERLAP_SEC=30
CHUNK_CONCURRENCY=4
```

## Project Layout

```text
backend/              Express API, Prisma ORM, auth, processing routes, uploads
backend/prisma/       Prisma schema and migration files
frontend/             Next.js app, login page, auth middleware, UI components
nginx/                Local HTTP and production HTTPS nginx configs
docker-compose.yml    Docker development stack (Postgres, Redis, backend, frontend)
docker-compose.prod.yml  Production stack (+ nginx, Certbot)
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
Login:    http://localhost:3000/login
```

Local production-style Docker through nginx:

```text
App:   http://localhost/upload
API:   http://localhost/api
Login: http://localhost/login
```

## License

Vinci Clips is licensed under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).
