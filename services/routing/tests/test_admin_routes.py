"""API route authorization and lifecycle integration tests for routing service."""

import json
import uuid

import pytest
from httpx import AsyncClient

from app.config import Settings
from app.db import get_global_pool
from app.events.validator import get_event_validator
from tests.conftest import generate_token


@pytest.mark.asyncio
async def test_public_routes_unauthenticated(async_client: AsyncClient) -> None:
    # GET /api/v1/routing/wards returns 200 GeoJSON
    res_wards = await async_client.get("/api/v1/routing/wards")
    assert res_wards.status_code == 200
    wards_data = res_wards.json()
    assert wards_data["type"] == "FeatureCollection"
    assert len(wards_data["features"]) >= 25

    # GET /api/v1/routing/departments returns 200
    res_depts = await async_client.get("/api/v1/routing/departments")
    assert res_depts.status_code == 200
    depts_data = res_depts.json()
    assert len(depts_data) >= 4
    assert any(d["code"] == "roads" for d in depts_data)

    # GET /api/v1/routing/categories returns 200
    res_cats = await async_client.get("/api/v1/routing/categories")
    assert res_cats.status_code == 200
    cats_data = res_cats.json()
    assert len(cats_data) >= 4
    assert any(c["slug"] == "pothole" for c in cats_data)


@pytest.mark.asyncio
async def test_jwt_authentication_edge_cases(async_client: AsyncClient) -> None:
    report_id = str(uuid.uuid4())

    # 1. Missing Authorization header -> 401
    res = await async_client.get(f"/api/v1/routing/reports/{report_id}")
    assert res.status_code == 401

    # 2. Malformed Authorization header -> 401
    res = await async_client.get(
        f"/api/v1/routing/reports/{report_id}",
        headers={"Authorization": "Basic 12345"},
    )
    assert res.status_code == 401

    # 3. Invalid JWT signature -> 401
    res = await async_client.get(
        f"/api/v1/routing/reports/{report_id}",
        headers={"Authorization": "Bearer not.a.valid.jwt"},
    )
    assert res.status_code == 401

    # 4. Expired token -> 401
    expired_token = generate_token(str(uuid.uuid4()), role="officer", exp_offset=-3600)
    res = await async_client.get(
        f"/api/v1/routing/reports/{report_id}",
        headers={"Authorization": f"Bearer {expired_token}"},
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_role_based_access_control(async_client: AsyncClient) -> None:
    citizen_token = generate_token(str(uuid.uuid4()), role="citizen")
    officer_token = generate_token(str(uuid.uuid4()), role="officer")
    report_id = str(uuid.uuid4())

    citizen_headers = {"Authorization": f"Bearer {citizen_token}"}
    officer_headers = {"Authorization": f"Bearer {officer_token}"}

    # Citizen cannot access officer GET /reports/{id}
    res = await async_client.get(f"/api/v1/routing/reports/{report_id}", headers=citizen_headers)
    assert res.status_code == 403

    # Citizen cannot access write endpoints -> 403
    res = await async_client.patch(
        "/api/v1/routing/wards/W-R1C1",
        json={"name": "New Name"},
        headers=citizen_headers,
    )
    assert res.status_code == 403

    res = await async_client.post(
        "/api/v1/routing/departments",
        json={"code": "parks", "name": "Parks", "email": "parks@civic.test"},
        headers=citizen_headers,
    )
    assert res.status_code == 403

    res = await async_client.post(
        "/api/v1/routing/categories",
        json={"slug": "graffiti", "name": "Graffiti", "departmentCode": "sanitation"},
        headers=citizen_headers,
    )
    assert res.status_code == 403

    res = await async_client.post(
        f"/api/v1/routing/reports/{report_id}/reassign",
        json={"departmentCode": "roads"},
        headers=citizen_headers,
    )
    assert res.status_code == 403

    # Officer can access GET /reports/{id} (returns 404 since report not assigned, but authenticated & authorized)
    res = await async_client.get(f"/api/v1/routing/reports/{report_id}", headers=officer_headers)
    assert res.status_code == 404

    # Officer cannot access admin write endpoints -> 403
    res = await async_client.patch(
        "/api/v1/routing/wards/W-R1C1",
        json={"name": "New Name"},
        headers=officer_headers,
    )
    assert res.status_code == 403

    res = await async_client.post(
        "/api/v1/routing/departments",
        json={"code": "parks", "name": "Parks", "email": "parks@civic.test"},
        headers=officer_headers,
    )
    assert res.status_code == 403

    res = await async_client.post(
        "/api/v1/routing/categories",
        json={"slug": "graffiti", "name": "Graffiti", "departmentCode": "sanitation"},
        headers=officer_headers,
    )
    assert res.status_code == 403

    res = await async_client.post(
        f"/api/v1/routing/reports/{report_id}/reassign",
        json={"departmentCode": "roads"},
        headers=officer_headers,
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_admin_category_management_emits_outbox_event(
    async_client: AsyncClient, test_settings: Settings
) -> None:
    admin_token = generate_token(str(uuid.uuid4()), role="admin")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    validator = get_event_validator()
    pool = get_global_pool()

    slug = f"trees-{uuid.uuid4().hex[:6]}"
    # 1. Admin creates category -> 201 Created
    create_res = await async_client.post(
        "/api/v1/routing/categories",
        json={
            "slug": slug,
            "name": "Fallen Trees",
            "departmentCode": "roads",
            "active": True,
        },
        headers=admin_headers,
    )
    assert create_res.status_code == 201
    created_data = create_res.json()
    assert created_data["slug"] == slug
    assert created_data["departmentCode"] == "roads"

    # Verify outbox event written in same transaction
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT event_id, event_type, correlation_id, payload
            FROM outbox_events
            WHERE event_type = 'category.upserted'
            ORDER BY id DESC
            LIMIT 1;
            """
        )
        row = await cur.fetchone()
        assert row is not None
        payload = json.loads(row[3]) if isinstance(row[3], str) else row[3]
        assert payload["slug"] == slug
        assert payload["departmentCode"] == "roads"
        assert payload["active"] is True

        event = {
            "eventId": str(row[0]),
            "eventType": "category.upserted",
            "version": 1,
            "occurredAt": payload["updatedAt"],
            "correlationId": str(row[2]),
            "payload": payload,
        }
        validator.validate_event("category.upserted", 1, event)

    # 2. Admin patches category -> 200 OK
    patch_res = await async_client.patch(
        f"/api/v1/routing/categories/{slug}",
        json={"name": "Hazardous Trees & Branches", "departmentCode": "sanitation"},
        headers=admin_headers,
    )
    assert patch_res.status_code == 200
    patched_data = patch_res.json()
    assert patched_data["name"] == "Hazardous Trees & Branches"
    assert patched_data["departmentCode"] == "sanitation"

    # Verify second category.upserted outbox event
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT event_id, event_type, correlation_id, payload
            FROM outbox_events
            WHERE event_type = 'category.upserted'
            ORDER BY id DESC
            LIMIT 1;
            """
        )
        row2 = await cur.fetchone()
        assert row2 is not None
        payload2 = json.loads(row2[3]) if isinstance(row2[3], str) else row2[3]
        assert payload2["slug"] == slug
        assert payload2["name"] == "Hazardous Trees & Branches"
        assert payload2["departmentCode"] == "sanitation"


@pytest.mark.asyncio
async def test_admin_manual_reassign_emits_report_assigned(
    async_client: AsyncClient, test_settings: Settings
) -> None:
    admin_token = generate_token(str(uuid.uuid4()), role="admin")
    officer_token = generate_token(str(uuid.uuid4()), role="officer")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    officer_headers = {"Authorization": f"Bearer {officer_token}"}
    validator = get_event_validator()
    pool = get_global_pool()

    report_id = str(uuid.uuid4())

    # Admin reassigns report manually to water department and ward W-R1C1
    reassign_res = await async_client.post(
        f"/api/v1/routing/reports/{report_id}/reassign",
        json={"departmentCode": "water", "wardCode": "W-R1C1"},
        headers=admin_headers,
    )
    assert reassign_res.status_code == 200
    data = reassign_res.json()
    assert data["reportId"] == report_id
    assert data["departmentCode"] == "water"
    assert data["wardCode"] == "W-R1C1"
    assert data["source"] == "manual"

    # Officer can now fetch the assignment via GET /reports/{id}
    get_res = await async_client.get(
        f"/api/v1/routing/reports/{report_id}", headers=officer_headers
    )
    assert get_res.status_code == 200
    get_data = get_res.json()
    assert get_data["reportId"] == report_id
    assert get_data["departmentCode"] == "water"
    assert get_data["source"] == "manual"

    # Verify outbox has report.assigned with source: 'manual'
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT event_id, event_type, correlation_id, payload
            FROM outbox_events
            WHERE event_type = 'report.assigned'
            ORDER BY id DESC
            LIMIT 1;
            """
        )
        row = await cur.fetchone()
        assert row is not None
        payload = json.loads(row[3]) if isinstance(row[3], str) else row[3]
        assert payload["reportId"] == report_id
        assert payload["departmentCode"] == "water"
        assert payload["departmentName"] == "Water & Sewerage"
        assert payload["departmentEmail"] == "water@civic.example.test"
        assert payload["source"] == "manual"

        event = {
            "eventId": str(row[0]),
            "eventType": "report.assigned",
            "version": 1,
            "occurredAt": payload["assignedAt"],
            "correlationId": str(row[2]),
            "payload": payload,
        }
        validator.validate_event("report.assigned", 1, event)


@pytest.mark.asyncio
async def test_admin_ward_and_department_management(async_client: AsyncClient) -> None:
    admin_token = generate_token(str(uuid.uuid4()), role="admin")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}

    # 1. Update ward
    ward_res = await async_client.patch(
        "/api/v1/routing/wards/W-R1C1",
        json={"name": "Ward 1 - Updated", "active": True},
        headers=admin_headers,
    )
    assert ward_res.status_code == 200
    ward_data = ward_res.json()
    assert ward_data["properties"]["name"] == "Ward 1 - Updated"

    # 2. Create department
    dept_code = f"dept-{uuid.uuid4().hex[:6]}"
    dept_res = await async_client.post(
        "/api/v1/routing/departments",
        json={
            "code": dept_code,
            "name": "Urban Forestry",
            "email": "forestry@civic.example.test",
            "active": True,
        },
        headers=admin_headers,
    )
    assert dept_res.status_code == 201
    dept_data = dept_res.json()
    assert dept_data["code"] == dept_code
    assert dept_data["email"] == "forestry@civic.example.test"

    # 3. Patch department
    dept_patch = await async_client.patch(
        f"/api/v1/routing/departments/{dept_code}",
        json={"name": "Urban Forestry & Greenery"},
        headers=admin_headers,
    )
    assert dept_patch.status_code == 200
    assert dept_patch.json()["name"] == "Urban Forestry & Greenery"


@pytest.mark.asyncio
async def test_assignments_endpoints_and_role_checks(
    async_client: AsyncClient,
) -> None:
    admin_token = generate_token(str(uuid.uuid4()), role="admin")
    officer_token = generate_token(str(uuid.uuid4()), role="officer")
    citizen_token = generate_token(str(uuid.uuid4()), role="citizen")

    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    officer_headers = {"Authorization": f"Bearer {officer_token}"}
    citizen_headers = {"Authorization": f"Bearer {citizen_token}"}

    report_id = str(uuid.uuid4())

    # 1. Unauthenticated gets 401 on admin write
    unauth_post = await async_client.post(
        "/api/v1/routing/assignments",
        json={"reportId": report_id, "departmentCode": "roads", "wardCode": "W-R1C1"},
    )
    assert unauth_post.status_code == 401

    # 2. Citizen gets 403 on admin assignment write
    citizen_post = await async_client.post(
        "/api/v1/routing/assignments",
        json={"reportId": report_id, "departmentCode": "roads", "wardCode": "W-R1C1"},
        headers=citizen_headers,
    )
    assert citizen_post.status_code == 403

    # 3. Citizen gets 403 on ward patch
    citizen_ward = await async_client.patch(
        "/api/v1/routing/wards/W-R1C1",
        json={"name": "Hacked Ward"},
        headers=citizen_headers,
    )
    assert citizen_ward.status_code == 403

    # 4. Admin creates assignment via POST /assignments (200)
    admin_post = await async_client.post(
        "/api/v1/routing/assignments",
        json={"reportId": report_id, "departmentCode": "roads", "wardCode": "W-R1C1"},
        headers=admin_headers,
    )
    assert admin_post.status_code == 200
    assert admin_post.json()["reportId"] == report_id
    assert admin_post.json()["departmentCode"] == "roads"

    # 5. Officer gets 200 on GET /assignments/{report_id}
    officer_get = await async_client.get(
        f"/api/v1/routing/assignments/{report_id}",
        headers=officer_headers,
    )
    assert officer_get.status_code == 200
    assert officer_get.json()["reportId"] == report_id
    assert officer_get.json()["departmentCode"] == "roads"

    # 6. Citizen gets 403 on GET /assignments/{report_id}
    citizen_get = await async_client.get(
        f"/api/v1/routing/assignments/{report_id}",
        headers=citizen_headers,
    )
    assert citizen_get.status_code == 403


@pytest.mark.asyncio
async def test_departments_crud_duplicate_and_validation(
    async_client: AsyncClient,
) -> None:
    admin_token = generate_token(str(uuid.uuid4()), role="admin")
    admin_headers = {"Authorization": f"Bearer {admin_token}"}

    # 1. Validation failure: invalid code (uppercase/symbols) -> 400
    val_res = await async_client.post(
        "/api/v1/routing/departments",
        json={"code": "INVALID CODE!", "name": "Bad", "email": "bad@civic.test"},
        headers=admin_headers,
    )
    assert val_res.status_code == 400

    # Validation failure: bad email -> 400
    val_res2 = await async_client.post(
        "/api/v1/routing/departments",
        json={"code": "valid-code", "name": "Bad", "email": "not-an-email"},
        headers=admin_headers,
    )
    assert val_res2.status_code == 400

    # 2. Create valid department -> 201
    code = f"dept-{uuid.uuid4().hex[:6]}"
    create_res = await async_client.post(
        "/api/v1/routing/departments",
        json={"code": code, "name": "Parks & Gardens", "email": "parks@civic.test", "active": True},
        headers=admin_headers,
    )
    assert create_res.status_code == 201
    assert create_res.json()["code"] == code

    # 3. Duplicate code -> 409
    dup_res = await async_client.post(
        "/api/v1/routing/departments",
        json={"code": code, "name": "Parks Duplicate", "email": "parks2@civic.test", "active": True},
        headers=admin_headers,
    )
    assert dup_res.status_code == 409
    assert dup_res.json()["code"] == "conflict"


@pytest.mark.asyncio
async def test_departments_and_categories_all_parameter(
    async_client: AsyncClient,
) -> None:
    admin_token = generate_token(str(uuid.uuid4()), role="admin")
    citizen_token = generate_token(str(uuid.uuid4()), role="citizen")
    officer_token = generate_token(str(uuid.uuid4()), role="officer")

    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    citizen_headers = {"Authorization": f"Bearer {citizen_token}"}
    officer_headers = {"Authorization": f"Bearer {officer_token}"}

    # Setup: create inactive department and inactive category
    inact_dept = f"inact-{uuid.uuid4().hex[:6]}"
    await async_client.post(
        "/api/v1/routing/departments",
        json={"code": inact_dept, "name": "Inactive Dept", "email": "inact@civic.test", "active": False},
        headers=admin_headers,
    )

    inact_cat = f"inact-{uuid.uuid4().hex[:6]}"
    await async_client.post(
        "/api/v1/routing/categories",
        json={"slug": inact_cat, "name": "Inactive Cat", "departmentCode": "roads", "active": False},
        headers=admin_headers,
    )

    # 1. Public GET without all=true returns only active items
    pub_depts = await async_client.get("/api/v1/routing/departments")
    assert pub_depts.status_code == 200
    assert not any(d["code"] == inact_dept for d in pub_depts.json())

    pub_cats = await async_client.get("/api/v1/routing/categories")
    assert pub_cats.status_code == 200
    assert not any(c["slug"] == inact_cat for c in pub_cats.json())

    # 2. GET with all=true as admin -> 200 and includes inactive items
    admin_depts = await async_client.get("/api/v1/routing/departments?all=true", headers=admin_headers)
    assert admin_depts.status_code == 200
    assert any(d["code"] == inact_dept for d in admin_depts.json())

    admin_cats = await async_client.get("/api/v1/routing/categories?all=true", headers=admin_headers)
    assert admin_cats.status_code == 200
    assert any(c["slug"] == inact_cat for c in admin_cats.json())

    # 3. GET with all=true as citizen -> 403
    cit_depts = await async_client.get("/api/v1/routing/departments?all=true", headers=citizen_headers)
    assert cit_depts.status_code == 403
    cit_cats = await async_client.get("/api/v1/routing/categories?all=true", headers=citizen_headers)
    assert cit_cats.status_code == 403

    # 4. GET with all=true as officer -> 403
    off_depts = await async_client.get("/api/v1/routing/departments?all=true", headers=officer_headers)
    assert off_depts.status_code == 403
    off_cats = await async_client.get("/api/v1/routing/categories?all=true", headers=officer_headers)
    assert off_cats.status_code == 403

    # 5. GET with all=true as anonymous -> 403
    anon_depts = await async_client.get("/api/v1/routing/departments?all=true")
    assert anon_depts.status_code == 403
    anon_cats = await async_client.get("/api/v1/routing/categories?all=true")
    assert anon_cats.status_code == 403
