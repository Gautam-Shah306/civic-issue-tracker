"""Wards API routes."""

import json
from typing import Any

from fastapi import APIRouter, Depends
from psycopg_pool import AsyncConnectionPool

from app.auth import UserClaims, require_role
from app.db import get_global_pool
from app.errors import AppError
from app.models import GeoJSONFeature, GeoJSONFeatureCollection, WardPatch

router = APIRouter(tags=["Wards"])


@router.get("/wards", response_model=GeoJSONFeatureCollection)
async def list_wards() -> dict[str, Any]:
    """Retrieve GeoJSON FeatureCollection of all synthetic wards for map rendering."""
    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute("""
            SELECT code, name, active, ST_AsGeoJSON(geom) AS geom_json
            FROM wards
            ORDER BY code ASC;
        """)
        rows = await cur.fetchall()

    features: list[dict[str, Any]] = []
    for code, name, active, geom_json in rows:
        features.append(
            {
                "type": "Feature",
                "id": code,
                "properties": {
                    "code": code,
                    "name": name,
                    "active": active,
                },
                "geometry": json.loads(geom_json) if isinstance(geom_json, str) else geom_json,
            }
        )

    return {"type": "FeatureCollection", "features": features}


@router.patch("/wards/{code}", response_model=GeoJSONFeature)
async def patch_ward(
    code: str,
    payload: WardPatch,
    user: UserClaims = Depends(require_role("admin")),
) -> dict[str, Any]:
    """Update ward metadata (name, active status) by administrative authority."""
    if payload.name is None and payload.active is None:
        raise AppError(
            status_code=400,
            code="bad_request",
            message="No update fields specified",
        )

    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("SELECT code FROM wards WHERE code = %s;", (code,))
        if not await cur.fetchone():
            raise AppError(status_code=404, code="not_found", message=f"Ward {code} not found")

        updates: list[str] = []
        params: list[Any] = []
        if payload.name is not None:
            updates.append("name = %s")
            params.append(payload.name)
        if payload.active is not None:
            updates.append("active = %s")
            params.append(payload.active)

        updates.append("updated_at = NOW()")
        params.append(code)

        query = (
            f"UPDATE wards SET {', '.join(updates)} "
            "WHERE code = %s RETURNING code, name, active, ST_AsGeoJSON(geom);"
        )
        await cur.execute(query, tuple(params))
        row = await cur.fetchone()
        if row is None:
            raise AppError(status_code=500, code="internal_error", message="Failed to update ward")
        code, name, active, geom_json = row

    return {
        "type": "Feature",
        "id": code,
        "properties": {
            "code": code,
            "name": name,
            "active": active,
        },
        "geometry": json.loads(geom_json) if isinstance(geom_json, str) else geom_json,
    }
