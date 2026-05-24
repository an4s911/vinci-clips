# Claude Agent Notes

## Project Overview

Vinci Clips: AI video clipping platform. Upload/import videos → transcribe → AI clip analysis → generate clips with captions and reframing.

**Stack:**
- **Frontend:** Next.js 15, React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Node.js 22, Express
- **Database:** PostgreSQL 18 via Prisma ORM (`backend/prisma/schema.prisma`)
- **Auth:** Redis-backed express-session, Argon2 passwords, single admin user via CLI
- **AI:** faster-whisper/CTranslate2 (local transcription, int8 CPU), Google Gemini API (clip analysis only)
- **Video:** FFmpeg (conversion, caption burning), yt-dlp (YouTube downloads)
- **Queue:** BullMQ + Redis for all background work

## Key Paths

| Path | Purpose |
|---|---|
| `backend/src/index.js` | Express entry, middleware, route mounting |
| `backend/src/routes/` | All API routes mounted under `/clips/` |
| `backend/src/routes/external.js` | External API routes (`/api/v1`) — pipeline trigger + progress |
| `backend/src/utils/apiKeySettings.js` | API key generate/verify/revoke (hashed in `AppSetting`) |
| `backend/src/utils/videoUrl.js` | Shared `validateUrl` + `detectPlatform` |
| `backend/src/queue/stages.js` | Pipeline stage definitions |
| `backend/src/queue/workers.js` | BullMQ worker dispatch |
| `backend/src/utils/whisperTranscription.js` | faster-whisper transcription driver |
| `backend/src/utils/backgroundJobs.js` | Job state, cancellation, tracking |
| `backend/src/localdb.js` | Prisma adapter (Mongoose-like API) |
| `backend/src/models/Transcript.js` | Thin wrapper over localdb |
| `frontend/src/app/` | Next.js App Router pages |
| `frontend/src/lib/api.ts` | Axios client (`withCredentials`, 401 redirect) |

## Core Workflow

1. User uploads or imports URL → `userId` attached to transcript record
2. FFmpeg converts to MP3
3. **faster-whisper** transcribes to word-level `{ start, end, text }` entries (millisecond precision)
4. Gemini analyzes transcript → ranked clip suggestions
5. Clips generated via FFmpeg; captions burned in for social media

## Common Commands

```bash
docker compose up --build                         # Start dev stack (runs migrations + prisma generate automatically)
docker compose logs -f backend                    # Tail logs
docker compose exec backend npm run auth:create-user -- --email x@x.com --password 'pw'

# Prod
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

**Adding packages:** run `npm install <pkg>` inside the relevant directory (`backend/` or `frontend/`) so `package-lock.json` stays in sync. Docker will pick it up on the next `--build`.

## Docker Compose

Project runs via Docker Compose. Two stacks:
- **Dev:** `docker-compose.yml` — backend, frontend, Postgres, Redis
- **Prod:** `docker-compose.prod.yml` — same + nginx, Certbot

**The only env file that matters is `/.env` (root).** `/.env.example` is the template. In production, copy to `/.env.prod` and pass with `--env-file .env.prod`. `backend/.env` and `frontend/.env.local` are only relevant for running services outside Docker — ignore them for Docker-based work.

## Environment Variables

See `/.env.example` for full list. Critical vars:

| Var | Purpose |
|---|---|
| `GEMINI_API_KEY` | Clip analysis (analyze stage only — not transcription) |
| `WHISPER_MODEL` | Path to CT2 model directory (default: `/app/models/faster-whisper-large-v3-turbo`). **Changing this env var alone is not enough in prod** — model is baked into the Docker image. Switching requires a Dockerfile change + rebuild. |
| `WHISPER_THREADS` | CPU threads for faster-whisper (default: all CPUs) |
| `WHISPER_LANGUAGE` | Language hint (default: auto) |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Session signing key |
| `REDIS_PASSWORD` | Redis auth |
| `YOUTUBE_API_KEY` | YouTube metadata API (required for URL imports) |
| `VIDEO_DOWNLOAD_PROVIDER` | `ytdlp` (default), `savenow`, or `cloudapihub` |
| `VIDEO_DOWNLOAD_RAPIDAPI_KEY` | RapidAPI key for `cloudapihub` provider (CloudApiHub YouTube Downloader) |
| `CLOUDAPIHUB_CHUNK_COUNT` | Parallel Range-request chunks per stream for `cloudapihub` (default: `8`). Total connections = `PIPELINE_NETWORK_CONCURRENCY × CLOUDAPIHUB_CHUNK_COUNT × 2` |
| `PIPELINE_LOCK_DURATION_MS` | BullMQ job lock TTL in ms (default: `60000`). Longer than the stall check interval — renewed while the job runs. Lets long ffmpeg/whisper jobs survive a single restart. |
| `PIPELINE_MAX_STALLED` | Max times a stalled job is re-claimed before being permanently failed (default: `3`). Prevents a single restart from permanently failing a long-running job. |
| `RECONCILE_STALE_THRESHOLD_MIN` | Periodic reconcile: minutes before an orphaned row is acted on (default: `2`). Boot reconcile always ignores this threshold. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth 2.0 web client used for Google Drive export. A service account is **not** used (it cannot upload to a personal My Drive). |
| `GOOGLE_OAUTH_REDIRECT_URI` | Drive OAuth callback. Must match a registered redirect URI. Dev: `http://localhost:8080/clips/google-drive/auth/callback`; prod: `https://<APP_DOMAIN>/api/clips/google-drive/auth/callback`. |
| `GOOGLE_OAUTH_SUCCESS_REDIRECT` | Optional. Where the browser lands after OAuth. Defaults to first `CORS_ORIGIN` + `/clips/settings/google-drive`. |
| `DRIVE_EXPORT_CONCURRENCY` | Parallel clip uploads per export on the `drive-export` lane (default: `1`). |
| `DRIVE_EXPORT_ATTEMPTS` | Retries per clip upload before it is marked failed (default: falls back to `PIPELINE_STAGE_ATTEMPTS`). |

Python dependencies and models are baked into the Docker image. For local dev outside Docker, install faster-whisper and download a CT2 model directory manually.

## Queue Architecture

Three BullMQ lanes:

| Lane | Concurrency env | Carries |
|---|---|---|
| `pipeline-network` | `PIPELINE_NETWORK_CONCURRENCY` (3) | extract-metadata, download-video |
| `pipeline-transcribe` | `PIPELINE_TRANSCRIBE_CONCURRENCY` (2) | analyze (Gemini, network-bound) |
| `pipeline-media` | `PIPELINE_MEDIA_CONCURRENCY` (2) | **transcribe**, convert-mp3, thumbnail, persist-files, probe-duration, clip-generate, clip-render |
| `drive-export` | `DRIVE_EXPORT_CONCURRENCY` (1) | Google Drive clip uploads (network-bound; kept off the media CPU cap) |

`pipeline-media` is the global CPU/ffmpeg cap — faster-whisper and ffmpeg share this concurrency limit.

**Priorities** (lower = sooner): pipeline stages = 1, auto clip-gen = 5, manual clip-gen = 8, manual render = 10.

### Auto Bulk Edit

After all clips generate, `maybeFinalizeTranscriptClips` checks the global `AppSetting` (key `"autoBulkEdit"`) via `backend/src/utils/appSettings.js`. If enabled, the transcript moves to phase `bulk-edit` and a `clip-render` job is enqueued for every clip. A second finalizer, `maybeFinalizeBulkEdit` (`pipeline.js`), completes/fails the transcript once all renders are terminal.

Global config is stored in the `AppSetting` DB table (key/value JSON, single row). Managed via `GET`/`PUT /clips/settings/auto-bulk-edit`. Settings UI at `/clips/settings/auto-bulk-edit`.

**Resilience:** auto renders are tagged `origin:'pipeline'` + `autoAttempts` counter. On server restart BullMQ stall re-claim resumes active renders. Queue drops are recovered by the reconciler (`reconcile.js`): orphaned auto renders are re-enqueued by rebuilding payloads from config + clip state (no user needed); capped at `MAX_AUTO_REQUEUE_ATTEMPTS` (3). Phase `bulk-edit` is NOT a `PIPELINE_STAGES` entry — it is owned by the deadlock sweep in `reconcile.js`, not by `enqueuePipeline`.

### Google Drive Export

Admins can export selected clips straight to a Google Drive folder. **Auth is OAuth 2.0 (web client), not the service account** — a service account cannot upload to a personal My Drive (0 storage quota). The admin connects their Google account once; the refresh token is stored in `AppSetting` key `googleDriveAuth`. Saved export folders live in `AppSetting` key `googleDriveFolders`. Both are managed by `backend/src/utils/googleDriveSettings.js`; Drive API calls (search/upload) are in `backend/src/utils/googleDrive.js`.

Routes are under `/clips/google-drive/*` (`backend/src/routes/googleDrive.js`, admin-gated): OAuth `auth/url|callback|status|disconnect`, folder `folders[/search|/:id]`, and `export` + `exports[/:id]`.

Each export is a `DriveExport` row (Prisma) with a per-clip `items` array. `POST /export` validates clips, creates the row, and enqueues **one `drive-export` job per clip**. The worker (`workers.js`) resolves the clip file via the same path-safety helper as downloads (`resolveClipFilePath` → `getVideoFilePath`) and streams it to Drive; filenames are `<videoId>.mp4`. Item/export status is recomputed atomically in `backend/src/utils/driveExports.js`.

**Resilience:** multiple exports run concurrently. Stalled jobs are re-claimed by BullMQ on restart; queue-dropped items are re-enqueued by `reconcileDriveExports` in `reconcile.js` (capped per item). The frontend `DriveExportsProvider` polls `/exports?status=active` and renders a global tray on every page, so concurrent exports across transcripts/pages are all tracked.

### Adding a new pipeline stage

1. Add descriptor to `PIPELINE_STAGES` in `backend/src/queue/stages.js`
2. Implement `run(ctx)` and `isComplete(transcript, jobType)`
3. Assign `lane`: `network`, `transcribe`, or `media`

### Transcript title vs filename

`Transcript.title` is the human-readable display name — raw YouTube video title (set at `extract-metadata` stage in `stages.js`) or uploaded filename without extension (set in `upload.js`). It is editable via `PUT /clips/transcripts/:id { title }`. Falls back to `originalFilename` in the UI for old records.

`originalFilename` retains its filesystem role: the on-disk `.mp4` name for YouTube imports (`<sanitized-title>-<id>.mp4`) and the raw uploaded filename. Used for file-path resolution (`stages.js:71,303`), zip download names (`clips.js:228`), and reframe output names (`reframe.js:378`). Never use `title` for file path work.

### Transcript output contract

`runTranscribe` returns `{ transcript, model }` where `transcript` is a non-empty flat array of `{ start, end, text }` — one word per entry, `start`/`end` as `"MM:SS:mmm"` strings. Downstream `clipAnalysis.js` and `captioning.js` depend on this shape.

### Per-clip thumbnails

Every clip video record (`ClipVideo`) has a `thumbnailUrl` field (e.g. `/uploads/clips/xxx_thumbnail.jpg`). Thumbnails are generated via FFmpeg (first frame) immediately after the clip video file is written, inside `generateSingleClipInBackground` (`clipGeneration.js`) and both render paths in `renderJobs.js` (`runReframeRender`, `runCaptionRender`). Generation is non-fatal — if FFmpeg fails, `thumbnailUrl` is null and the clip still works.

**Deletion:** thumbnail files are cleaned up everywhere clip videos are deleted:
- `deleteClipVideoVersion` (`clipVideos.js`) — explicit delete alongside the video
- `DELETE /:transcriptId/:clipIndex` and `DELETE /:id/clips` route handlers (`clips.js`, `transcripts.js`) — explicit delete in the video loop
- `deleteTranscriptMedia` (`mediaStorage.js`) — automatic, because `collectStringReferences` recursively scans all `/uploads/` strings in the clips JSONB, which includes `thumbnailUrl`

**Frontend:** all `<video>` elements on the detail page and bulk-download page use `preload="none"` (no streaming on mount) and `poster={thumbnailUrl}` so each clip shows its thumbnail immediately. Version videos are only mounted in the DOM when the "Versions" `<details>` is opened.

Old clips generated before this change have no `thumbnailUrl` (null) — they show a blank video player until played, which is expected.

## External API

A machine-to-machine HTTP API lives at `/api/v1` (mounted in `index.js` before the session-gated `/clips` mount). It is independent of the browser session; auth is an API key sent as `X-Api-Key` or `Authorization: Bearer`.

**Auth flow:**
- `requireApiKey` middleware (`src/middleware/auth.js`) verifies the presented key against a SHA-256 hash stored in `AppSetting` key `externalApiKey` using `crypto.timingSafeEqual`. No open-fallback — missing key always 401s.
- On success it resolves the oldest active admin user and attaches as `req.user`, so downstream code (`req.user.id`) works identically to session auth.
- Key management (generate/status/revoke) is session-gated under `POST/GET/DELETE /clips/settings/api-key`.

**Routes:**
- `POST /api/v1/pipeline` `{ url }` — trigger URL import pipeline; returns `202 { id, status }`.
- `GET /api/v1/pipeline/:id` — poll progress; returns `{ id, status, phase, message, failureReason, failedStage, clipCount, updatedAt }`.

Transcripts created via the external API are owned by the admin user and appear normally in the admin UI. `validateUrl`/`detectPlatform` are shared with `src/routes/import.js` via `src/utils/videoUrl.js`.

## Important Rules

- **When code changes require documentation or introduce/remove env vars, update `README.md`, `AGENTS.md`, `.env.example`, and `backend/.env.example` automatically — do not wait to be asked.**
- Never run `npm run build` — ask the user to do it.
- In production, use `docker-compose.prod.yml`.
- In commits, remove any presence of Claude (no mentions in commit messages).
- All API routes are prefixed with `/clips/`. Auth at `/clips/auth/*`. All routes except login require auth.
- Background jobs call `Transcript.findByIdAndUpdate` without `userId` — this is intentional.
- `GEMINI_API_KEY` is only used by the analyze stage; transcription uses faster-whisper locally.
