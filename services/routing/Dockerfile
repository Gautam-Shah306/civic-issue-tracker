# Multi-stage Dockerfile for Civic Issue Tracker Python services (root context)
ARG SERVICE=routing

# 1. UV binary stage
FROM ghcr.io/astral-sh/uv:0.12.21@sha256:a7aed3216253ee804de3e2d8afa5073baa1a177335345d43845cd4165e43b711 AS uv-bin

# 2. Builder stage
FROM python:3.14-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS builder
ARG SERVICE=routing
WORKDIR /app

COPY --from=uv-bin /uv /bin/uv

# Copy dependency manifests
COPY services/${SERVICE}/pyproject.toml services/${SERVICE}/uv.lock ./

# Install production dependencies only into /app/.venv
RUN uv sync --frozen --no-dev --no-install-project

# Copy application source code and contracts
COPY services/${SERVICE}/app ./app
COPY services/${SERVICE}/migrations ./migrations
COPY services/${SERVICE}/healthcheck.py ./healthcheck.py
COPY contracts/events/*.schema.json ./contracts/events/

# 3. Runtime stage (Distroless nonroot)
FROM gcr.io/distroless/python3-debian13:nonroot@sha256:83aa8d4f74a4d7f7cf2d472054139bef71a927b76c680c0f2e1021d6b1d6d732 AS runtime
ARG SERVICE=routing
WORKDIR /app

# Copy virtualenv site-packages and app files from builder
COPY --from=builder /app/.venv/lib/python3.13/site-packages /app/.venv/lib/python3.13/site-packages
COPY --from=builder /app/app ./app
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/healthcheck.py ./healthcheck.py
COPY --from=builder /app/contracts ./contracts

ENV PYTHONPATH="/app/.venv/lib/python3.13/site-packages:/app"
ENV PYTHONUNBUFFERED="1"

USER nonroot
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/bin/python3.13", "healthcheck.py"]

ENTRYPOINT ["/usr/bin/python3.13"]
CMD ["-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
