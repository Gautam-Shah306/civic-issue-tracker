"""Integration tests for image upload, processing worker, metadata, and asset streaming."""

import io
import json
import uuid

import pytest
from httpx import AsyncClient
from PIL import Image

from app.db import get_global_pool
from app.lifecycle import lifecycle
from tests.conftest import generate_token
from tests.support.helpers import make_test_jpeg, make_test_png, make_test_webp


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
async def test_upload_unauthorized_401(async_client: AsyncClient) -> None:
    jpeg_bytes = make_test_jpeg()
    files = {"file": ("test.jpg", jpeg_bytes, "image/jpeg")}
    response = await async_client.post("/api/v1/images", files=files)
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_upload_valid_jpeg_with_exif(async_client: AsyncClient) -> None:
    user_id = str(uuid.uuid4())
    token = generate_token(user_id, role="citizen")
    jpeg_bytes = make_test_jpeg(width=200, height=150, with_gps=True)
    files = {"file": ("test.jpg", jpeg_bytes, "image/jpeg")}

    response = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {token}"},
        files=files,
    )
    assert response.status_code == 202
    data = response.json()
    assert "imageId" in data
    assert data["status"] == "pending"
    assert uuid.UUID(data["imageId"])


@pytest.mark.asyncio
async def test_upload_valid_png_and_webp(async_client: AsyncClient) -> None:
    user_id = str(uuid.uuid4())
    token = generate_token(user_id, role="citizen")

    # PNG
    png_bytes = make_test_png(width=100, height=100)
    res_png = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("test.png", png_bytes, "image/png")},
    )
    assert res_png.status_code == 202

    # WebP
    webp_bytes = make_test_webp(width=100, height=100)
    res_webp = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("test.webp", webp_bytes, "image/webp")},
    )
    assert res_webp.status_code == 202


@pytest.mark.asyncio
async def test_upload_too_large_413(async_client: AsyncClient) -> None:
    user_id = str(uuid.uuid4())
    token = generate_token(user_id, role="citizen")
    # Simulate oversized data (> 8 MiB)
    oversized_bytes = b"0" * (8 * 1024 * 1024 + 100)
    files = {"file": ("large.jpg", oversized_bytes, "image/jpeg")}

    response = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {token}"},
        files=files,
    )
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


@pytest.mark.asyncio
async def test_upload_invalid_content_rejected_by_worker(async_client: AsyncClient) -> None:
    pool = get_global_pool()
    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("DELETE FROM outbox_events; DELETE FROM images;")

    user_id = str(uuid.uuid4())
    token = generate_token(user_id, role="citizen")
    # Plain text file disguised as jpg
    fake_bytes = b"not an actual image file content"
    files = {"file": ("x.jpg", fake_bytes, "image/jpeg")}

    response = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {token}"},
        files=files,
    )
    assert response.status_code == 202
    image_id = response.json()["imageId"]

    # Claim and process job with worker
    worker = lifecycle.worker
    assert worker is not None
    job = await worker.claim_job()
    assert job is not None
    await worker.process_job(job)

    # Verify status is rejected
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT status, reject_reason FROM images WHERE id = %s;",
            (image_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == "rejected"
        assert row[1] == "unreadable_image"


@pytest.mark.asyncio
async def test_worker_processing_ready_and_exif_stripping(async_client: AsyncClient) -> None:
    pool = get_global_pool()
    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("DELETE FROM outbox_events; DELETE FROM images;")

    user_id = str(uuid.uuid4())
    token = generate_token(user_id, role="citizen")
    jpeg_bytes = make_test_jpeg(width=300, height=200, with_gps=True)

    # 1. Upload
    res = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("gps_test.jpg", jpeg_bytes, "image/jpeg")},
    )
    assert res.status_code == 202
    image_id = res.json()["imageId"]

    # 2. Before processing, thumbnail and file return 404
    thumb_before = await async_client.get(f"/api/v1/images/{image_id}/thumbnail")
    assert thumb_before.status_code == 404

    # 3. Process job via ImageWorker
    worker = lifecycle.worker
    assert worker is not None
    job = await worker.claim_job()
    assert job is not None
    assert job["id"] == image_id
    await worker.process_job(job)

    # 4. Check DB state
    pool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT status, width, height, gps_present, full_key, thumb_key, reject_reason
            FROM images WHERE id = %s;
            """,
            (image_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        status, width, height, gps_present, full_key, thumb_key, reject_reason = row
        assert status == "ready"
        assert width == 300
        assert height == 200
        assert gps_present is True
        assert full_key == f"{image_id}/full.jpg"
        assert thumb_key == f"{image_id}/thumb.jpg"
        assert reject_reason is None

        # Check outbox event
        await cur.execute(
            "SELECT event_type, version, payload FROM outbox_events WHERE payload->>'imageId' = %s;",
            (image_id,),
        )
        outbox_row = await cur.fetchone()
        assert outbox_row is not None
        event_type, version, payload_raw = outbox_row
        assert event_type == "image.processed"
        assert version == 1
        payload = payload_raw if isinstance(payload_raw, dict) else json.loads(payload_raw)
        assert payload["status"] == "ready"
        assert payload["width"] == 300
        assert payload["height"] == 200
        assert payload["gpsPresent"] is True
        assert payload["rejectReason"] is None

    # 5. Fetch thumbnail: 200 OK, JPEG, Cache-Control immutable, EXIF stripped
    thumb_res = await async_client.get(f"/api/v1/images/{image_id}/thumbnail")
    assert thumb_res.status_code == 200
    assert thumb_res.headers["content-type"] == "image/jpeg"
    assert "immutable" in thumb_res.headers["cache-control"]

    # Verify EXIF is completely stripped in thumbnail
    thumb_img = Image.open(io.BytesIO(thumb_res.content))
    exif = thumb_img.getexif()
    assert 34853 not in exif

    # 6. Fetch full file: 200 OK
    file_res = await async_client.get(f"/api/v1/images/{image_id}/file")
    assert file_res.status_code == 200
    assert file_res.headers["content-type"] == "image/jpeg"
    assert "immutable" in file_res.headers["cache-control"]


@pytest.mark.asyncio
async def test_worker_processing_rejected(async_client: AsyncClient) -> None:
    pool = get_global_pool()
    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        await cur.execute("DELETE FROM outbox_events; DELETE FROM images;")

    user_id = str(uuid.uuid4())
    token = generate_token(user_id, role="citizen")
    # Upload a valid small png to create pending row and S3 key
    png_bytes = make_test_png(width=50, height=50)
    res = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("corrupt.png", png_bytes, "image/png")},
    )
    image_id = res.json()["imageId"]

    # Overwrite incoming key with corrupted bytes
    storage = lifecycle.storage
    assert storage is not None
    await storage.put_bytes(
        lifecycle.settings.INCOMING_BUCKET, f"{image_id}/incoming", b"garbage data", "image/png"
    )

    # Claim and process job
    worker = lifecycle.worker
    assert worker is not None
    job = await worker.claim_job()
    assert job is not None
    await worker.process_job(job)

    # Verify status is rejected
    pool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT status, reject_reason FROM images WHERE id = %s;",
            (image_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        status, reject_reason = row
        assert status == "rejected"
        assert reject_reason == "unreadable_image"

        # Check outbox rejection event
        await cur.execute(
            "SELECT payload FROM outbox_events WHERE payload->>'imageId' = %s;",
            (image_id,),
        )
        outbox_row = await cur.fetchone()
        assert outbox_row is not None
        payload = outbox_row[0] if isinstance(outbox_row[0], dict) else json.loads(outbox_row[0])
        assert payload["status"] == "rejected"
        assert payload["rejectReason"] == "unreadable_image"


@pytest.mark.asyncio
async def test_metadata_permissions(async_client: AsyncClient) -> None:
    owner_id = str(uuid.uuid4())
    other_citizen_id = str(uuid.uuid4())
    officer_id = str(uuid.uuid4())
    admin_id = str(uuid.uuid4())

    owner_token = generate_token(owner_id, role="citizen")
    other_citizen_token = generate_token(other_citizen_id, role="citizen")
    officer_token = generate_token(officer_id, role="officer")
    admin_token = generate_token(admin_id, role="admin")

    jpeg_bytes = make_test_jpeg(width=120, height=80)
    res = await async_client.post(
        "/api/v1/images",
        headers={"Authorization": f"Bearer {owner_token}"},
        files={"file": ("meta.jpg", jpeg_bytes, "image/jpeg")},
    )
    image_id = res.json()["imageId"]

    # Owner can get metadata
    res_owner = await async_client.get(
        f"/api/v1/images/{image_id}",
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert res_owner.status_code == 200
    assert res_owner.json()["imageId"] == image_id

    # Non-owner citizen gets 404
    res_other = await async_client.get(
        f"/api/v1/images/{image_id}",
        headers={"Authorization": f"Bearer {other_citizen_token}"},
    )
    assert res_other.status_code == 404

    # Officer can get metadata
    res_officer = await async_client.get(
        f"/api/v1/images/{image_id}",
        headers={"Authorization": f"Bearer {officer_token}"},
    )
    assert res_officer.status_code == 200

    # Admin can get metadata
    res_admin = await async_client.get(
        f"/api/v1/images/{image_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert res_admin.status_code == 200


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
