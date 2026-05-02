# Environment Variables Setup Guide

This document clarifies the different environment files used in Vinci Clips and when to use each one.

## Overview

Vinci Clips uses different environment configurations depending on how you run the application:

```
vinci-clips/
├── .env.example              # For Docker Compose deployment (project root)
├── backend/.env.example      # For local backend development
└── ENVIRONMENT_SETUP.md      # This guide
```

## Environment File Locations

### 1. Project Root: `.env` (Docker Compose)

**Location**: `/vinci-clips/.env`
**Used by**: Docker Compose (`docker-compose.yml` and `docker-compose.prod.yml`)
**Purpose**: Configure containerized services

```bash
# Copy template and configure
cp .env.example .env
```

**Key characteristics**:
- Redis host points to Docker container: `redis`
- Redis requires `REDIS_PASSWORD`

### 2. Backend Folder: `backend/.env` (Local Development)

**Location**: `/vinci-clips/backend/.env`
**Used by**: Direct Node.js execution (`npm run dev`, `npm start`)
**Purpose**: Configure backend when running outside Docker

```bash
# Copy template and configure
cd backend
cp .env.example .env
```

**Key characteristics**:
- Redis host points to localhost: `localhost`

## Setup Instructions

### Option 1: Docker Development (Recommended)

1. **Configure project root environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

2. **Start with Docker Compose**:
   ```bash
   docker compose up --build
   ```

### Option 2: Local Development (Manual Setup)

1. **Set up local services**:
   ```bash
   # Install and start Redis (optional)
   brew install redis
   brew services start redis
   ```

2. **Configure backend environment**:
   ```bash
   cd backend
   cp .env.example .env
   # Edit backend/.env with your actual values
   ```

3. **Start services manually**:
   ```bash
   # Terminal 1: Start backend
   cd backend && npm run dev
   
   # Terminal 2: Start frontend
   cd frontend && npm run dev
   ```

## Environment Variables Reference

### Backend Configuration

| Variable | Docker Value | Local Value | Description |
|----------|--------------|-------------|-------------|
| `PORT` | `8080` | `8080` | Backend server port |
| `REDIS_HOST` | `redis` | `localhost` | Redis server host |
| `REDIS_PORT` | `6379` | `6379` | Redis server port |
| `REDIS_PASSWORD` | from `.env` | from `backend/.env` | Redis password |

### Required External Services

These values are the same for both Docker and local development:

| Variable | Description | How to get |
|----------|-------------|------------|
| `GEMINI_API_KEY` | Google Gemini API key | Get from Google AI Studio |

## Common Issues

### 1. Wrong Environment File Used

**Symptom**: "Connection refused" or "File not found" errors

**Solution**: Make sure you're using the right environment file:
- Docker: Use project root `.env`
- Local: Use `backend/.env`

### 2. Redis Connection Issues

**Symptom**: Redis authentication or connection errors

**Solutions**:
```bash
# Docker: Check if Redis container is running
docker compose ps redis

# Docker: Verify password auth
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" ping

# Local: Check if Redis is installed and running
brew services list | grep redis
```

## Verification

### Docker Deployment
```bash
# Check all services are running
docker compose ps

# Test backend connection
curl http://localhost:8080/health

# Test frontend connection
curl http://localhost:3000
```

### Local Development
```bash
# Test backend connection
curl http://localhost:8080/health

# Test frontend connection  
curl http://localhost:3000

# Test Redis connection
redis-cli -a "$REDIS_PASSWORD" ping
```

## Migration Guide

### From Local to Docker
1. Copy your `backend/.env` values to project root `.env`
2. Update Redis host to use the container name

### From Docker to Local
1. Copy your project root `.env` values to `backend/.env`
2. Update Redis host to use localhost
3. Install Redis locally

## Security Notes

- Never commit `.env` files to version control
- Use strong passwords for production Redis instances
- Rotate API keys regularly in production environments
