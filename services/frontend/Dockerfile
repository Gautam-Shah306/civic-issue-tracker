# Multi-stage Dockerfile for Civic Issue Tracker Frontend Service (root context)
ARG SERVICE=frontend

# 1. Build stage
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
ARG SERVICE=frontend
WORKDIR /app

# Copy dependency manifests and hardened config
COPY services/${SERVICE}/package*.json services/${SERVICE}/.npmrc ./
RUN npm ci

# Copy source code and build production assets
COPY services/${SERVICE}/tsconfig.json services/${SERVICE}/vite.config.ts services/${SERVICE}/index.html ./
COPY services/${SERVICE}/src/ ./src/
RUN npm run build

# 2. Runtime stage
FROM nginxinc/nginx-unprivileged:1.31.5-alpine-slim@sha256:736aa11ab9f9c320825722e411661c64559881e15e77f37137eef168ebe9515c AS runtime
ARG SERVICE=frontend

# Copy compiled static assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration directly into conf.d
COPY services/${SERVICE}/nginx.conf /etc/nginx/conf.d/default.conf

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["curl", "-fs", "http://127.0.0.1:8080/healthz"]

CMD ["nginx", "-g", "daemon off;"]
