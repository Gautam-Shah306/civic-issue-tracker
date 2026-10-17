"""RFC 7807 problem+json error formatting and exception handling."""

import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.logging import correlation_id_ctx

PROBLEM_MEDIA_TYPE = "application/problem+json"


class AppError(Exception):
    """Base application domain error conforming to Problem Details."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        detail: str | None = None,
        errors: list[dict[str, str]] | None = None,
    ) -> None:
        """Initialize problem details error."""
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.detail = detail or message
        self.errors = errors


def create_problem_payload(
    status: int,
    code: str,
    title: str,
    correlation_id: str,
    detail: str | None = None,
    instance: str | None = None,
    errors: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Build payload matching contracts/openapi/problem.v1.schema.json."""
    payload: dict[str, Any] = {
        "type": f"https://civic.example.test/errors/{code}",
        "title": title,
        "status": status,
        "code": code,
        "correlationId": correlation_id,
    }
    if detail:
        payload["detail"] = detail
    if instance:
        payload["instance"] = instance
    if errors:
        payload["errors"] = errors
    return payload


def _get_cid() -> str:
    cid = correlation_id_ctx.get()
    if not cid:
        cid = str(uuid.uuid4())
        correlation_id_ctx.set(cid)
    return cid


def register_error_handlers(app: FastAPI) -> None:
    """Register RFC 7807 problem+json exception handlers on the application."""

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        cid = _get_cid()
        payload = create_problem_payload(
            status=exc.status_code,
            code=exc.code,
            title=exc.message,
            correlation_id=cid,
            detail=exc.detail,
            instance=request.url.path,
            errors=exc.errors,
        )
        return JSONResponse(
            status_code=exc.status_code, content=payload, media_type=PROBLEM_MEDIA_TYPE
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        cid = _get_cid()
        err_list: list[dict[str, str]] = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err.get("loc", []) if x != "body")
            err_list.append({"field": loc or "body", "message": err.get("msg", "Invalid value")})

        payload = create_problem_payload(
            status=400,
            code="validation_error",
            title="Request validation failed",
            correlation_id=cid,
            detail="One or more request parameters failed validation",
            instance=request.url.path,
            errors=err_list,
        )
        return JSONResponse(status_code=400, content=payload, media_type=PROBLEM_MEDIA_TYPE)

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        cid = _get_cid()
        code_map = {
            401: "unauthorized",
            403: "forbidden",
            404: "not_found",
            405: "method_not_allowed",
            409: "conflict",
        }
        code = code_map.get(exc.status_code, "http_error")
        payload = create_problem_payload(
            status=exc.status_code,
            code=code,
            title=str(exc.detail) if exc.detail else "HTTP error",
            correlation_id=cid,
            detail=str(exc.detail),
            instance=request.url.path,
        )
        return JSONResponse(
            status_code=exc.status_code, content=payload, media_type=PROBLEM_MEDIA_TYPE
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        cid = _get_cid()
        payload = create_problem_payload(
            status=500,
            code="internal_error",
            title="Internal Server Error",
            correlation_id=cid,
            detail="An unexpected error occurred",
            instance=request.url.path,
        )
        return JSONResponse(status_code=500, content=payload, media_type=PROBLEM_MEDIA_TYPE)
