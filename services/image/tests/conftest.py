"""Pytest shared fixtures and test configuration for image service."""

import asyncio
import base64
import os
import sys
import time
import urllib.request
from collections.abc import AsyncGenerator, Generator

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import jwt
import psycopg
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from httpx import ASGITransport, AsyncClient
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs

from app.config import Settings, get_settings
from app.db import create_pool, set_global_pool
from app.lifecycle import lifecycle
from app.main import app
from app.migrate import run_migrations
from app.storage import S3Storage
from app.worker import ImageWorker
from tests.support.images import PINNED_IMAGES

# Generate ephemeral Ed25519 keypair for tests
_test_private_key = ed25519.Ed25519PrivateKey.generate()
_test_public_key = _test_private_key.public_key()
_test_pub_bytes = _test_public_key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
TEST_JWT_PUBLIC_KEY_B64 = base64.b64encode(_test_pub_bytes).decode("utf-8")


def generate_token(
    user_id: str, role: str, email: str | None = None, exp_offset: int = 3600
) -> str:
    """Generate signed EdDSA JWT for testing."""
    now = int(time.time())
    payload = {
        "sub": user_id,
        "role": role,
        "iss": "civic-auth",
        "aud": "civic-api",
        "iat": now,
        "exp": now + exp_offset,
    }
    if email:
        payload["email"] = email
    return jwt.encode(payload, _test_private_key, algorithm="EdDSA")


@pytest.fixture(scope="session")
def postgres_container() -> Generator[DockerContainer]:
    """Start digest-pinned postgis container."""
    container = (
        DockerContainer(PINNED_IMAGES["postgres"])
        .with_env("POSTGRES_USER", "test_user")
        .with_env("POSTGRES_PASSWORD", "test_pass")
        .with_env("POSTGRES_DB", "civic_test")
        .with_bind_ports(5432, None)
    )
    container.start()
    wait_for_logs(container, r"database system is ready to accept connections", timeout=60)
    yield container
    container.stop()


@pytest.fixture(scope="session")
def rabbitmq_container() -> Generator[DockerContainer]:
    """Start digest-pinned rabbitmq container."""
    container = (
        DockerContainer(PINNED_IMAGES["rabbitmq"])
        .with_env("RABBITMQ_DEFAULT_USER", "guest")
        .with_env("RABBITMQ_DEFAULT_PASS", "guest")
        .with_bind_ports(5672, None)
    )
    container.start()
    wait_for_logs(container, r"Server startup complete", timeout=90)
    yield container
    container.stop()


@pytest.fixture(scope="session")
def seaweedfs_container() -> Generator[DockerContainer]:
    """Start digest-pinned SeaweedFS container."""
    container = (
        DockerContainer(PINNED_IMAGES["seaweedfs"])
        .with_env("AWS_ACCESS_KEY_ID", "test")
        .with_env("AWS_SECRET_ACCESS_KEY", "test")
        .with_command("server -s3 -dir=/data")
        .with_bind_ports(8333, None)
    )
    container.start()
    host = container.get_container_host_ip()
    port = int(container.get_exposed_port(8333))
    url = f"http://{host}:{port}/"
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=1):  # noqa: S310
                break
        except Exception:
            time.sleep(0.5)
    yield container
    container.stop()


@pytest.fixture
def test_settings(
    postgres_container: DockerContainer,
    rabbitmq_container: DockerContainer,
    seaweedfs_container: DockerContainer,
) -> Settings:
    """Configure settings to point to testcontainers."""
    pg_host = postgres_container.get_container_host_ip()
    pg_port = int(postgres_container.get_exposed_port(5432))
    rabbit_host = rabbitmq_container.get_container_host_ip()
    rabbit_port = int(rabbitmq_container.get_exposed_port(5672))
    s3_host = seaweedfs_container.get_container_host_ip()
    s3_port = int(seaweedfs_container.get_exposed_port(8333))

    return Settings(
        SERVICE_NAME="image-test",
        DB_HOST=pg_host,
        DB_PORT=pg_port,
        DB_NAME="civic_test",
        DB_USER="test_user",
        DB_PASSWORD="test_pass",
        RABBITMQ_URL=f"amqp://guest:guest@{rabbit_host}:{rabbit_port}/",
        S3_ENDPOINT=f"http://{s3_host}:{s3_port}",
        AWS_ACCESS_KEY_ID="test",
        AWS_SECRET_ACCESS_KEY="test",
        AWS_REGION="us-east-1",
        INCOMING_BUCKET="civic-incoming",
        IMAGES_BUCKET="civic-images",
        JWT_PUBLIC_KEY_B64=TEST_JWT_PUBLIC_KEY_B64,
        JWT_ISSUER="civic-auth",
        JWT_AUDIENCE="civic-api",
        WORKER_POLL_INTERVAL=0.1,
    )


@pytest_asyncio.fixture
async def async_client(test_settings: Settings) -> AsyncGenerator[AsyncClient]:
    """Provide AsyncClient wired with lifecycle and test settings."""
    os.environ["JWT_PUBLIC_KEY_B64"] = test_settings.JWT_PUBLIC_KEY_B64
    os.environ["DB_HOST"] = test_settings.DB_HOST
    os.environ["DB_PORT"] = str(test_settings.DB_PORT)
    os.environ["DB_NAME"] = test_settings.DB_NAME
    os.environ["DB_USER"] = test_settings.DB_USER
    os.environ["DB_PASSWORD"] = test_settings.DB_PASSWORD
    os.environ["RABBITMQ_URL"] = test_settings.RABBITMQ_URL
    os.environ["S3_ENDPOINT"] = test_settings.S3_ENDPOINT
    os.environ["AWS_ACCESS_KEY_ID"] = test_settings.AWS_ACCESS_KEY_ID
    os.environ["AWS_SECRET_ACCESS_KEY"] = test_settings.AWS_SECRET_ACCESS_KEY

    lifecycle.settings = test_settings

    # Apply database migrations
    with psycopg.connect(test_settings.postgres_dsn) as conn:
        run_migrations(conn)

    pool = create_pool(test_settings)
    await pool.open()
    set_global_pool(pool)
    lifecycle.pool = pool

    # Set up storage and ensure buckets exist
    storage = S3Storage(test_settings)
    await storage.ensure_buckets()
    lifecycle.storage = storage

    # Set up worker
    worker = ImageWorker(pool, storage, test_settings)
    lifecycle.worker = worker

    app.dependency_overrides[get_settings] = lambda: test_settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
    await pool.close()
