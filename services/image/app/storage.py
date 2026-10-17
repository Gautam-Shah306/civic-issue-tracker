"""S3 object storage client using boto3 in async executor threads."""

import asyncio
import logging

import boto3
from botocore.client import BaseClient
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from app.config import Settings

logger = logging.getLogger("storage")


class S3Storage:
    """Async wrapper around boto3 S3 client using path-style addressing and sigv4."""

    def __init__(self, settings: Settings) -> None:
        """Initialize S3 client with path-style addressing and signature v4."""
        self.settings = settings
        boto_config = BotoConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
        )
        self.client: BaseClient = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT,
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            region_name=settings.AWS_REGION,
            config=boto_config,
        )

    async def ensure_buckets(self) -> None:
        """Ensure civic-incoming and civic-images buckets exist idempotently."""

        def _sync_ensure() -> None:
            for bucket in [self.settings.INCOMING_BUCKET, self.settings.IMAGES_BUCKET]:
                try:
                    self.client.head_bucket(Bucket=bucket)
                except ClientError as err:
                    code = err.response.get("Error", {}).get("Code")
                    if code in ("404", "NoSuchBucket", "NotFound"):
                        try:
                            self.client.create_bucket(Bucket=bucket)
                            logger.info("Created S3 bucket: %s", bucket)
                        except ClientError as create_err:
                            c_code = create_err.response.get("Error", {}).get("Code")
                            if c_code not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                                raise
                    else:
                        raise

        await asyncio.to_thread(_sync_ensure)

    async def check_health(self) -> bool:
        """Check S3 connectivity and bucket presence."""

        def _sync_check() -> bool:
            try:
                self.client.head_bucket(Bucket=self.settings.IMAGES_BUCKET)
                return True
            except Exception as e:
                logger.warning("S3 healthcheck failed: %s", e)
                return False

        return await asyncio.to_thread(_sync_check)

    async def put_bytes(self, bucket: str, key: str, data: bytes, content_type: str) -> None:
        """Upload raw bytes to S3."""

        def _sync_put() -> None:
            self.client.put_object(
                Bucket=bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )

        await asyncio.to_thread(_sync_put)

    async def get_bytes(self, bucket: str, key: str) -> bytes:
        """Download complete object from S3 as bytes."""

        def _sync_get() -> bytes:
            resp = self.client.get_object(Bucket=bucket, Key=key)
            return resp["Body"].read()

        return await asyncio.to_thread(_sync_get)

    async def delete_object(self, bucket: str, key: str) -> None:
        """Delete an object from S3."""

        def _sync_delete() -> None:
            self.client.delete_object(Bucket=bucket, Key=key)

        await asyncio.to_thread(_sync_delete)

    async def get_object_info(self, bucket: str, key: str) -> dict[str, str | int] | None:
        """Fetch head metadata for an object."""

        def _sync_head() -> dict[str, str | int] | None:
            try:
                resp = self.client.head_object(Bucket=bucket, Key=key)
                return {
                    "contentType": resp.get("ContentType", "application/octet-stream"),
                    "contentLength": resp.get("ContentLength", 0),
                    "etag": resp.get("ETag", ""),
                }
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code")
                if code in ("404", "NoSuchKey", "NotFound"):
                    return None
                raise

        return await asyncio.to_thread(_sync_head)


_storage: S3Storage | None = None


def get_storage(settings: Settings | None = None) -> S3Storage:
    """Retrieve global S3 storage singleton."""
    global _storage
    if _storage is None:
        if settings is None:
            from app.config import get_settings

            settings = get_settings()
        _storage = S3Storage(settings)
    return _storage
