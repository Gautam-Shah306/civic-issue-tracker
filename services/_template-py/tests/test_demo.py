"""Demo and core middleware tests for template service."""

import uuid

import pytest
from httpx import AsyncClient

from tests.conftest import generate_token


@pytest.mark.asyncio
async def test_healthz_endpoint(async_client: AsyncClient) -> None:
    response = await async_client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_readyz_endpoint(async_client: AsyncClient) -> None:
    response = await async_client.get("/readyz")
    assert response.status_code in (200, 503)
    data = response.json()
    assert "status" in data
    assert "details" in data


@pytest.mark.asyncio
async def test_demo_public_route(async_client: AsyncClient) -> None:
    response = await async_client.get("/api/v1/demo")
    assert response.status_code == 200
    assert "message" in response.json()


@pytest.mark.asyncio
async def test_demo_protected_unauthorized(async_client: AsyncClient) -> None:
    # No header
    res1 = await async_client.get("/api/v1/demo/protected")
    assert res1.status_code == 401
    assert res1.json()["code"] == "unauthorized"

    # Malformed header
    res2 = await async_client.get(
        "/api/v1/demo/protected", headers={"Authorization": "Basic 12345"}
    )
    assert res2.status_code == 401

    # Bad token
    res3 = await async_client.get(
        "/api/v1/demo/protected", headers={"Authorization": "Bearer bad.jwt.token"}
    )
    assert res3.status_code == 401


@pytest.mark.asyncio
async def test_demo_protected_forbidden(async_client: AsyncClient) -> None:
    citizen_token = generate_token("user-citizen-1", role="citizen")
    response = await async_client.get(
        "/api/v1/demo/protected",
        headers={"Authorization": f"Bearer {citizen_token}"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "forbidden"


@pytest.mark.asyncio
async def test_demo_protected_allowed(async_client: AsyncClient) -> None:
    officer_token = generate_token("user-officer-1", role="officer")
    res1 = await async_client.get(
        "/api/v1/demo/protected",
        headers={"Authorization": f"Bearer {officer_token}"},
    )
    assert res1.status_code == 200
    assert res1.json()["role"] == "officer"

    admin_token = generate_token("user-admin-1", role="admin")
    res2 = await async_client.get(
        "/api/v1/demo/protected",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert res2.status_code == 200
    assert res2.json()["role"] == "admin"


@pytest.mark.asyncio
async def test_correlation_id_middleware(async_client: AsyncClient) -> None:
    custom_cid = str(uuid.uuid4())
    res1 = await async_client.get("/healthz", headers={"x-correlation-id": custom_cid})
    assert res1.status_code == 200
    assert res1.headers.get("x-correlation-id") == custom_cid

    # Auto-generate when missing
    res2 = await async_client.get("/healthz")
    assert res2.status_code == 200
    generated_cid = res2.headers.get("x-correlation-id")
    assert generated_cid is not None
    assert uuid.UUID(generated_cid)
