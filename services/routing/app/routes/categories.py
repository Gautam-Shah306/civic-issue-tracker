"""Categories API routes with transactional category.upserted publication."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, status
from psycopg_pool import AsyncConnectionPool

from app.auth import JwtVerifier, UserClaims, get_jwt_verifier, require_role
from app.db import get_global_pool
from app.errors import AppError
from app.events.validator import get_event_validator
from app.logging import correlation_id_ctx
from app.models import CategoryCreate, CategoryPatch, CategoryResponse

router = APIRouter(tags=["Categories"])


def _make_cid() -> str:
    cid = correlation_id_ctx.get()
    return cid or str(uuid.uuid4())


@router.get("/categories", response_model=list[CategoryResponse])
async def list_categories(
    all: bool = False,
    authorization: str | None = Header(None, alias="Authorization"),
    verifier: JwtVerifier = Depends(get_jwt_verifier),
) -> list[dict[str, Any]]:
    """List all civic issue categories with department routing."""
    if all:
        try:
            user = verifier.verify_token(authorization)
            if user.role != "admin":
                raise AppError(status_code=403, code="forbidden", message="Admin role required")
        except AppError as e:
            if e.status_code == 403:
                raise
            raise AppError(status_code=403, code="forbidden", message="Admin role required") from e
        except Exception as e:
            raise AppError(status_code=403, code="forbidden", message="Admin role required") from e

    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        if all:
            await cur.execute("""
                SELECT slug, name, department_code, active
                FROM categories
                ORDER BY slug ASC;
            """)
        else:
            await cur.execute("""
                SELECT slug, name, department_code, active
                FROM categories
                WHERE active = true
                ORDER BY slug ASC;
            """)
        rows = await cur.fetchall()

    return [{"slug": r[0], "name": r[1], "departmentCode": r[2], "active": r[3]} for r in rows]


@router.post("/categories", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
async def create_category(
    payload: CategoryCreate,
    user: UserClaims = Depends(require_role("admin")),
) -> dict[str, Any]:
    """Create a civic issue category and publish category.upserted event."""
    pool: AsyncConnectionPool = get_global_pool()
    validator = get_event_validator()
    cid = _make_cid()

    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        # Validate department exists and is active
        await cur.execute(
            "SELECT code FROM departments WHERE code = %s AND active = true;",
            (payload.departmentCode,),
        )
        if not await cur.fetchone():
            raise AppError(
                status_code=400,
                code="bad_request",
                message=f"Active department {payload.departmentCode} not found",
            )

        await cur.execute("SELECT slug FROM categories WHERE slug = %s;", (payload.slug,))
        if await cur.fetchone():
            raise AppError(
                status_code=409,
                code="conflict",
                message=f"Category {payload.slug} already exists",
            )

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        await cur.execute(
            """
            INSERT INTO categories (slug, name, department_code, active, created_at, updated_at)
            VALUES (%s, %s, %s, %s, NOW(), NOW())
            RETURNING slug, name, department_code, active;
            """,
            (payload.slug, payload.name, payload.departmentCode, payload.active),
        )
        row = await cur.fetchone()
        if row is None:
            raise AppError(
                status_code=500,
                code="internal_error",
                message="Failed to create category",
            )

        event_payload = {
            "slug": row[0],
            "name": row[1],
            "active": row[3],
            "departmentCode": row[2],
            "updatedAt": now_iso,
        }
        event_envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "category.upserted",
            "version": 1,
            "occurredAt": now_iso,
            "correlationId": cid,
            "payload": event_payload,
        }
        validator.validate_event("category.upserted", 1, event_envelope)

        await cur.execute(
            """
            INSERT INTO outbox_events (
                event_id, event_type, version, correlation_id, payload, occurred_at
            )
            VALUES (%s, %s, %s, %s, %s, %s);
            """,
            (
                event_envelope["eventId"],
                "category.upserted",
                1,
                cid,
                json.dumps(event_payload),
                now_iso,
            ),
        )

    return {"slug": row[0], "name": row[1], "departmentCode": row[2], "active": row[3]}


@router.patch("/categories/{slug}", response_model=CategoryResponse)
async def patch_category(
    slug: str,
    payload: CategoryPatch,
    user: UserClaims = Depends(require_role("admin")),
) -> dict[str, Any]:
    """Update civic issue category attributes and emit category.upserted."""
    if payload.name is None and payload.departmentCode is None and payload.active is None:
        raise AppError(status_code=400, code="bad_request", message="No update fields specified")

    pool: AsyncConnectionPool = get_global_pool()
    validator = get_event_validator()
    cid = _make_cid()

    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("SELECT slug FROM categories WHERE slug = %s;", (slug,))
        if not await cur.fetchone():
            raise AppError(status_code=404, code="not_found", message=f"Category {slug} not found")

        if payload.departmentCode is not None:
            await cur.execute(
                "SELECT code FROM departments WHERE code = %s AND active = true;",
                (payload.departmentCode,),
            )
            if not await cur.fetchone():
                raise AppError(
                    status_code=400,
                    code="bad_request",
                    message=f"Active department {payload.departmentCode} not found",
                )

        updates: list[str] = []
        params: list[Any] = []
        if payload.name is not None:
            updates.append("name = %s")
            params.append(payload.name)
        if payload.departmentCode is not None:
            updates.append("department_code = %s")
            params.append(payload.departmentCode)
        if payload.active is not None:
            updates.append("active = %s")
            params.append(payload.active)

        updates.append("updated_at = NOW()")
        params.append(slug)

        query = (
            f"UPDATE categories SET {', '.join(updates)} "
            "WHERE slug = %s RETURNING slug, name, department_code, active;"
        )
        await cur.execute(query, tuple(params))
        row = await cur.fetchone()
        if row is None:
            raise AppError(
                status_code=500,
                code="internal_error",
                message="Failed to update category",
            )

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        event_payload = {
            "slug": row[0],
            "name": row[1],
            "active": row[3],
            "departmentCode": row[2],
            "updatedAt": now_iso,
        }
        event_envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "category.upserted",
            "version": 1,
            "occurredAt": now_iso,
            "correlationId": cid,
            "payload": event_payload,
        }
        validator.validate_event("category.upserted", 1, event_envelope)

        await cur.execute(
            """
            INSERT INTO outbox_events (
                event_id, event_type, version, correlation_id, payload, occurred_at
            )
            VALUES (%s, %s, %s, %s, %s, %s);
            """,
            (
                event_envelope["eventId"],
                "category.upserted",
                1,
                cid,
                json.dumps(event_payload),
                now_iso,
            ),
        )

    return {"slug": row[0], "name": row[1], "departmentCode": row[2], "active": row[3]}
