# Python Service Template (`services/_template-py`)

Canonical template for Python services in Civic Issue Tracker, establishing the standard toolchain decided in [D-044](../../docs/12-decision-log.md).

## Standards

- **Language Runtime:** Python 3.13 (`.python-version`)
- **Package Manager:** `uv` with committed `uv.lock` and `exclude-newer = "7 days"`
- **Framework:** FastAPI + Pydantic v2 + Uvicorn
- **Database:** PostgreSQL via `psycopg` 3 (`psycopg-pool`), plain SQL migrations
- **Messaging:** RabbitMQ via `aio-pika` with publisher confirms, transactional outbox
- **Authentication:** EdDSA JWT validation via `PyJWT[crypto]`
- **Linting & Formatting:** Ruff
- **Testing:** `pytest` + `testcontainers` with 60% coverage gate
- **Containerization:** Multi-stage Docker build with Distroless runtime (`gcr.io/distroless/python3-debian13:nonroot`)

## Quickstart

```powershell
# Sync virtualenv using uv
uv sync --frozen

# Lint and format checks
uv run ruff check .
uv run ruff format --check .

# Run test suite with coverage
uv run pytest --cov=app --cov-report=term-missing
```
