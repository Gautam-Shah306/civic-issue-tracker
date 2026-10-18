# 04: Tech Stack and Data Stores

> **Status:** Approved · **Last updated:** 2026-10-18
> **Guiding rules:** free-tier first, as few moving parts as possible, polyglot by design (two languages).

---

## 1. Languages and frameworks per service

| Service | Language and framework | Why |
|---|---|---|
| API Gateway | **Node.js + TypeScript** (Fastify) | Light, fast, small custom gateway |
| Auth & User | **Node.js + TypeScript** (Fastify) | Mature JWT and argon2 libraries |
| Report | **Node.js + TypeScript** (Fastify) | Core logic: state machine and outbox; typing helps |
| Notification | **Node.js + TypeScript** | Event-consumer worker with simple email sending |
| Analytics & Audit | **Node.js + TypeScript** | Event consumer plus a read API |
| Image | **Python** (FastAPI + Pillow) | Best image-processing libraries; CPU-bound work |
| Routing & Assignment | **Python** (FastAPI) | Strong geospatial ecosystem; PostGIS does point-in-polygon |
| Frontend | **React + Vite + TypeScript**, Tailwind CSS, served by **NGINX** | One responsive app for all roles; static files only |

**Decision history:** Go was considered for Gateway and Analytics and **removed** (see `12`). The backend uses exactly two languages: Node.js/TypeScript and Python. Java is avoided because of JVM memory use.

### Supporting libraries and tools

| Concern | Choice |
|---|---|
| Node validation | **Zod** schemas |
| Node data access | **Drizzle ORM** with plain SQL migrations (handles PostGIS better than Prisma) |
| Maps | **Leaflet + OpenStreetMap tiles** (Google Maps is avoided: billing) |
| Geocoding | **Nominatim (OpenStreetMap)**, rate-limited, so results are cached |
| Password hashing | **argon2** |
| Node tests | **Vitest** (unit), **Supertest** (API), **Testcontainers** (real Postgres in tests) |
| Logging | **pino** structured JSON (Node); equivalent structured JSON logging in Python |
| API docs | **OpenAPI/Swagger** generated from route schemas |
| Metrics and dashboards | **Prometheus + Grafana**, self-hosted with short retention |

## 2. Shared code: contracts, not code

Python and Node services cannot share code, so services share **contracts**:

- `/contracts` holds **OpenAPI specs** (REST) and **JSON Schemas** (events).
- Each service validates against them, and **CI fails if a service drifts from its contract** (see `08`).

## 3. Data stores

| Service | Store | Notes |
|---|---|---|
| Auth & User | **PostgreSQL** | Users, hashed credentials, roles |
| Report | **PostgreSQL + PostGIS** | Reports, history, comments, upvotes, outbox. PostGIS powers the duplicate check ("same category within N metres") |
| Routing & Assignment | **PostgreSQL + PostGIS** | Ward boundaries as polygons; ward lookup is a point-in-polygon query |
| Image | **PostgreSQL** (metadata) + **object storage** (files) | Files never go in the database |
| Notification | **PostgreSQL** | Notifications |
| Analytics & Audit | **PostgreSQL** | Read models and an audit table where the service's database user has **INSERT only** (no UPDATE or DELETE), enforcing append-only |
| Gateway and caching | **Redis** | Rate-limit counters and hot-read caching |

### Database per service, within free limits
- **One PostgreSQL instance** with a **separate logical database and a separate user per service**. No service can read another's data.
- Cost: the shared instance is a single point of failure. Accepted at this scale. Each database can move to its own server later with no code change.
- Because all services share one Postgres pod, network policies cannot separate them there. Isolation relies on the separate database users and passwords.

## 4. Message broker: RabbitMQ (approved)

Chosen because acknowledgements, retries and dead-letter queues are built in, so the reliability requirements (DAT-03, DAT-04) are configuration, not custom code. Redis is used for caching and rate limiting only.

## 5. Other building blocks

| Concern | Choice |
|---|---|
| API Gateway | Small custom Fastify gateway (JWT check, rate limit, correlation ID) behind the Kubernetes Ingress |
| Authentication | **JWT signed with an asymmetric key pair.** Auth signs; every other service verifies with the public key only. Short-lived access token plus refresh token |
| **Object storage** | **SeaweedFS** (S3-compatible, self-hosted). **Replaced MinIO** (see below) |
| Email | **Mailpit** for development; a free-tier email service for the live demo (chosen in Phase 5) |
| Version control | **Git**, hosted on **GitHub** (public monorepo) |

### Why SeaweedFS replaced MinIO (verified 2026-10-09)
MinIO stopped publishing binaries and Docker images in October 2025, went into maintenance mode in December 2025, and was archived by its owner on April 25, 2026. Building it from source would add work and security risk. Services talk to storage through the standard **S3 API**, so the swap affects configuration only. Alternatives considered: **Garage** (very light, needs a one-time layout step) and **RustFS** (newer, more maturity risk). Idle resource use was measured locally on 2026-10-10 (about 63 MiB, see D-033); behaviour under load is re-measured in Phase 4.

## 6. Node service conventions (D-036)

- **Runtime:** Node 24 LTS; Node 26 revisited after it enters LTS.
- **Package layout:** Independent per-service npm packages with their own lockfile, no workspaces; `services/_template/` is the copy source.
- **Package manager hardening:** npm only, hardened by a committed per-service `.npmrc` enforcing a release cooldown, disabled install scripts, exact version pinning, and strict engine checks; `npm ci` in CI and Docker.
- **Language and build:** TypeScript strict mode, ESM, compiled via `tsc` to `dist/`.
- **Linting, formatting and testing:** ESLint (flat config with typescript-eslint), Prettier, Vitest, Supertest, Testcontainers, and a 60% coverage gate on core logic.
- **Libraries:** Fastify, Zod with `fastify-type-provider-zod` and `@fastify/swagger`, pino, `pg`, Drizzle ORM with plain SQL migrations, and `rabbitmq-client` (`amqplib` fallback).
- **Auth service (D-038):**
  - **Access tokens:** EdDSA (Ed25519) asymmetric JWTs via `jose`, short-lived (15 minutes), verified across services via public JWKS.
  - **Refresh tokens:** Opaque 32-byte random tokens stored only as SHA-256 hashes, 7-day TTL, rotated on each refresh, with token-family reuse detection revoking the family.
  - **Password hashing:** argon2id with config-driven parameters (default 19456 KiB, 2 iterations, parallelism 1) in PHC string format; policy enforces 10–128 characters and distinct from email.
  - **Migrations & ORM:** Plain-SQL migrations applied by `node dist/migrate.js` with advisory lock and checksums; Drizzle ORM for queries.
- **Python service conventions (D-044):**
  - **Runtime & toolchain:** Python 3.13; uv with committed `uv.lock` (hash-pinned) and `[tool.uv] exclude-newer = "7 days"`, exact `==` pins in `pyproject.toml`, `uv sync --frozen`; `services/_template-py/` is the copy source.
  - **Web framework:** FastAPI + Pydantic v2 + Uvicorn with structured JSON logging (`correlation_id` contextvar).
  - **Database access & migrations:** psycopg 3 with connection pool (`psycopg_pool`), NO ORM; plain-SQL migrations via `python -m app.migrate` enforcing advisory lock, checksum validation, and `schema_migrations` tracking matching Node runner semantics.
  - **Messaging & security:** aio-pika with publisher confirms; PyJWT[crypto] with EdDSA only; jsonschema for event contract validation.
  - **Linting, formatting & testing:** Ruff (lint and format), pytest, pytest-cov with a 60% coverage gate, Testcontainers.
- **Frontend conventions (D-048 and the design system decision D-049):**
  - **Stack:** React 19 + TypeScript 6 + Vite + React Router + TanStack Query + Tailwind CSS 4 + Leaflet (react-leaflet).
  - **Design tokens:** Single source of truth in `src/styles/tokens.css` with Tailwind 4 `@theme` block resetting defaults; 4 px base spacing, fixed typography scale with system sans-serif stack, control heights (32, 40, 48 px), semantic status colours only (no dark mode or theme switch).
  - **Map & tiles:** OpenStreetMap tiles with attribution; coordinates stored to 4 decimal places with optional free-text address.
  - **Component approach:** Custom accessible components consuming predefined design tokens; no third-party UI kits or heavy component libraries.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Free-tier email service for the live demo | Phase 5 |
| Re-measure SeaweedFS memory under load (idle about 63 MiB, D-033; Garage stays the fallback) | Phase 4 |
