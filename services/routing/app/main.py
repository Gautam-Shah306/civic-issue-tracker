"""FastAPI application entrypoint for Routing service."""

from typing import Any

from fastapi import FastAPI, Response, status

from app.errors import register_error_handlers
from app.lifecycle import lifecycle, lifespan
from app.middleware import CorrelationIdMiddleware
from app.routes import assignments, categories, departments, wards

app = FastAPI(
    title="Civic Issue Tracker Routing Service",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url="/api/v1/routing/openapi.json",
)

# Middleware
app.add_middleware(CorrelationIdMiddleware)

# Error handlers
register_error_handlers(app)

# Include Domain Routers under /api/v1/routing
app.include_router(wards.router, prefix="/api/v1/routing")
app.include_router(departments.router, prefix="/api/v1/routing")
app.include_router(categories.router, prefix="/api/v1/routing")
app.include_router(assignments.router, prefix="/api/v1/routing")


@app.get("/healthz", status_code=status.HTTP_200_OK, tags=["System"])
async def healthz() -> dict[str, str]:
    """Liveness probe: returns 200 OK as soon as the HTTP server is serving traffic."""
    return {"status": "ok"}


@app.get("/readyz", tags=["System"])
async def readyz(response: Response) -> dict[str, Any]:
    """Readiness probe: returns 200 only when DB and AMQP are fully connected."""
    ready, details = await lifecycle.is_ready()
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "not ready", "details": details}
    return {"status": "ready", "details": details}
