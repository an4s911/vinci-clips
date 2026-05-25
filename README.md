# Vinci Clips

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.3.5-black)](https://nextjs.org/)

AI-powered video clipping platform for turning long-form videos into short clips with transcription, AI clip analysis, reframing, captions, and downloadable generated videos.

## What It Does

- Upload local videos or import supported URLs.
- Process media with FFmpeg and local filesystem storage.
- Import YouTube URLs with yt-dlp, with optional cookie and user-agent settings for server/VPS deployments.
- Transcribe audio locally with faster-whisper/CTranslate2 (word-level timestamps, no API cost).
- Analyze transcripts and suggest high-signal clips.
- Generate single-segment or multi-segment clips in background jobs.
- Track durable processing progress across page reloads.
- Reframe generated clips for social platforms and add captions.
- Export selected clips straight to a Google Drive folder (OAuth, background uploads with progress).
- Auto-expire transcripts: every video (source files, clips, reframe assets) is deleted 24 hours after its pipeline finishes. The window resets on any new clip generation, render, reframe, or bulk-edit. Configurable via `TRANSCRIPT_TTL_HOURS`.
- Multi-user ready auth with Postgres-backed sessions.

## Tech Stack

- **Frontend:** Next.js 15, React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Node.js 22, Express
- **Persistence:** PostgreSQL 18 via Prisma ORM
- **Sessions:** Redis-backed express-session with HttpOnly cookies
- **Media:** Local files under `backend/uploads`
- **AI:** Google Gemini API (analysis), faster-whisper/CTranslate2 (transcription)
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

Manual setup requires Node.js 22+, Python 3, FFmpeg, yt-dlp, faster-whisper, a CTranslate2 Whisper model directory, a running PostgreSQL 18 instance, and a running Redis instance.

```bash
npm run install:all
```

Backend env:

```bash
cp backend/.env.example backend/.env
# Edit DATABASE_URL, SESSION_SECRET, REDIS_PASSWORD, GEMINI_API_KEY, WHISPER_MODEL
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

## Google Drive Export

Export selected clips directly to a Google Drive folder. Uploads run as background
jobs (one per clip) with progress tracked in a global tray; concurrent exports are
supported and survive server restarts.

Auth uses **OAuth 2.0 (web client)**, not a service account — a service account
cannot upload to a personal My Drive (it has no storage quota). The admin connects
their own Google account once and uploads go into their Drive.

One-time setup in Google Cloud Console:

1. Enable the **Google Drive API** in the project that owns the OAuth web client.
2. OAuth consent screen: External, **Testing** mode; add the admin email as a
   **Test user**; add scope `https://www.googleapis.com/auth/drive`.
3. On the Web OAuth client, add **Authorized redirect URIs**:
   - dev: `http://localhost:8080/clips/google-drive/auth/callback`
   - prod: `https://<APP_DOMAIN>/api/clips/google-drive/auth/callback`
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` in `.env`.

Then in the app: **Settings → Google Drive → Connect**, search and add export
folders, and use **Export to Drive** from a transcript's clip selection or the
Bulk Download page. Uploaded files are named `<clipId>.mp4`.

## YouTube URL Imports

YouTube imports use `yt-dlp` in the backend container. Local imports work without
extra configuration, but VPS and datacenter IPs are challenged by YouTube's bot
detection. For production deployments, use an account dedicated to this service
and provide exported cookies to `yt-dlp`.

### Cookie-based YouTube imports

Export Netscape-format YouTube cookies from a browser, place the file under
`backend/storage/` on the host (mounted at `/app/storage` in the container), and
set:

```env
YTDLP_COOKIES_PATH=/app/storage/yt-dlp-cookies.txt
YTDLP_USER_AGENT=
```

Note: cookies are session credentials. Use a dedicated account, restrict access
to the cookie file, and expect to refresh it when Google expires the session or
requires account verification. YouTube URL imports should still be treated as a
best-effort source; direct file upload remains the stable ingestion path.

### Error handling

Client-facing import and transcription failures are sanitized by the backend.
The API returns `failureReason` and `processingJob.errorCode`; frontend pages
should render those values rather than exposing raw `yt-dlp`, FFmpeg, or model
provider errors.

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

## External API

Vinci Clips exposes a small machine-to-machine HTTP API so external services can trigger the video pipeline and poll progress without a browser session.

### Authentication

Generate an API key from the admin settings (session required):

```bash
# generate (plaintext shown once — save it)
curl -s -X POST http://localhost:8080/clips/settings/api-key \
  -H 'Cookie: vc.sid=<your-session-cookie>'

# check status (never returns the key itself)
curl -s http://localhost:8080/clips/settings/api-key \
  -H 'Cookie: vc.sid=<your-session-cookie>'

# revoke
curl -s -X DELETE http://localhost:8080/clips/settings/api-key \
  -H 'Cookie: vc.sid=<your-session-cookie>'
```

Pass the key on every external API request via either header:

```
X-Api-Key: vc_<key>
Authorization: Bearer vc_<key>
```

The key is stored as a SHA-256 hash in the database (`AppSetting` key `externalApiKey`). It is rotatable at runtime without redeploying.

### Trigger pipeline

```bash
POST /api/v1/pipeline
Content-Type: application/json
X-Api-Key: vc_<key>

{ "url": "https://www.youtube.com/watch?v=..." }
```

Supported platforms: YouTube, Instagram, LinkedIn, TikTok, Facebook.

Response `202`:

```json
{ "id": "<transcript-id>", "status": "uploading" }
```

### Poll progress

```bash
GET /api/v1/pipeline/:id
X-Api-Key: vc_<key>
```

Response:

```json
{
  "id": "...",
  "status": "generating",
  "phase": "clips",
  "message": "Generating clips...",
  "failureReason": null,
  "failedStage": null,
  "clipCount": 0,
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

`status` values: `uploading → downloading → converting → transcribing → analyzing → generating → rendering → completed | failed | cancelled`.

Poll until `status` is `completed` (or `failed`/`cancelled`). At `completed`, `clipCount` reflects the number of generated clips, which also appear in the normal admin UI.

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
