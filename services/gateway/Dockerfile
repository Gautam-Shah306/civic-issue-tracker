# Multi-stage Dockerfile for Civic Issue Tracker Gateway Service (root context)
ARG SERVICE=gateway

# 1. Build stage
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
ARG SERVICE=gateway
WORKDIR /app

# Copy dependency manifests and hardened config
COPY services/${SERVICE}/package*.json services/${SERVICE}/.npmrc ./
RUN npm ci

# Copy source code and build
COPY services/${SERVICE}/tsconfig.json ./
COPY services/${SERVICE}/src/ ./src/
RUN npm run build

# Prune devDependencies for runtime
RUN npm prune --omit=dev

# 2. Runtime stage
# Note: The distroless runtime has no shell and no package manager (no RUN commands).
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS runtime
ARG SERVICE=gateway
WORKDIR /app

# Copy compiled JavaScript output and production node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

USER nonroot
EXPOSE 3000

# Built-in health probe via Node.js script (since runtime has no shell)
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "dist/healthcheck.js"]

ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/main.js"]
