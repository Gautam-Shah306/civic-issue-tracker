"""Routing service lifecycle management."""

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI
from psycopg_pool import AsyncConnectionPool

from app.config import get_settings
from app.db import check_db_health, create_pool, set_global_pool
from app.events.consumer import ReportSubmittedConsumer
from app.events.outbox import OutboxRelay
from app.events.validator import get_event_validator
from app.logging import setup_logging

logger = logging.getLogger("lifecycle")


class ServiceLifecycle:
    """Manages background dependency startup, consumer worker, and graceful shutdown."""

    def __init__(self) -> None:
        """Initialize lifecycle state."""
        self.settings = get_settings()
        self.pool: AsyncConnectionPool | None = None
        self.outbox_relay: OutboxRelay | None = None
        self.consumer: ReportSubmittedConsumer | None = None
        self.bg_connect_task: asyncio.Task[None] | None = None
        self.db_ready = False
        self.amqp_ready = False

    async def _republish_categories_at_startup(self) -> None:
        """Republish all active categories as category.upserted at startup (D-045)."""
        if not self.pool:
            return
        validator = get_event_validator()
        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        cid = str(uuid.uuid4())

        try:
            async with self.pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
                await cur.execute("""
                    SELECT slug, name, department_code, active
                    FROM categories
                    WHERE active = true;
                """)
                rows = await cur.fetchall()

                for slug, name, dept_code, active in rows:
                    event_payload = {
                        "slug": slug,
                        "name": name,
                        "active": active,
                        "departmentCode": dept_code,
                        "updatedAt": now_iso,
                    }
                    event_envelope = {
                        "eventId": str(uuid.uuid4()),
                        "eventType": "category.upserted",
                        "version": 1,
                        "occurredAt": now_iso,
                        "correlationId": cid,
                        "payload": event_payload,
                    }
                    validator.validate_event("category.upserted", 1, event_envelope)

                    await cur.execute(
                        """
                        INSERT INTO outbox_events (
                            event_id, event_type, version, correlation_id, payload, occurred_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s);
                        """,
                        (
                            event_envelope["eventId"],
                            "category.upserted",
                            1,
                            cid,
                            json.dumps(event_payload),
                            now_iso,
                        ),
                    )
            logger.info("Republished %d active categories at startup.", len(rows))
        except Exception as e:
            logger.error("Failed to republish categories at startup: %s", e)

    async def _connect_with_backoff(self) -> None:
        """Connect to DB and RabbitMQ with exponential backoff."""
        backoff = 1.0
        max_backoff = 10.0

        while not (self.db_ready and self.amqp_ready):
            if not self.db_ready and self.pool:
                try:
                    await self.pool.open()
                    self.db_ready = True
                    logger.info("Database connection pool established successfully.")
                except Exception as e:
                    logger.warning("Database connection failed, will retry: %s", e)

            if not self.amqp_ready and self.outbox_relay and self.consumer and self.db_ready:
                try:
                    await self.outbox_relay.connect_rabbitmq()
                    self.outbox_relay.start()
                    await self.consumer.start()
                    self.amqp_ready = True
                    logger.info("RabbitMQ connected, consumer and outbox relay running.")
                    # Republish active categories once connected
                    await self._republish_categories_at_startup()
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
        self.consumer = ReportSubmittedConsumer(
            self.pool,
            self.settings.RABBITMQ_URL,
            delivery_limit=self.settings.DELIVERY_LIMIT,
        )

        self.bg_connect_task = asyncio.create_task(self._connect_with_backoff())

    async def stop(self) -> None:
        """Gracefully shutdown background tasks and connections."""
        logger.info("Shutting down %s ...", self.settings.SERVICE_NAME)
        if self.bg_connect_task and not self.bg_connect_task.done():
            self.bg_connect_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.bg_connect_task

        if self.consumer:
            await self.consumer.stop()

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
