# Docker Compose Infrastructure

This directory contains the local infrastructure setup for the Civic Issue Tracker.

## Prerequisites
- Docker Desktop installed and running.
- PowerShell.

## Initialization
Before starting the stack for the first time, generate your local credentials from the repository root:
```powershell
./deploy/compose/init-env.ps1
```
This creates a `.env` file containing secure, random credentials from `.env.example`.

## Usage
Every command is run from the repository root.

To start the infrastructure in the background, wait for it to be ready:
```powershell
docker compose -f deploy/compose/docker-compose.yml up -d --wait --wait-timeout 300
```
*Note: The first start pulls images and can take several minutes.*

The stack includes a one-shot `db-init` provisioning service that runs automatically once Postgres is healthy. It idempotently provisions individual databases and roles (`civic_auth`, `civic_report`, `civic_notification`) with passwords from `.env`, restricts database connection access to only each service's own role, and installs required extensions (`postgis` in `civic_report`).

To stop the infrastructure:
```powershell
docker compose -f deploy/compose/docker-compose.yml down
```

### Application Services (Profile `app`)
To run the full application stack including microservices (starting with Auth service):
```powershell
docker compose -f deploy/compose/docker-compose.yml --profile app up -d --build --wait
```
This runs `auth-migrate` to execute database migrations, then starts `auth` on port 3001.

To stop the full application stack:
```powershell
docker compose -f deploy/compose/docker-compose.yml --profile app down
```

**WARNING:** To completely destroy the environment and wipe all data volumes, run:
```powershell
docker compose -f deploy/compose/docker-compose.yml down -v
```

## Ports
All services bind to `127.0.0.1` locally:
| Service | Port | Description |
|---|---|---|
| Postgres | 5432 | Database |
| RabbitMQ | 5672, 15672 | Message broker and management UI |
| Redis | 6379 | Cache and rate-limits |
| SeaweedFS | 8333 | S3 compatible storage |
| Mailpit | 1025, 8025 | SMTP and Web UI |
| Auth Service | 3001 | Auth & User API (`/api/v1/auth`, `/.well-known/jwks.json`) |
