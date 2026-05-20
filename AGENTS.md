# Claude Agent Notes

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vinci Clips is an AI-powered video clipping tool that automatically generates short, engaging video clips from longer videos. The application uses AI to transcribe videos, analyze transcripts, and suggest the best moments to turn into clips.

**Architecture:**
- **Frontend:** Next.js application with React, TypeScript, and Tailwind CSS
- **Backend:** Node.js 22 / Express REST API server
- **Database:** PostgreSQL 18 via Prisma ORM (schema at `backend/prisma/schema.prisma`)
- **Auth:** Redis-backed express-session with Argon2 password hashes; single admin user created via CLI
- **Transcript adapter:** `backend/src/localdb.js` — Prisma-backed drop-in with Mongoose-like API; consumed via `backend/src/models/Transcript.js`
- **AI Services:** Google Gemini API for transcription and analysis
- **Media Storage:** Local filesystem storage for video/audio files; Cloudflare R2 support is planned
- **Video Processing:** FFmpeg for video-to-audio conversion and caption burning

## Development Commands

### Root Level Commands
```bash
# Install dependencies for both frontend and backend
npm run install:all

# Start both frontend and backend concurrently
npm start

# Start only backend (runs on port 8080)
npm run start:backend

# Start only frontend (runs on port 3000)
npm run start:frontend
```

### Backend Commands (from /backend directory)
```bash
# Start production server
npm start

# Start development server with auto-reload
npm run dev

# Run tests
npm test

# Generate Prisma client after schema changes
npm run db:generate

# Apply pending migrations
npm run db:migrate

# Push schema to DB without migration files (dev shortcut)
npm run db:push

# Create or reset an admin user
npm run auth:create-user -- --email admin@example.com --password 'secret'
npm run auth:create-user -- --email admin@example.com --password 'newsecret' --reset
```

### Frontend Commands (from /frontend directory)
```bash
# Start development server with Turbopack
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run ESLint
npm run lint
```

## Key Architecture Patterns

### Backend Structure
- **Entry point:** `src/index.js` — Express server with session middleware, auth middleware, CORS, and route mounting
- **Auth middleware:** `src/middleware/auth.js` — `loadUser` (attaches req.user from session) and `requireAuth` (blocks 401)
- **Auth routes:** `src/routes/auth.js` — login, logout, me, change-password at `/clips/auth/*`
- **Database client:** `src/db/prisma.js` — singleton PrismaClient
- **Transcript adapter:** `src/localdb.js` — Prisma-backed with same Mongoose-like API as the old JSON adapter; maps Prisma `id` → `_id` in all responses
- **Models:** `src/models/Transcript.js` — thin wrapper over localdb
- **Routes:** `src/routes/` — modular route handlers mounted under `/clips` prefix (all require auth except `/clips/auth/login`)
  - `upload.js` - File upload and processing
  - `import.js` - URL import from supported platforms
  - `transcripts.js` - Transcript CRUD (userId-scoped)
  - `analyze.js` - AI analysis endpoints
  - `clips.js` - Clip management and generation
  - `captions.js` - Caption generation and style management
  - `reframe.js` - Video reframing for social platforms
  - `streamer.js` - Streamer+gameplay composition
  - `retry-transcription.js` - Retry failed transcriptions
  - `storage.js` - Storage usage and cleanup (requires MEDIA_ADMIN_TOKEN)
  - `fix-status.js` - Admin endpoint to fix stuck statuses
- **Background jobs:** `src/utils/backgroundJobs.js` — async job state management; calls `Transcript.findByIdAndUpdate` without userId (correct, these are internal updates)
- **Media protection:** `/uploads/*` is served behind `requireAuth` middleware
- **File Processing:** Uses `fluent-ffmpeg` for video-to-MP3 conversion and caption burning
- **URL import services:**
  - `src/services/youtubeMetadata.js` — always used for YouTube metadata via YouTube Data API v3 (requires `YOUTUBE_API_KEY`)
  - `src/services/savenowDownloader.js` — download provider using `video-download-api.com`; selected via `VIDEO_DOWNLOAD_PROVIDER=savenow`
  - Download provider toggled by `VIDEO_DOWNLOAD_PROVIDER` env var: `ytdlp` (default) or `savenow`

### Frontend Structure
- **App Router:** Uses Next.js 13+ app directory structure
- **Auth guard:** `src/middleware.ts` — redirects to `/login` if `vc.sid` cookie is absent
- **Login page:** `src/app/login/page.tsx` — POST to `/clips/auth/login`, stores session cookie
- **Global auth setup:** `src/components/AuthProvider.tsx` — sets `axios.defaults.withCredentials = true` and installs a 401→/login interceptor
- **Shell:** `src/components/AppShell.tsx` — conditionally renders Header/Footer (hidden on /login)
- **API client:** `src/lib/api.ts` — axios instance with `withCredentials: true` and 401 redirect
- **Main Pages:**
  - `/login` - Sign-in form
  - `/` → redirects to `/upload`
  - `/upload` - Video upload/import interface
  - `/clips/transcripts` - List all processed videos
  - `/clips/transcripts/[id]` - Individual transcript detail with video player
  - `/clips/bulk-download` - Select and download multiple clips
- **Components:** Shadcn/ui components in `src/components/ui/`
- **Styling:** Tailwind CSS with custom configuration

### Core Workflow
1. User logs in at `/login`; session cookie `vc.sid` set by backend
2. Authenticated user uploads video via drag-and-drop interface
3. Backend creates transcript record with `userId: req.user.id`
4. Backend converts video to MP3 using FFmpeg in background
5. Media files saved under local backend media directories
6. Gemini API transcribes audio with word-level timestamps and speaker diarization
7. Transcript data saved to Postgres through Prisma adapter
8. Frontend displays transcript with video playback (media served from auth-protected `/uploads/*`)
9. **Caption Generation:** FFmpeg burns styled captions into video clips for social media

## Environment Setup

### Required Environment Variables (backend/.env)
```
PORT=8080
GEMINI_API_KEY=<gemini-api-key>
LLM_MODEL=gemini-2.5-flash
CHUNK_DURATION_SEC=180
CHUNK_OVERLAP_SEC=20
CHUNK_CONCURRENCY=1
DATABASE_URL=postgresql://vinci:password@localhost:5432/vinci_clips?schema=public
SESSION_SECRET=<openssl rand -base64 48>
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=<password>
```

For higher transcription usage, use `CHUNK_DURATION_SEC=300`, `CHUNK_OVERLAP_SEC=30`, and `CHUNK_CONCURRENCY=4`.

### YouTube Import Environment Variables
```
# Always required for YouTube URL imports (metadata)
YOUTUBE_API_KEY=<youtube-data-api-v3-key>

# Download provider: ytdlp (default) or savenow
VIDEO_DOWNLOAD_PROVIDER=ytdlp

# Required only when VIDEO_DOWNLOAD_PROVIDER=savenow
VIDEO_DOWNLOAD_API_HOST=p.savenow.to
VIDEO_DOWNLOAD_API_KEY=<savenow-api-key>
VIDEO_DOWNLOAD_FORMAT=1080

# yt-dlp bot-detection bypass (ytdlp provider only)
# bgutil-provider sidecar runs in docker-compose.prod.yml, generates PO tokens automatically
YTDLP_BGUTIL_URL=http://bgutil-provider:4416
# Export Firefox cookies (Netscape format), place in backend/cookies/, set path:
# After uploading cookies to the VPS, fix ownership so the container (uid 1001) can write to it:
#   sudo chown 1001:1001 ~/vinci-clips/backend/cookies/yt-cookies.txt
YTDLP_COOKIES_PATH=
YTDLP_USER_AGENT=

# Cookie expiry monitor (auto-enabled when YTDLP_COOKIES_PATH is set)
# Warns in logs COOKIE_WARN_DAYS days before expiry; posts to COOKIE_ALERT_WEBHOOK if set.
# Re-export cookies manually every 2-4 weeks — see .inbox/export_yt_cookies.py.
COOKIE_MONITOR_ENABLED=true
COOKIE_MONITOR_INTERVAL_HOURS=12
COOKIE_WARN_DAYS=3
COOKIE_ALERT_WEBHOOK=
```

### Prerequisites
- Node.js v22+
- FFmpeg in system PATH
- PostgreSQL 18 (or Docker)
- Redis (or Docker)
- Gemini API key
- YouTube Data API v3 key (for URL imports)
- savenow API key (optional, only if `VIDEO_DOWNLOAD_PROVIDER=savenow`)

## Development Guidelines

### File Path Conventions
- Frontend imports use `@/` alias pointing to `frontend/src/`
- All API endpoints prefixed with `/clips/`
- Auth endpoints at `/clips/auth/login`, `/clips/auth/logout`, `/clips/auth/me`, `/clips/auth/change-password`
- Backend API URL in frontend is `process.env.NEXT_PUBLIC_API_URL`

### Transcript Model Interface
All backend code accesses transcripts through `require('../models/Transcript')` which wraps `localdb.js`. The Prisma adapter preserves the Mongoose-like interface:
- `Transcript.find({ userId })` — list transcripts for a user
- `Transcript.findById(id, { userId })` — get one (returns null if userId mismatch)
- `Transcript.create({ userId, ...fields })` — userId required
- `Transcript.findByIdAndUpdate(id, partialData)` — partial update, userId not required
- `Transcript.findByIdAndDelete(id)` — delete by id
- Returned docs have `_id` (mapped from Prisma `id`), and a `.save()` method

Background jobs use `findByIdAndUpdate` without userId — this is intentional since jobs are internal and operate on specific IDs.

### Code Style
- ESLint with Next.js configuration for frontend
- TypeScript for frontend components and interfaces
- JavaScript for backend with JSDoc comments
- Consistent error handling with try-catch blocks

### Testing Approach
- Backend: Jest for unit tests, Supertest for API tests
- Frontend: React Testing Library (configured)
- File upload limit: 2GB with client-side validation

## Current Development Status

### Completed Features
- Video file upload with progress tracking and status management
- Video-to-MP3 conversion and cloud storage with thumbnail generation
- Gemini API transcription with speaker diarization (segment-level timestamps)
- Transcript storage and retrieval with status tracking (now in Postgres)
- AI-powered clip analysis and generation
- Frontend interfaces for upload, transcript viewing, and clip management
- Homepage with recent videos and status indicators
- Comprehensive status management system (uploading → converting → transcribing → completed/failed)
- **Auth system**: Postgres User table + Argon2 passwords + Redis session store + CLI user creation

### In Development: TikTok/Reels Caption System
- **Technical Requirements:**
  - Upgrade Gemini API integration to use `audioTimestamp: true` for word-level precision
  - Implement FFmpeg caption burning with popular social media styles
  - Create caption style presets (Bold Center, Neon Pop, Typewriter, Bubble, Minimal Clean)
  - Add popular fonts (Montserrat, Poppins, Bebas Neue, Oswald, Roboto) to system
- **Caption Styles Specification:**
  - **Bold Center**: Heavy sans-serif, center-aligned, white text with black outline, suitable for all content
  - **Neon Pop**: Bright gradient colors (yellow/pink/cyan), bold fonts, drop shadows, trending style
  - **Typewriter**: Monospace fonts, word-by-word appearance animation, vintage aesthetic
  - **Bubble Style**: Rounded text backgrounds, colorful overlays, soft shadows, friendly tone
  - **Minimal Clean**: Light fonts, subtle backgrounds, elegant spacing, professional look
- **Implementation Plan:**
  1. Modify Gemini API call to include word-level timestamps
  2. Create caption style engine with FFmpeg integration
  3. Build style preset selection UI with live preview
  4. Test word-timing accuracy and style rendering quality

### Next Development Priorities
#### Phase 1: Core Platform Enhancements (High Priority)
- URL video import from YouTube, Instagram, LinkedIn, Vimeo, TikTok
- Fix clip generation routing issues and improve error handling
- Enhanced UI/UX with responsive design and mobile optimization
- Performance optimization with background job processing

#### Phase 2: Advanced Content Features (Medium Priority)
- **TikTok/Reels Style Captions (HIGH PRIORITY)** - Burned-in captions with popular social media styles
  - Word-level timestamp precision using Gemini API `audioTimestamp: true`
  - Popular caption styles: Bold Center, Neon Pop, Typewriter, Bubble, Minimal Clean
  - Popular fonts: Montserrat Bold, Poppins SemiBold, Bebas Neue, Oswald, Roboto Black
  - FFmpeg integration for burning captions directly into video
  - Style preset selection UI with real-time preview
- Auto-reframing for social media aspect ratios (9:16, 1:1, 16:9) with AI subject detection
- AI-generated B-roll integration for enhanced clip engagement
- Timeline-based clip preview and editing functionality

#### Phase 3: Social Media & Publishing (Lower Priority)
- Direct publishing to social media platforms (YouTube, TikTok, Instagram, Facebook, LinkedIn, X)
- Content scheduling calendar with optimal posting time suggestions
- AI-generated metadata (captions, hashtags, descriptions) for social posts
- Analytics dashboard for performance tracking and engagement metrics

## Important Notes

- Frontend uses Turbopack for faster development builds
- All API responses follow consistent JSON format
- File uploads handled via multer middleware
- When planning ensure we commit changes to git time to time to ensure progress
- When any issues are identified which may be longer, log them as issues on git
- When code changes require documentation, document them in `README.md` or in the relevant `.md` files listed from `README.md`.
- in commits remove any presence of Claude including any mentions in the commit message
- Never run `npm run build`, ask the user to do so if needed.
- In production, the file `docker-compose.prod.yml` is used.
