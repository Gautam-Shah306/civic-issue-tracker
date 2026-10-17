"""PostgreSQL connection pool management with psycopg 3 (no ORM)."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import psycopg
from psycopg_pool import AsyncConnectionPool

from app.config import Settings

_pool: AsyncConnectionPool | None = None


def create_pool(settings: Settings) -> AsyncConnectionPool:
    """Instantiate an un-opened AsyncConnectionPool."""
    return AsyncConnectionPool(
        conninfo=settings.postgres_dsn,
        min_size=1,
        max_size=10,
        open=False,
    )


def set_global_pool(pool: AsyncConnectionPool) -> None:
    """Set process global pool instance."""
    global _pool
    _pool = pool


def get_global_pool() -> AsyncConnectionPool:
    """Retrieve process global pool instance."""
    if _pool is None:
        raise RuntimeError("Database connection pool has not been initialized")
    return _pool


@asynccontextmanager
async def get_connection() -> AsyncGenerator[psycopg.AsyncConnection[Any]]:
    """Provide a connection from the global pool inside a context manager."""
    pool = get_global_pool()
    async with pool.connection() as conn:
        yield conn


async def check_db_health(pool: AsyncConnectionPool | None = None) -> bool:
    """Check connectivity to PostgreSQL database."""
    target_pool = pool or _pool
    if not target_pool:
        return False
    try:
        async with target_pool.connection() as conn, conn.cursor() as cur:
            await cur.execute("SELECT 1;")
            row = await cur.fetchone()
            return bool(row and row[0] == 1)
    except Exception:
        return False
