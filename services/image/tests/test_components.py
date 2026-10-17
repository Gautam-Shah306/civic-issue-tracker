import logging
import uuid

import jsonschema
import pytest

from app.errors import create_problem_payload
from app.events.validator import EventValidator
from app.logging import JsonFormatter, correlation_id_ctx
from app.migrate import compute_sha256


def test_compute_sha256() -> None:
    digest = compute_sha256("SELECT 1;")
    assert len(digest) == 64
    assert digest == compute_sha256("SELECT 1;")


def test_json_formatter() -> None:
    formatter = JsonFormatter("test-service")
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname="test.py",
        lineno=10,
        msg="Sample log message",
        args=(),
        exc_info=None,
    )
    token = correlation_id_ctx.set("11111111-2222-3333-4444-555555555555")
    try:
        output = formatter.format(record)
        assert '"service": "test-service"' in output
        assert '"level": "info"' in output
        assert '"message": "Sample log message"' in output
        assert '"correlationId": "11111111-2222-3333-4444-555555555555"' in output
    finally:
        correlation_id_ctx.reset(token)


def test_create_problem_payload() -> None:
    cid = str(uuid.uuid4())
    payload = create_problem_payload(
        status=404,
        code="not_found",
        title="Item not found",
        correlation_id=cid,
        detail="The item does not exist",
        instance="/api/v1/items/123",
        errors=[{"field": "id", "message": "Does not exist"}],
    )
    assert payload["status"] == 404
    assert payload["code"] == "not_found"
    assert payload["title"] == "Item not found"
    assert payload["correlationId"] == cid
    assert payload["detail"] == "The item does not exist"
    assert payload["instance"] == "/api/v1/items/123"
    assert len(payload["errors"]) == 1


def test_event_validator_contracts() -> None:
    validator = EventValidator()
    cid = str(uuid.uuid4())
    eid = str(uuid.uuid4())

    valid_assigned = {
        "eventId": eid,
        "eventType": "report.assigned",
        "version": 1,
        "occurredAt": "2026-10-14T10:00:00.000Z",
        "correlationId": cid,
        "payload": {
            "reportId": str(uuid.uuid4()),
            "wardCode": "W-R1C1",
            "departmentCode": "roads",
            "departmentName": "Roads & Infrastructure",
            "departmentEmail": "roads@civic.example.test",
            "source": "auto",
            "assignedAt": "2026-10-14T10:00:00.000Z",
        },
    }

    # Should pass without error
    validator.validate_event("report.assigned", 1, valid_assigned)

    # Invalid payload should raise
    invalid_assigned = dict(valid_assigned)
    invalid_assigned["payload"] = {"reportId": "invalid-uuid"}
    with pytest.raises(jsonschema.ValidationError):
        validator.validate_event("report.assigned", 1, invalid_assigned)


@pytest.mark.asyncio
async def test_auth_edge_cases() -> None:
    from app.auth import JwtVerifier, require_role
    from app.config import get_settings
    from app.errors import AppError

    settings = get_settings()
    verifier = JwtVerifier(settings)

    # 1. Invalid token string
    with pytest.raises(AppError) as exc_info:
        verifier.verify_token("not-a-token")
    assert exc_info.value.status_code == 401

    # 2. None token
    with pytest.raises(AppError) as exc_info:
        verifier.verify_token(None)
    assert exc_info.value.status_code == 401

    # 3. require_role returns callable that checks claims
    checker = require_role("admin")
    from app.auth import UserClaims

    admin_claims = UserClaims(id="u1", role="admin")
    assert checker(admin_claims) == admin_claims

    citizen_claims = UserClaims(id="u2", role="citizen")
    with pytest.raises(AppError) as exc_info:
        checker(citizen_claims)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_error_handlers() -> None:
    from fastapi import FastAPI
    from starlette.exceptions import HTTPException as StarletteHTTPException
    from starlette.requests import Request

    from app.errors import AppError, register_error_handlers

    dummy = FastAPI()
    register_error_handlers(dummy)

    # Directly invoke handlers with a mock request
    scope = {"type": "http", "method": "GET", "path": "/test", "headers": []}
    req = Request(scope)

    app_err_handler = dummy.exception_handlers[AppError]
    res1 = await app_err_handler(req, AppError(status_code=400, code="bad_req", message="bad"))
    assert res1.status_code == 400

    http_err_handler = dummy.exception_handlers[StarletteHTTPException]
    res2 = await http_err_handler(req, StarletteHTTPException(status_code=404, detail="not found"))
    assert res2.status_code == 404

    unhandled_handler = dummy.exception_handlers[Exception]
    res3 = await unhandled_handler(req, RuntimeError("boom"))
    assert res3.status_code == 500


@pytest.mark.asyncio
async def test_outbox_relay_helpers() -> None:
    from app.events.outbox import OutboxRelay

    # Unconnected outbox relay returns false / 0
    relay = OutboxRelay(pool=None, rabbitmq_url="amqp://guest:guest@localhost:5672/")  # type: ignore[arg-type]
    assert not await relay.is_connected()
    assert await relay.process_batch() == 0


@pytest.mark.asyncio
async def test_lifecycle_and_db_health() -> None:
    from app.db import check_db_health
    from app.lifecycle import ServiceLifecycle

    # Pool is None -> health is False
    assert not await check_db_health(None)

    lc = ServiceLifecycle()
    ready, details = await lc.is_ready()
    assert not ready
    assert "database" in details
    assert "rabbitmq" in details
