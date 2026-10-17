"""Service lifecycle management: server starts first, dependencies connect with backoff."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from psycopg_pool import AsyncConnectionPool

from app.config import get_settings
from app.db import check_db_health, create_pool, set_global_pool
from app.events.outbox import OutboxRelay
from app.logging import setup_logging

logger = logging.getLogger("lifecycle")


class ServiceLifecycle:
    """Manages background dependency startup and graceful shutdown."""

    def __init__(self) -> None:
        """Initialize lifecycle state."""
        self.settings = get_settings()
        self.pool: AsyncConnectionPool | None = None
        self.outbox_relay: OutboxRelay | None = None
        self.bg_connect_task: asyncio.Task[None] | None = None
        self.db_ready = False
        self.amqp_ready = False

    async def _connect_with_backoff(self) -> None:
        """Connect to DB and RabbitMQ in background with backoff without blocking HTTP server."""
        backoff = 1.0
        max_backoff = 10.0

        while not (self.db_ready and self.amqp_ready):
            # Attempt DB connection
            if not self.db_ready and self.pool:
                try:
                    await self.pool.open()
                    self.db_ready = True
                    logger.info("Database connection pool established successfully.")
                except Exception as e:
                    logger.warning("Database connection failed, will retry: %s", e)

            # Attempt RabbitMQ connection
            if not self.amqp_ready and self.outbox_relay and self.db_ready:
                try:
                    await self.outbox_relay.connect_rabbitmq()
                    self.outbox_relay.start()
                    self.amqp_ready = True
                    logger.info("RabbitMQ connection established, outbox relay running.")
                except Exception as e:
                    logger.warning("RabbitMQ connection failed, will retry: %s", e)

            if not (self.db_ready and self.amqp_ready):
                await asyncio.sleep(backoff)
                backoff = min(backoff * 1.5, max_backoff)

    async def start(self) -> None:
        """Initialize server dependencies."""
        setup_logging(self.settings.SERVICE_NAME, self.settings.LOG_LEVEL)
        logger.info("Starting %s on port %s ...", self.settings.SERVICE_NAME, self.settings.PORT)

        self.pool = create_pool(self.settings)
        set_global_pool(self.pool)

        self.outbox_relay = OutboxRelay(self.pool, self.settings.RABBITMQ_URL)

        # Launch non-blocking background connection task
        self.bg_connect_task = asyncio.create_task(self._connect_with_backoff())

    async def stop(self) -> None:
        """Gracefully shutdown background tasks and connections."""
        logger.info("Shutting down %s ...", self.settings.SERVICE_NAME)
        if self.bg_connect_task and not self.bg_connect_task.done():
            self.bg_connect_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.bg_connect_task

        if self.outbox_relay:
            await self.outbox_relay.stop()

        if self.pool:
            await self.pool.close()
            logger.info("Database pool closed cleanly.")

    async def is_ready(self) -> tuple[bool, dict[str, bool]]:
        """Return readiness status requiring both DB and AMQP connectivity."""
        db_ok = await check_db_health(self.pool)
        amqp_ok = bool(self.outbox_relay and await self.outbox_relay.is_connected())
        ready = db_ok and amqp_ok
        return ready, {"database": db_ok, "rabbitmq": amqp_ok}


lifecycle = ServiceLifecycle()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    """FastAPI lifespan context manager for lifespan hooks."""
    await lifecycle.start()
    try:
        yield
    finally:
        await lifecycle.stop()
