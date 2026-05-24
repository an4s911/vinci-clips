# Docker Setup for Vinci Clips

This guide explains how to run Vinci Clips using Docker for both development and production environments.

## Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+
- Gemini API key

## Development Setup

### 1. Environment Configuration

Copy the example environment file and configure your settings:

```bash
# Copy the Docker environment template (project root)
cp .env.example .env
```

Edit `.env` and fill in your actual values:
- `GEMINI_API_KEY`: Your Google Gemini API key
- `REDIS_PASSWORD`: Local Redis password, for example `devredispassword`

**Important**: This `.env` file in the project root is specifically for Docker Compose. For local development without Docker, see the manual setup notes in `README.md`.

### 2. Start Development Environment

```bash
# First run or after dependency/Dockerfile changes
docker compose up --build

# Normal day-to-day development
docker compose up

# Or run in background
docker compose up -d
```

The frontend runs `npm run dev` and the backend runs `npm run dev` inside their
containers. Source directories are bind-mounted in development, so edits should
reload automatically without rebuilding the images. Rebuild only when
`package.json` / lockfiles or Dockerfiles change.

This will start:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8080
- **Postgres**: localhost:5432 by default. If your machine already uses port
  5432, set `POSTGRES_PORT=5433` in the project-root `.env` before starting
  Docker Compose. Containers still connect to Postgres on `postgres:5432`.
- **Redis**: localhost:6379, password-protected with `REDIS_PASSWORD`

### 3. Test Development Environment

```bash
docker compose ps
curl http://localhost:8080/health
curl http://localhost:3000/api/health
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping
```

Open the app at:

```text
http://localhost:3000/upload
```

### 4. View Logs

```bash
# View all logs
docker compose logs -f

# View specific service logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f redis
```

### 5. Stop Services

```bash
# Stop all services
docker compose down

# Stop and remove volumes (destroys Redis data)
docker compose down -v
```

## Local Production Build Test

The production Compose file runs the app/data containers and publishes the
frontend and backend on localhost for a host reverse proxy.

### 1. Configure Local Production Env

The repository includes `.env.prod.local` for local production-style testing. Confirm it has values like:

```env
APP_DOMAIN=localhost
LETSENCRYPT_EMAIL=admin@example.com
GEMINI_API_KEY=your_gemini_key_here
LLM_MODEL=gemini-2.5-flash
REDIS_PASSWORD=localredispassword
NEXT_PUBLIC_API_URL=/api
CORS_ORIGIN=http://localhost
CHUNK_DURATION_SEC=180
CHUNK_OVERLAP_SEC=20
CHUNK_CONCURRENCY=1
```

### 2. Prepare Local Persistent Directories

```bash
mkdir -p backend/uploads backend/storage backend/temp backend/cache backend/logs
```

### 3. Start Local Production Stack

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml up -d --build
```

### 4. Test Local Production Stack

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml ps
curl http://127.0.0.1:8080/health
curl -I http://127.0.0.1:3000
docker compose --env-file .env.prod.local -f docker-compose.prod.yml exec redis redis-cli -a localredispassword ping
```

Open:

```text
http://127.0.0.1:3000/upload
```

### 5. Stop Local Production Stack

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml down
```

## VPS Production Setup

### 1. Environment Configuration

Create a production environment file:

```bash
cp .env.example .env.prod
```

Configure production-specific values in `.env.prod`:
- Set `APP_DOMAIN` to the domain that points at your VPS
- Set `LETSENCRYPT_EMAIL` for certificate registration and renewal notices
- Set a strong `REDIS_PASSWORD`
- Set `NEXT_PUBLIC_API_URL=/api`
- Set `CORS_ORIGIN=https://$APP_DOMAIN`
- Optionally set `YTDLP_COOKIES_PATH` and `YTDLP_USER_AGENT` for YouTube imports from VPS/server IPs

Example:

```env
APP_DOMAIN=yourdomain.com
LETSENCRYPT_EMAIL=you@example.com
GEMINI_API_KEY=your_key
LLM_MODEL=gemini-2.5-flash
REDIS_PASSWORD=strong_random_password
NEXT_PUBLIC_API_URL=/api
CORS_ORIGIN=https://yourdomain.com
YTDLP_COOKIES_PATH=/app/storage/yt-dlp-cookies.txt
YTDLP_USER_AGENT=
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

### 2. Prepare Persistent Directories

Run this once on the VPS from the project root:

```bash
mkdir -p backend/uploads backend/storage backend/temp backend/cache backend/logs
sudo chown -R 1001:1001 backend/uploads backend/storage backend/temp backend/cache backend/logs
```

If YouTube imports are challenged on the VPS, export YouTube cookies from a
browser session in Netscape format, place the file under `backend/storage/`, and
point `YTDLP_COOKIES_PATH` at the in-container path:

```bash
cp yt-dlp-cookies.txt backend/storage/yt-dlp-cookies.txt
sudo chown 1001:1001 backend/storage/yt-dlp-cookies.txt
chmod 600 backend/storage/yt-dlp-cookies.txt
```

```env
YTDLP_COOKIES_PATH=/app/storage/yt-dlp-cookies.txt
```

Set `YTDLP_USER_AGENT` only when the cookies require the same browser user-agent
that exported them.

### 3. Install Host Nginx and Certbot

Host Nginx owns public ports 80 and 443. Host Certbot manages certificates in
`/etc/letsencrypt` and renews them with the normal system timer.

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

### 4. Enable the Host Nginx Site

Copy the HTTP-only site config, replace `example.com` with `APP_DOMAIN`, and
enable it. Host Nginx must be serving this HTTP site before `certbot --nginx`
can add HTTPS automatically.

```bash
sudo cp nginx/nginx.conf /etc/nginx/sites-available/vinci-clips
sudo sed -i "s/example.com/$APP_DOMAIN/g" /etc/nginx/sites-available/vinci-clips
sudo ln -sf /etc/nginx/sites-available/vinci-clips /etc/nginx/sites-enabled/vinci-clips
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

### 5. Migrate an Existing Docker Certbot Certificate

If this app already has certificates under `certbot/conf`, copy them once into
the host Certbot location:

```bash
sudo rsync -a certbot/conf/ /etc/letsencrypt/
sudo certbot certificates
```

If `certbot renew --dry-run` fails with a 404 while Docker Nginx is still
serving port 80, that is expected. Complete the host Nginx cutover first, then
run Certbot with the Nginx plugin.

### 6. Start the App Stack

Remove the old Docker Nginx and Docker Certbot containers, then start the app
stack. The production Compose file publishes only loopback ports for host Nginx.

```bash
docker rm -f vinci-clips-nginx-prod vinci-clips-certbot-prod 2>/dev/null || true
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build --remove-orphans
```

```bash
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

The host Nginx config proxies to the app containers through loopback ports:

```text
127.0.0.1:3000 -> frontend
127.0.0.1:8080 -> backend
```

### 7. Add HTTPS With Host Certbot

After the HTTP site works, let Certbot update the enabled Nginx site with the
443 server and certificate paths:

```bash
sudo certbot --nginx -d "$APP_DOMAIN"
```

Then verify renewal:

```bash
sudo certbot renew --dry-run
```

Host Certbot installs a system timer for automatic renewal. With
`python3-certbot-nginx`, Certbot can reload Nginx after successful renewals.

This will start:
- **Frontend + Backend**: published on `127.0.0.1` for host Nginx
- **Public HTTP/HTTPS**: ports 80 and 443 on host Nginx
- **Redis**: internal Docker network only, password-protected

### 8. Production Monitoring

```bash
# Check service status
docker compose --env-file .env.prod -f docker-compose.prod.yml ps

# View logs
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f

# Monitor resource usage
docker stats
```

### 9. Verify Production Deployment

```bash
curl http://$APP_DOMAIN/health
curl https://$APP_DOMAIN/health
curl https://$APP_DOMAIN/api/health
docker compose --env-file .env.prod -f docker-compose.prod.yml exec redis redis-cli -a "$REDIS_PASSWORD" ping
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

Open:

```text
https://yourdomain.com/upload
```

## Service Architecture

```
┌─────────────────┐
│     Nginx       │ :80, :443 (Production only)
│  Reverse Proxy  │
└─────────────────┘
         │
    ┌────┴────┐
    │         │
┌───▼──┐ ┌───▼──┐
│Frontend│ │Backend│ :3000, :8080
│Next.js │ │Express│
└───┬──┘ └───┬──┘
    │    ┌───▼────┐
    │    │ Redis  │ :6379 internal
    │    │ Cache  │
    │    └────────┘
    │
┌───▼────────────┐
│ External APIs  │
│ Gemini         │
└────────────────┘
```

## Troubleshooting

### Common Issues

**1. FFmpeg not found**
```bash
# Rebuild the backend container
docker compose build --no-cache backend
```

**2. Redis authentication failed**
```bash
# Check if Redis is running
docker compose ps redis

# Verify auth
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping
```

**3. Out of disk space**

Do **not** run `docker system prune -a` blindly. It wipes the entire build
cache, including the faster-whisper model download stage (~1.6GB) — the next
build then re-downloads the model and reruns every pip/npm step. Use a capped
prune instead, and let BuildKit garbage-collect automatically (see
[Image Size and Build Cache](#image-size-and-build-cache)).

```bash
# Inspect what build cache is consuming first
docker buildx du

# Trim cache to a 20GB cap (keeps recent layers incl. the model)
docker builder prune --keep-storage 20GB -f

# Remove dangling (untagged) images and stopped containers only
docker image prune -f
docker container prune -f

# Remove old volumes (data loss — only if you know they are orphaned)
docker volume prune
```

**4. YouTube import is blocked**
```bash
# Confirm yt-dlp can see the configured cookies file in the backend container
docker compose --env-file .env.prod -f docker-compose.prod.yml exec backend ls -l "$YTDLP_COOKIES_PATH"

# Follow backend logs while retrying the import
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f backend
```

If the app reports that YouTube blocked the import request, refresh the exported
cookies file and restart the backend container. The browser-facing error stays
generic; raw `yt-dlp` output is kept out of the client UI.

### Health Checks

Each service includes health checks that can be monitored:

```bash
# Check health status
docker-compose ps

# Manual health check
curl http://127.0.0.1:8080/health  # Backend
curl http://127.0.0.1:3000/api/health  # Frontend
curl http://$APP_DOMAIN/health  # Host Nginx
curl http://$APP_DOMAIN/api/health  # Backend through host Nginx
```

### Development vs Production

| Feature | Development | Production |
|---------|-------------|------------|
| **Nginx** | Not used | Reverse proxy + SSL |
| **Volumes** | Source code mounted | No source mounting |
| **Logging** | Console output | Structured JSON logs |
| **Health Checks** | Basic | Full monitoring |
| **Security** | Basic | Headers + rate limiting |
| **Ports** | Exposed directly | Proxied through Nginx |

## Image Size and Build Cache

### Build context and `.dockerignore`

Each image builds from its own subdirectory context — backend from `./backend`,
frontend from `./frontend` (see `build.context` in the compose files). Docker
**only reads a `.dockerignore` from the root of the build context**, so a single
file at the repo root does *not* apply to these builds. Each service therefore
has its own ignore file:

- `backend/.dockerignore`
- `frontend/.dockerignore`

These exclude `node_modules/`, `models/`, `uploads/`, `storage/`, `temp/`,
`cache/`, `logs/`, and secrets from the build context. Without them, `COPY . .`
bakes runtime data and the host-side faster-whisper model into the image — the
backend image balloons past 17GB and ships duplicate copies of the model.

A correctly-built backend image is roughly **3.5–4GB**: base (ffmpeg + python +
faster-whisper deps) + prod `node_modules` + the model copied once by the
dedicated `faster-whisper-model` build stage.

If you ever change what lives in `backend/` or `frontend/`, keep the ignore
files current so runtime data never leaks into an image.

### Cap the build cache automatically (recommended)

BuildKit's cache grows with every build and is never trimmed on its own — on a
small VPS it can reach 40–60GB in a few weeks. Instead of manually pruning (and
losing the model layer), let the daemon garbage-collect to a fixed budget.
Create or edit `/etc/docker/daemon.json`:

```json
{
  "builder": {
    "gc": {
      "enabled": true,
      "defaultKeepStorage": "20GB",
      "policy": [
        { "keepStorage": "20GB", "all": true }
      ]
    }
  }
}
```

```bash
sudo systemctl restart docker
```

BuildKit now self-trims to ~20GB, keeping the most recently used layers (model,
pip, npm) so rebuilds stay fast. You should no longer need scheduled
`docker system prune` runs.

### Rebuilding cleanly

After pulling the ignore-file changes, rebuild once without cache so the bloated
layers are dropped, then clear the old dangling image:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml build --no-cache backend frontend
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
docker image prune -f
```

## Maintenance

### Update Application

```bash
# Pull latest changes
git pull origin main

# Rebuild and restart services
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

### Scale Services

```bash
# Scale backend to 3 instances
docker-compose -f docker-compose.prod.yml up -d --scale backend=3
```

For more advanced deployment scenarios, consider using Docker Swarm or Kubernetes.
