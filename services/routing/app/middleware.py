"""HTTP request correlation ID middleware."""

import uuid
from collections.abc import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.logging import correlation_id_ctx


def is_valid_uuid(val: str) -> bool:
    """Validate string as RFC 4122 UUID."""
    try:
        parsed = uuid.UUID(val)
        return str(parsed) == val.lower()
    except (ValueError, AttributeError):
        return False


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Ensure every HTTP request has an RFC 4122 correlation ID propagated in headers and logs."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Response]
    ) -> Response:
        """Process incoming request and inject correlation ID."""
        raw_cid = request.headers.get("x-correlation-id")
        if raw_cid and is_valid_uuid(raw_cid.strip()):
            cid = raw_cid.strip().lower()
        else:
            cid = str(uuid.uuid4())

        token = correlation_id_ctx.set(cid)
        try:
            response = await call_next(request)
            response.headers["x-correlation-id"] = cid
            return response
        finally:
            correlation_id_ctx.reset(token)
