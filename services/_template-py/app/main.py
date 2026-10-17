"""FastAPI application entrypoint for template service."""

from typing import Any

from fastapi import Depends, FastAPI, Response, status

from app.auth import UserClaims, require_role
from app.errors import register_error_handlers
from app.lifecycle import lifecycle, lifespan
from app.middleware import CorrelationIdMiddleware

app = FastAPI(
    title="Civic Template Service",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url="/api/v1/openapi.json",
)

# Middleware
app.add_middleware(CorrelationIdMiddleware)

# Error handlers
register_error_handlers(app)


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


@app.get("/api/v1/demo", tags=["Demo"])
async def demo_public() -> dict[str, str]:
    """Public demo endpoint verifying template functionality."""
    return {"message": "Hello from Python template service!"}


@app.get("/api/v1/demo/protected", tags=["Demo"])
async def demo_protected(
    user: UserClaims = Depends(require_role("officer", "admin")),
) -> dict[str, Any]:
    """Protected demo endpoint requiring officer or admin role."""
    return {"message": "Access granted to protected resource", "userId": user.id, "role": user.role}
