# Multi-stage Dockerfile for Civic Issue Tracker Python services (root context)
ARG SERVICE

# 1. UV binary stage
FROM ghcr.io/astral-sh/uv:0.13.4@sha256:9f130421e930bfbdc563c00740466603f8723158e90297d07957c2294640262b AS uv-bin

# 2. Builder stage
FROM python:3.13-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS builder
ARG SERVICE
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
FROM gcr.io/distroless/python3-debian13:nonroot@sha256:f47f5807043391605425f2bd162b25f50cebdc90640bacc804e0177608fe5c65 AS runtime
ARG SERVICE
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
