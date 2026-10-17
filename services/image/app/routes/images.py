"""Image upload, metadata, and asset streaming routes."""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, File, Response, UploadFile, status
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from app.auth import UserClaims, require_role
from app.config import Settings, get_settings
from app.db import get_global_pool
from app.errors import AppError
from app.storage import get_storage

router = APIRouter(prefix="/api/v1/images", tags=["Images"])


class ImageUploadResponse(BaseModel):
    """Response schema for image upload endpoint."""

    imageId: str
    status: str


class ImageMetadataResponse(BaseModel):
    """Response schema for image metadata endpoint."""

    imageId: str
    status: str
    width: int | None = None
    height: int | None = None
    gpsPresent: bool


@router.post("", response_model=ImageUploadResponse, status_code=status.HTTP_202_ACCEPTED)
async def upload_image(
    file: UploadFile | None = File(default=None),
    user: UserClaims = Depends(require_role("citizen", "officer", "admin")),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Upload a new civic issue photo (JPEG, PNG, WebP)."""
    if file is None or not file.filename:
        raise AppError(status_code=400, code="bad_request", message="File field is required")

    # Early size check on content length if provided
    raw_bytes = await file.read()
    if len(raw_bytes) > settings.MAX_UPLOAD_BYTES:
        raise AppError(
            status_code=413,
            code="payload_too_large",
            message=f"Image upload exceeds maximum size of {settings.MAX_UPLOAD_BYTES} bytes",
        )

    content_type = file.content_type or "application/octet-stream"

    image_id = str(uuid.uuid4())
    incoming_key = f"{image_id}/incoming"

    storage = get_storage(settings)
    await storage.put_bytes(settings.INCOMING_BUCKET, incoming_key, raw_bytes, content_type)

    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO images (
                id, owner_id, status, content_type, size_bytes,
                incoming_key, created_at, next_attempt_at
            )
            VALUES (%s, %s, 'pending', %s, %s, %s, NOW(), NOW());
            """,
            (image_id, user.id, content_type, len(raw_bytes), incoming_key),
        )

    return {"imageId": image_id, "status": "pending"}


@router.get("/{imageId}", response_model=ImageMetadataResponse)
async def get_image_metadata(
    imageId: uuid.UUID,
    user: UserClaims = Depends(require_role("citizen", "officer", "admin")),
) -> dict[str, Any]:
    """Retrieve metadata for an image (owner, officer, admin only)."""
    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id, owner_id, status, width, height, gps_present
            FROM images
            WHERE id = %s;
            """,
            (str(imageId),),
        )
        row = await cur.fetchone()
        if not row:
            raise AppError(status_code=404, code="not_found", message=f"Image {imageId} not found")

        img_id, owner_id, img_status, width, height, gps_present = row
        # Non-owners get 404
        if user.role == "citizen" and str(owner_id) != user.id:
            raise AppError(status_code=404, code="not_found", message=f"Image {imageId} not found")

        return {
            "imageId": str(img_id),
            "status": img_status,
            "width": width,
            "height": height,
            "gpsPresent": gps_present,
        }


@router.get("/{imageId}/thumbnail")
async def get_image_thumbnail(
    imageId: uuid.UUID,
    settings: Settings = Depends(get_settings),
) -> Response:
    """Public capability URL for 320px thumbnail (immutable cache)."""
    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT status, thumb_key FROM images WHERE id = %s;",
            (str(imageId),),
        )
        row = await cur.fetchone()
        if not row:
            raise AppError(status_code=404, code="not_found", message="Image not found")

        img_status, thumb_key = row
        if img_status != "ready" or not thumb_key:
            raise AppError(
                status_code=404, code="not_found", message="Image thumbnail not ready or not found"
            )

    storage = get_storage(settings)
    try:
        thumb_bytes = await storage.get_bytes(settings.IMAGES_BUCKET, thumb_key)
    except Exception:
        raise AppError(
            status_code=404, code="not_found", message="Image thumbnail not found in storage"
        ) from None

    return Response(
        content=thumb_bytes,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@router.get("/{imageId}/file")
async def get_image_file(
    imageId: uuid.UUID,
    settings: Settings = Depends(get_settings),
) -> Response:
    """Public capability URL for full image (max 1600px, immutable cache)."""
    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT status, full_key FROM images WHERE id = %s;",
            (str(imageId),),
        )
        row = await cur.fetchone()
        if not row:
            raise AppError(status_code=404, code="not_found", message="Image not found")

        img_status, full_key = row
        if img_status != "ready" or not full_key:
            raise AppError(
                status_code=404, code="not_found", message="Image file not ready or not found"
            )

    storage = get_storage(settings)
    try:
        full_bytes = await storage.get_bytes(settings.IMAGES_BUCKET, full_key)
    except Exception:
        raise AppError(
            status_code=404, code="not_found", message="Image file not found in storage"
        ) from None

    return Response(
        content=full_bytes,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )
