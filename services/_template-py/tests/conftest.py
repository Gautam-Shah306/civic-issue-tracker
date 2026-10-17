import asyncio
import base64
import os
import sys
import time
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
    wait_for_logs(container, r"database system is ready to accept connections", timeout=30)
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
    wait_for_logs(container, r"Server startup complete", timeout=45)
    yield container
    container.stop()


@pytest.fixture
def test_settings(
    postgres_container: DockerContainer, rabbitmq_container: DockerContainer
) -> Settings:
    """Configure settings to point to testcontainers."""
    pg_host = postgres_container.get_container_host_ip()
    pg_port = int(postgres_container.get_exposed_port(5432))
    rabbit_host = rabbitmq_container.get_container_host_ip()
    rabbit_port = int(rabbitmq_container.get_exposed_port(5672))

    return Settings(
        SERVICE_NAME="template-py-test",
        DB_HOST=pg_host,
        DB_PORT=pg_port,
        DB_NAME="civic_test",
        DB_USER="test_user",
        DB_PASSWORD="test_pass",
        RABBITMQ_URL=f"amqp://guest:guest@{rabbit_host}:{rabbit_port}/",
        JWT_PUBLIC_KEY_B64=TEST_JWT_PUBLIC_KEY_B64,
        JWT_ISSUER="civic-auth",
        JWT_AUDIENCE="civic-api",
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

    lifecycle.settings = test_settings

    # Apply database migrations
    with psycopg.connect(test_settings.postgres_dsn) as conn:
        run_migrations(conn)

    pool = create_pool(test_settings)
    await pool.open()
    set_global_pool(pool)
    lifecycle.pool = pool

    app.dependency_overrides[get_settings] = lambda: test_settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
    await pool.close()
