"""Departments API routes."""

from typing import Any

from fastapi import APIRouter, Depends, status
from psycopg_pool import AsyncConnectionPool

from app.auth import UserClaims, require_role
from app.db import get_global_pool
from app.errors import AppError
from app.models import DepartmentCreate, DepartmentPatch, DepartmentResponse

router = APIRouter(tags=["Departments"])


@router.get("/departments", response_model=list[DepartmentResponse])
async def list_departments() -> list[dict[str, Any]]:
    """List all municipal departments."""
    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute("""
            SELECT code, name, email, active
            FROM departments
            ORDER BY code ASC;
        """)
        rows = await cur.fetchall()

    return [{"code": r[0], "name": r[1], "email": r[2], "active": r[3]} for r in rows]


@router.post("/departments", response_model=DepartmentResponse, status_code=status.HTTP_201_CREATED)
async def create_department(
    payload: DepartmentCreate,
    user: UserClaims = Depends(require_role("admin")),
) -> dict[str, Any]:
    """Create a new municipal department."""
    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("SELECT code FROM departments WHERE code = %s;", (payload.code,))
        if await cur.fetchone():
            raise AppError(
                status_code=409,
                code="conflict",
                message=f"Department {payload.code} already exists",
            )

        await cur.execute(
            """
            INSERT INTO departments (code, name, email, active, created_at, updated_at)
            VALUES (%s, %s, %s, %s, NOW(), NOW())
            RETURNING code, name, email, active;
            """,
            (payload.code, payload.name, payload.email, payload.active),
        )
        row = await cur.fetchone()
        if row is None:
            raise AppError(
                status_code=500,
                code="internal_error",
                message="Failed to create department",
            )

    return {"code": row[0], "name": row[1], "email": row[2], "active": row[3]}


@router.patch("/departments/{code}", response_model=DepartmentResponse)
async def patch_department(
    code: str,
    payload: DepartmentPatch,
    user: UserClaims = Depends(require_role("admin")),
) -> dict[str, Any]:
    """Update department attributes."""
    if payload.name is None and payload.email is None and payload.active is None:
        raise AppError(status_code=400, code="bad_request", message="No update fields specified")

    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("SELECT code FROM departments WHERE code = %s;", (code,))
        if not await cur.fetchone():
            raise AppError(
                status_code=404,
                code="not_found",
                message=f"Department {code} not found",
            )

        updates: list[str] = []
        params: list[Any] = []
        if payload.name is not None:
            updates.append("name = %s")
            params.append(payload.name)
        if payload.email is not None:
            updates.append("email = %s")
            params.append(payload.email)
        if payload.active is not None:
            updates.append("active = %s")
            params.append(payload.active)

        updates.append("updated_at = NOW()")
        params.append(code)

        query = (
            f"UPDATE departments SET {', '.join(updates)} "
            "WHERE code = %s RETURNING code, name, email, active;"
        )
        await cur.execute(query, tuple(params))
        row = await cur.fetchone()
        if row is None:
            raise AppError(
                status_code=500,
                code="internal_error",
                message="Failed to update department",
            )

    return {"code": row[0], "name": row[1], "email": row[2], "active": row[3]}
