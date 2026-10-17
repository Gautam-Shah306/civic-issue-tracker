"""Background processing worker for image validation, resizing, and metadata stripping."""

import asyncio
import contextlib
import io
import json
import logging
import uuid
import warnings
from datetime import UTC, datetime
from typing import Any

from PIL import Image, ImageOps
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.events.validator import get_event_validator
from app.storage import S3Storage

logger = logging.getLogger("worker")

# Disallow huge decompression bombs and treat warning as error
warnings.simplefilter("error", Image.DecompressionBombWarning)


class ImageWorker:
    """Worker polling pending image records, resizing and publishing image.processed."""

    def __init__(
        self,
        pool: AsyncConnectionPool,
        storage: S3Storage,
        settings: Settings,
    ) -> None:
        """Initialize image worker."""
        self.pool = pool
        self.storage = storage
        self.settings = settings
        self.poll_interval = settings.WORKER_POLL_INTERVAL
        self.lease_seconds = settings.WORKER_LEASE_SECONDS
        self.max_attempts = settings.WORKER_MAX_ATTEMPTS
        self._running = False
        self._task: asyncio.Task[None] | None = None
        self.validator = get_event_validator()
        Image.MAX_IMAGE_PIXELS = settings.MAX_IMAGE_PIXELS

    async def claim_job(self) -> dict[str, Any] | None:
        """Claim a single pending image job with a 60-second lease."""
        async with (
            self.pool.connection() as conn,
            conn.transaction(),
            conn.cursor() as cur,
        ):
            await cur.execute(
                """
                SELECT id, owner_id, incoming_key, attempts
                FROM images
                WHERE status = 'pending' AND next_attempt_at <= NOW()
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED;
                """
            )
            row = await cur.fetchone()
            if not row:
                return None

            image_id, owner_id, incoming_key, attempts = row
            # Set lease for 60 seconds
            await cur.execute(
                """
                UPDATE images
                SET next_attempt_at = NOW() + (%s * INTERVAL '1 second')
                WHERE id = %s;
                """,
                (self.lease_seconds, image_id),
            )
            return {
                "id": str(image_id),
                "owner_id": str(owner_id),
                "incoming_key": incoming_key,
                "attempts": attempts,
            }

    def _process_image_bytes(
        self, raw_bytes: bytes
    ) -> tuple[bool, str | None, bool, int | None, int | None, bytes | None, bytes | None]:
        """Process image in a CPU-bound worker thread."""
        try:
            # Check for empty file
            if not raw_bytes:
                return False, "unreadable_image", False, None, None, None, None

            bio = io.BytesIO(raw_bytes)
            try:
                img = Image.open(bio)
                img_format = img.format
            except Exception as e:
                logger.warning("Image open failed: %s", e)
                return False, "unreadable_image", False, None, None, None, None

            if img_format not in ("JPEG", "PNG", "WEBP"):
                return False, "unsupported_format", False, None, None, None, None

            # Detect GPS in EXIF
            gps_present = False
            try:
                exif = img.getexif()
                if exif:
                    # Tag 0x8825 (34853) is GPSInfo
                    if 34853 in exif:
                        gps_present = True
                    else:
                        gps_ifd = exif.get_ifd(34853)
                        if gps_ifd:
                            gps_present = True
            except Exception as e:
                logger.debug("Failed to read EXIF: %s", e)

            # Check pixel limit
            w, h = img.size
            if w * h > self.settings.MAX_IMAGE_PIXELS:
                return False, "pixel_limit_exceeded", gps_present, None, None, None, None

            # Force full decode to detect truncated or corrupt data
            try:
                img.load()
            except Exception as e:
                logger.warning("Image decode failed: %s", e)
                return False, "corrupt_image", gps_present, None, None, None, None

            # Apply orientation transpose
            with contextlib.suppress(Exception):
                img = ImageOps.exif_transpose(img)

            # Full image (max 1600 px)
            full_img = img.copy()
            full_img.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            full_rgb = full_img.convert("RGB")
            full_buf = io.BytesIO()
            full_rgb.save(full_buf, format="JPEG", quality=85, optimize=True)
            full_bytes = full_buf.getvalue()
            full_w, full_h = full_rgb.size

            # Thumbnail (max 320 px)
            thumb_img = img.copy()
            thumb_img.thumbnail((320, 320), Image.Resampling.LANCZOS)
            thumb_rgb = thumb_img.convert("RGB")
            thumb_buf = io.BytesIO()
            thumb_rgb.save(thumb_buf, format="JPEG", quality=85, optimize=True)
            thumb_bytes = thumb_buf.getvalue()

            return True, None, gps_present, full_w, full_h, full_bytes, thumb_bytes

        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            return False, "pixel_limit_exceeded", False, None, None, None, None
        except Exception as e:
            logger.warning("Image processing error: %s", e)
            return False, "corrupt_image", False, None, None, None, None

    async def process_job(self, job: dict[str, Any]) -> None:
        """Download upload, resize, strip metadata, upload full/thumb, and finalize."""
        image_id = job["id"]
        owner_id = job["owner_id"]
        incoming_key = job["incoming_key"]
        attempts = job["attempts"] + 1

        try:
            # 1. Download original from incoming bucket
            raw_bytes = await self.storage.get_bytes(self.settings.INCOMING_BUCKET, incoming_key)
        except Exception as e:
            logger.error("Failed to download %s from incoming: %s", incoming_key, e)
            await self._handle_transient_failure(
                image_id, owner_id, attempts, "storage_unavailable"
            )
            return

        # 2. Process image in thread
        (
            success,
            reject_reason,
            gps_present,
            full_w,
            full_h,
            full_bytes,
            thumb_bytes,
        ) = await asyncio.to_thread(self._process_image_bytes, raw_bytes)

        if not success or not full_bytes or not thumb_bytes:
            # Permanent rejection
            reason = reject_reason or "invalid_image"
            await self._finalize_rejected(image_id, owner_id, incoming_key, reason, gps_present)
            return

        # 3. Upload processed full and thumb images to images bucket
        full_key = f"{image_id}/full.jpg"
        thumb_key = f"{image_id}/thumb.jpg"
        try:
            await self.storage.put_bytes(
                self.settings.IMAGES_BUCKET, full_key, full_bytes, "image/jpeg"
            )
            await self.storage.put_bytes(
                self.settings.IMAGES_BUCKET, thumb_key, thumb_bytes, "image/jpeg"
            )
            # Delete original from incoming bucket
            await self.storage.delete_object(self.settings.INCOMING_BUCKET, incoming_key)
        except Exception as e:
            logger.error("Failed S3 upload or cleanup for %s: %s", image_id, e)
            await self._handle_transient_failure(
                image_id, owner_id, attempts, "storage_unavailable"
            )
            return

        # 4. Finalize ready status and stage image.processed outbox event
        await self._finalize_ready(
            image_id, owner_id, full_key, thumb_key, full_w, full_h, gps_present
        )

    async def _handle_transient_failure(
        self, image_id: str, owner_id: str, attempts: int, reason: str
    ) -> None:
        """Retry transient error up to max_attempts, then mark rejected."""
        if attempts >= self.max_attempts:
            logger.warning(
                "Job %s exceeded max attempts (%d), marking rejected", image_id, attempts
            )
            await self._finalize_rejected(image_id, owner_id, None, reason, False)
            return

        backoff = min(2**attempts, 30)
        async with (
            self.pool.connection() as conn,
            conn.transaction(),
            conn.cursor() as cur,
        ):
            await cur.execute(
                """
                UPDATE images
                SET attempts = %s,
                    next_attempt_at = NOW() + (%s * INTERVAL '1 second')
                WHERE id = %s;
                """,
                (attempts, backoff, image_id),
            )

    async def _finalize_ready(
        self,
        image_id: str,
        owner_id: str,
        full_key: str,
        thumb_key: str,
        width: int | None,
        height: int | None,
        gps_present: bool,
    ) -> None:
        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        cid = str(uuid.uuid4())
        event_payload = {
            "imageId": image_id,
            "ownerId": owner_id,
            "status": "ready",
            "width": width,
            "height": height,
            "gpsPresent": gps_present,
            "rejectReason": None,
            "processedAt": now_iso,
        }
        event_envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "image.processed",
            "version": 1,
            "occurredAt": now_iso,
            "correlationId": cid,
            "payload": event_payload,
        }
        self.validator.validate_event("image.processed", 1, event_envelope)

        async with (
            self.pool.connection() as conn,
            conn.transaction(),
            conn.cursor() as cur,
        ):
            await cur.execute(
                """
                UPDATE images
                SET status = 'ready',
                    width = %s,
                    height = %s,
                    gps_present = %s,
                    full_key = %s,
                    thumb_key = %s,
                    reject_reason = NULL,
                    processed_at = NOW()
                WHERE id = %s;
                """,
                (width, height, gps_present, full_key, thumb_key, image_id),
            )

            await cur.execute(
                """
                INSERT INTO outbox_events (
                    event_id, event_type, version, correlation_id, payload, occurred_at
                )
                VALUES (%s, %s, %s, %s, %s, %s);
                """,
                (
                    event_envelope["eventId"],
                    "image.processed",
                    1,
                    cid,
                    json.dumps(event_payload),
                    now_iso,
                ),
            )
        logger.info("Image %s successfully processed (ready)", image_id)

    async def _finalize_rejected(
        self,
        image_id: str,
        owner_id: str,
        incoming_key: str | None,
        reason: str,
        gps_present: bool,
    ) -> None:
        if incoming_key:
            try:
                await self.storage.delete_object(self.settings.INCOMING_BUCKET, incoming_key)
            except Exception as e:
                logger.debug("Failed deleting rejected incoming key %s: %s", incoming_key, e)

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        cid = str(uuid.uuid4())
        event_payload = {
            "imageId": image_id,
            "ownerId": owner_id,
            "status": "rejected",
            "width": None,
            "height": None,
            "gpsPresent": gps_present,
            "rejectReason": reason,
            "processedAt": now_iso,
        }
        event_envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "image.processed",
            "version": 1,
            "occurredAt": now_iso,
            "correlationId": cid,
            "payload": event_payload,
        }
        self.validator.validate_event("image.processed", 1, event_envelope)

        async with (
            self.pool.connection() as conn,
            conn.transaction(),
            conn.cursor() as cur,
        ):
            await cur.execute(
                """
                UPDATE images
                SET status = 'rejected',
                    reject_reason = %s,
                    gps_present = %s,
                    processed_at = NOW()
                WHERE id = %s;
                """,
                (reason, gps_present, image_id),
            )

            await cur.execute(
                """
                INSERT INTO outbox_events (
                    event_id, event_type, version, correlation_id, payload, occurred_at
                )
                VALUES (%s, %s, %s, %s, %s, %s);
                """,
                (
                    event_envelope["eventId"],
                    "image.processed",
                    1,
                    cid,
                    json.dumps(event_payload),
                    now_iso,
                ),
            )
        logger.info("Image %s rejected (reason=%s)", image_id, reason)

    async def run(self) -> None:
        """Worker main loop."""
        while self._running:
            try:
                job = await self.claim_job()
                if job:
                    await self.process_job(job)
                else:
                    await asyncio.sleep(self.poll_interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in image worker loop: %s", e)
                await asyncio.sleep(1.0)

    def start(self) -> None:
        """Start worker background task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        """Gracefully stop worker."""
        self._running = False
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        logger.info("Image worker stopped cleanly.")
