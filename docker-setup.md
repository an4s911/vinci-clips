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

**Important**: This `.env` file in the project root is specifically for Docker Compose. For local development without Docker, see `ENVIRONMENT_SETUP.md`.

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

Use the HTTP-only nginx config locally. The HTTPS config expects real Let's Encrypt certificate files for `APP_DOMAIN`, so it is meant for the VPS after the first certificate has been issued.

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
```

### 2. Prepare Local Persistent Directories

```bash
mkdir -p backend/uploads backend/storage backend/temp backend/cache backend/logs certbot/conf certbot/www
```

### 3. Start Local Production Stack

```bash
NGINX_CONF=./nginx/nginx.http.conf docker compose --env-file .env.prod.local -f docker-compose.prod.yml up -d --build
```

### 4. Test Local Production Stack

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml ps
curl http://localhost/health
curl http://localhost/api/health
docker compose --env-file .env.prod.local -f docker-compose.prod.yml exec redis redis-cli -a localredispassword ping
```

Open:

```text
http://localhost/upload
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

Example:

```env
APP_DOMAIN=yourdomain.com
LETSENCRYPT_EMAIL=you@example.com
GEMINI_API_KEY=your_key
LLM_MODEL=gemini-2.5-flash
REDIS_PASSWORD=strong_random_password
NEXT_PUBLIC_API_URL=/api
CORS_ORIGIN=https://yourdomain.com
```

### 2. Prepare Persistent Directories

Run this once on the VPS from the project root:

```bash
mkdir -p backend/uploads backend/storage backend/temp backend/cache backend/logs certbot/conf certbot/www
sudo chown -R 1001:1001 backend/uploads backend/storage backend/temp backend/cache backend/logs
```

### 3. First Boot With HTTP-Only Nginx

Start the stack with the HTTP config so Let's Encrypt can validate the domain:

```bash
NGINX_CONF=./nginx/nginx.http.conf docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

### 4. Issue the First Certificate

DNS for `APP_DOMAIN` must already point to the VPS before this command runs.

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm --entrypoint certbot certbot \
  certonly --webroot \
  -w /var/www/certbot \
  -d "$APP_DOMAIN" \
  --email "$LETSENCRYPT_EMAIL" \
  --agree-tos \
  --no-eff-email
```

### 5. Switch to HTTPS Nginx

```bash
NGINX_CONF=./nginx/nginx.https.conf docker compose --env-file .env.prod -f docker-compose.prod.yml up -d nginx
```

The `certbot` service runs an automatic renewal loop. The `nginx` service reloads periodically so renewed certificates are picked up without mounting the Docker socket.

### 6. Test Renewal

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm --entrypoint certbot certbot renew --dry-run
```

This will start:
- **Frontend + Backend**: proxied internally through Nginx
- **Public HTTP/HTTPS**: ports 80 and 443 on the Nginx container only
- **Redis**: internal Docker network only, password-protected

### 7. Production Monitoring

```bash
# Check service status
docker compose --env-file .env.prod -f docker-compose.prod.yml ps

# View logs
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f

# Monitor resource usage
docker stats
```

### 8. Verify Production Deployment

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
```bash
# Clean up unused Docker resources
docker system prune -a

# Remove old volumes
docker volume prune
```

### Health Checks

Each service includes health checks that can be monitored:

```bash
# Check health status
docker-compose ps

# Manual health check
curl http://localhost:8080/health  # Backend
curl http://localhost:3000/api/health  # Frontend
curl http://localhost/health  # Nginx
curl http://localhost/api/health  # Backend through Nginx
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
