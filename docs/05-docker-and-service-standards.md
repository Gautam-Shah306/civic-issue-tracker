# 05: Docker and Service Standards

> **Status:** Approved · **Last updated:** 2026-10-18
> Docker is worth **4 of 20 marks**. Every service is containerized to the standards below.

---

## 1. Repository layout

One **public GitHub monorepo**:

```
/services/<name>/    source, Dockerfile, tests
/contracts/          OpenAPI specs + event JSON Schemas
/infra/terraform/    provider-agnostic modules (see 07)
/deploy/k8s/         manifests and Helm chart (see 06)
/deploy/compose/     Docker Compose files
/docs/               these documents
/.github/workflows/  CI/CD (see 08)
/.github/scripts/    CI check scripts (see 08, 09)
/.githooks/          pre-commit secret-scan hook and setup script (see 09)
```

CI uses **path filters**, so a change in one service builds and tests only that service.

## 2. Dockerfile standards (every service)

| Rule | Detail |
|---|---|
| **Multi-stage builds** | Build tools stay in the builder stage; only the runtime artefact ships |
| **Small, pinned base images** | Distroless or slim variants with exact version tags, never `latest` |
| **Non-root user** | And a read-only root filesystem where possible |
| **No secrets in images** | No `.env` files or credentials baked in. Config comes from environment variables at runtime. A `.dockerignore` is mandatory |
| **One process per container** | Logging to stdout as structured JSON |
| **Standard endpoints** | `/healthz` (liveness) and `/readyz` (readiness) on every service |
| **Graceful shutdown** | Handle SIGTERM so rolling updates drop no requests |
| **Layer caching** | Copy and install dependency files before copying source |
| **Immutable tags** | Images tagged with the Git commit SHA (plus a SemVer tag on releases) |
| **Linted** | Dockerfiles pass Hadolint (see `09`) |

### Platforms
- **`linux/amd64`** is the target (GCP and AWS VMs are x86).
- Also build **`linux/arm64`** with buildx only if needed (an ARM laptop, or a fallback to Oracle's ARM VM).
- This **replaces the earlier ARM-only note**, which applied when Oracle Cloud was the planned host.

### Registry
**GitHub Container Registry (GHCR).** Free for public images, lives next to the code, and GitHub Actions can push with the built-in token. Packages are set to **public** so the cluster pulls without credentials. Google Artifact Registry is not used (small free storage allowance).

### Node services (D-036)
- **Base images:** multi-stage builds build on `node:24-bookworm-slim` and run on `gcr.io/distroless/nodejs24-debian13:nonroot`, both pinned by digest.
- **Runtime probes:** the distroless runtime container runs as non-root with no shell; health probes run via a `node` script.
- **Package installation:** `npm ci` in Docker and CI, governed by a committed per-service `.npmrc` (`min-release-age=7`, `ignore-scripts=true`, `save-exact=true`, `engine-strict=true`).
- **Build cache:** no cross-run build cache in CI yet (plain `docker build`), to be revisited if build times exceed about 5 minutes.
- **Root-context build convention (D-038):** builds use the repository root as context (`docker build -f services/<svc>/Dockerfile --build-arg SERVICE=<svc> .`) with an allow-list `Dockerfile.dockerignore` per service, so event schemas from `contracts/events/` and migrations are copied into the runtime image.

### Python services (D-044)
- **Base images:** multi-stage builds build on `python:3.13-slim-trixie` and run on `gcr.io/distroless/python3-debian13:nonroot`, both pinned by digest (fallback `python:3.13-slim-trixie` non-root if distroless fails; record if used).
- **Runtime probes:** distroless runtime container runs as non-root with no shell; health probes run via a lightweight `healthcheck.py` script (`python healthcheck.py`).
- **Package installation:** `uv sync --frozen --no-dev` into `/app/.venv`, with `PYTHONPATH` pointing to the virtualenv site-packages.
- **Root-context build convention:** builds use the repository root as context (`docker build -f services/<svc>/Dockerfile --build-arg SERVICE=<svc> .`) with an allow-list `Dockerfile.dockerignore` per service, so contracts and migrations are copied into the runtime image.

### Frontend
- **Base images:** multi-stage build using `node:24-bookworm-slim` (builder) and `nginxinc/nginx-unprivileged:alpine-slim` (runtime), both pinned by digest.
- **Security & runtime:** runs as non-root on port 8080, read-only root filesystem with tmpfs mounts (`/tmp`, `/var/cache/nginx`, `/var/run`), dropping all default privileges (`no-new-privileges: true`).
- **Static serving & SPA:** serves production bundle with SPA fallback (`try_files $uri $uri/ /index.html`), immutable caching for hashed assets, `no-store` for `index.html`, and health probe on `/healthz` returning 200.
- **Reverse proxy & security headers:** proxies `/api/` and `/.well-known/` to `${GATEWAY_URL}` with `client_max_body_size 9m`. Emits strict security headers: Content-Security-Policy (CSP), X-Content-Type-Options `nosniff`, Referrer-Policy `strict-origin-when-cross-origin`, Permissions-Policy `geolocation=(self)`, and X-Frame-Options `DENY`.
- **Root-context build convention:** built from repository root (`docker build -f services/frontend/Dockerfile --build-arg SERVICE=frontend .`) with allow-list `Dockerfile.dockerignore`.

## 3. Docker Compose and Kubernetes parity

One Compose setup runs all 8 services plus PostgreSQL, RabbitMQ, Redis, SeaweedFS and Mailpit with one command. It mirrors the Kubernetes setup so the move to k3s changes the packaging, not the application.

**Files and profiles (D-033):** the stack is `deploy/compose/docker-compose.yml` with a git-ignored `.env` generated by `init-env.ps1`. Infrastructure services have no profile and always start; application services are added under the `app` profile, so a plain `up` starts the infrastructure and `--profile app` starts everything.

| Compose | Kubernetes equivalent |
|---|---|
| Service name as hostname | Service DNS name |
| `env_file` / environment | ConfigMap and Secret |
| `healthcheck` | Liveness and readiness probes |
| `depends_on` with healthy condition | Readiness gates and init ordering |
| Named volumes | PersistentVolumeClaims |
| Compose network | Namespace plus NetworkPolicies |
| Override file for hot reload | Dev only |

## 4. Local development environment

- Development happens on a **local Windows machine** (Antigravity runs here).
- Repo hygiene for Windows: a `.gitattributes` forcing **LF line endings** (`* text=auto eol=lf`) so shell scripts and entrypoints work inside Linux containers.
- All Docker commands, Compose and the local k3s/kind cluster must work from this machine. Docker Desktop is installed and working (confirmed in Phase 0).

## 5. Rough resource estimate (to be measured, not trusted)

| Group | Approx. memory |
|---|---|
| Application containers (8 services, core ones at 2 replicas) | about 1.3 GB |
| Infrastructure (Postgres, RabbitMQ, SeaweedFS, Redis, monitoring, k3s, ingress, cert-manager) | about 2.5 to 3 GB |
| **Total** | **about 4 GB, inside an 8 GB VM** |

These are estimates. They are replaced by measured numbers in Phase 3 and Phase 4.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Local Kubernetes tool for rehearsals | Settled: none locally (D-051); kind runs in CI (D-053) |
| `linux/arm64` builds (only if needed) | Phase 3 or later |
