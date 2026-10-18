# Frontend Service (`services/frontend`)

The Web Frontend application for the Civic Issue Tracker (NagrikSetu) platform.

## Responsibilities

- **Public Transparency:**
  - Interactive map view with bounding-box queries, category/status filters, and Bangalore BBMP ward boundaries.
  - Tabbed list view with pagination and sorting.
  - Public report detail view with timeline history, citizen photos, and coordinates.
- **Authentication & User Management:**
  - Citizen and staff login with JWT authentication (access and refresh token rotation).
  - Citizen self-registration with Problem Details client error mapping.
  - Role-based route guards (`citizen`, `officer`, `admin`).
- **Citizen Journey:**
  - 4-step report submission wizard (details, GPS geolocation pin, photo upload with asynchronous processing status polling, and idempotent review submission).
  - "My Reports" list with status badges and timeline tracking.
  - Reopen report confirmation flow for resolved reports.
- **Design System:**
  - Strict semantic design tokens (`src/styles/tokens.css`) mapped to Tailwind CSS 4 theme variables.
  - Accessible contrast ratios (WCAG AA compliant) with zero raw color literals.

## Architecture & Conventions

- Single Page Application built with React 19, TypeScript strict mode, Vite 8, React Router 7, and TanStack React Query 5.
- OpenStreetMap and Leaflet for interactive geospatial visualizations.
- Containerized via multi-stage Docker build using `nginxinc/nginx-unprivileged` running as non-root on port 8080.
- Reverse proxy configuration delegating `/api/` and `/.well-known/` calls to the Gateway service.
- Strict security headers including Content-Security-Policy (CSP), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Permissions-Policy`.

## Local Development & Testing

```bash
# Install dependencies
npm ci

# Run development server
npm run dev

# Run test suite with coverage
npm test -- --coverage

# Typecheck and lint
npm run typecheck
npm run lint
npm run format:check

# Production build
npm run build
```
