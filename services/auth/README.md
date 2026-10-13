# Auth Service (`services/auth`)

The Auth & User service for the Civic Issue Tracker platform.

## Responsibilities

- **User Registration & Profile:** Citizen registration with role assignment (`citizen`, `officer`, `admin`).
- **Authentication:** Password authentication using `argon2id` (PHC format).
- **Token Management:**
  - Short-lived asymmetric access tokens (15-minute TTL) signed with EdDSA (Ed25519) via `jose`.
  - Public JWKS endpoint at `/.well-known/jwks.json`.
  - Opaque refresh tokens (7-day TTL) stored exclusively as SHA-256 hashes, with automatic rotation and token family reuse detection.
- **Transactional Outbox:** Publishes `user.created` domain events to RabbitMQ exchange `civic.events`.
- **Database Migrations:** Plain-SQL migration runner with PostgreSQL advisory locking and SHA-256 checksum verification.

## Architecture & Conventions

- Fastify application with TypeScript strict ESM.
- Validation via Zod schemas and RFC 9457 Problem Details for all error responses.
- Structured JSON logging with Pino, strictly redacting passwords, authorization headers, and tokens.
- Health endpoints:
  - `/healthz`: Liveness probe (HTTP server status).
  - `/readyz`: Readiness probe (validates PostgreSQL connectivity and RabbitMQ status).

## Local Development & Testing

```bash
# Install dependencies
npm ci

# Run database migrations
npm run migrate

# Run test suite with coverage
npm test -- --coverage

# Typecheck and lint
npm run typecheck
npm run lint
npm run format:check
```
