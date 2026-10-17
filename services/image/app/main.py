"""FastAPI application entrypoint for Image service."""

from typing import Any

from fastapi import FastAPI, Response, status

from app.errors import register_error_handlers
from app.lifecycle import lifecycle, lifespan
from app.middleware import CorrelationIdMiddleware
from app.routes import images

app = FastAPI(
    title="Civic Issue Tracker Image Service",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url="/api/v1/images/openapi.json",
)

# Middleware
app.add_middleware(CorrelationIdMiddleware)

# Error handlers
register_error_handlers(app)

# Include Images Router
app.include_router(images.router)


@app.get("/healthz", status_code=status.HTTP_200_OK, tags=["System"])
async def healthz() -> dict[str, str]:
    """Liveness probe: returns 200 OK as soon as the HTTP server is serving traffic."""
    return {"status": "ok"}


@app.get("/readyz", tags=["System"])
async def readyz(response: Response) -> dict[str, Any]:
    """Readiness probe: returns 200 only when DB, AMQP, and S3 are fully connected."""
    ready, details = await lifecycle.is_ready()
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "not ready", "details": details}
    return {"status": "ready", "details": details}
