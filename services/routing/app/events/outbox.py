"""Transactional outbox relay publisher using aio-pika with publisher confirms."""

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime

import aio_pika
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger("outbox")


class OutboxRelay:
    """Background polling worker for publishing outbox_events to RabbitMQ."""

    def __init__(
        self,
        pool: AsyncConnectionPool,
        rabbitmq_url: str,
        poll_interval: float = 0.5,
    ) -> None:
        """Initialize outbox relay."""
        self.pool = pool
        self.rabbitmq_url = rabbitmq_url
        self.poll_interval = poll_interval
        self._running = False
        self._task: asyncio.Task[None] | None = None
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractRobustChannel | None = None
        self._exchange: aio_pika.abc.AbstractRobustExchange | None = None

    async def connect_rabbitmq(self) -> None:
        """Establish robust connection and channel with publisher confirms."""
        self._connection = await aio_pika.connect_robust(self.rabbitmq_url)
        self._channel = await self._connection.channel(publisher_confirms=True)
        self._exchange = await self._channel.declare_exchange(
            "civic.events",
            type=aio_pika.ExchangeType.TOPIC,
            durable=True,
        )
        logger.info("Outbox relay connected to RabbitMQ (publisher confirms enabled)")

    async def is_connected(self) -> bool:
        """Check if AMQP channel is open and ready."""
        conn_ok = bool(self._connection and not self._connection.is_closed)
        chan_ok = bool(self._channel and not self._channel.is_closed)
        return conn_ok and chan_ok

    async def process_batch(self) -> int:
        """Poll and publish up to 50 pending outbox events inside transactions."""
        if not self._exchange:
            return 0

        published_count = 0
        async with (
            self.pool.connection() as conn,
            conn.transaction(),
            conn.cursor() as cur,
        ):
            await cur.execute("""
                SELECT id, event_id, event_type, version, correlation_id, payload, occurred_at
                FROM outbox_events
                WHERE published_at IS NULL
                ORDER BY occurred_at ASC
                LIMIT 50
                FOR UPDATE SKIP LOCKED;
            """)
            rows = await cur.fetchall()
            if not rows:
                return 0

            for row in rows:
                (
                    event_pk,
                    event_id,
                    event_type,
                    version,
                    correlation_id,
                    payload,
                    occurred_at,
                ) = row

                if isinstance(occurred_at, datetime):
                    occurred_at_dt = occurred_at.astimezone(UTC)
                else:
                    occurred_at_dt = datetime.fromisoformat(str(occurred_at)).astimezone(UTC)

                occurred_at_iso = occurred_at_dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
                epoch_seconds = int(occurred_at_dt.timestamp())

                payload_obj = json.loads(payload) if isinstance(payload, str) else payload

                envelope = {
                    "eventId": str(event_id),
                    "eventType": str(event_type),
                    "version": int(version),
                    "occurredAt": occurred_at_iso,
                    "correlationId": str(correlation_id),
                    "payload": payload_obj,
                }

                message = aio_pika.Message(
                    body=json.dumps(envelope).encode("utf-8"),
                    message_id=str(event_id),
                    type=str(event_type),
                    correlation_id=str(correlation_id),
                    content_type="application/json",
                    content_encoding="utf-8",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    timestamp=epoch_seconds,
                )

                await self._exchange.publish(message, routing_key=str(event_type))

                await cur.execute(
                    "UPDATE outbox_events SET published_at = NOW() WHERE id = %s;",
                    (event_pk,),
                )
                published_count += 1

        return published_count

    async def run(self) -> None:
        """Relay loop execution."""
        while self._running:
            try:
                count = await self.process_batch()
                if count == 0:
                    await asyncio.sleep(self.poll_interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Outbox relay error: %s", e)
                await asyncio.sleep(1.0)

    def start(self) -> None:
        """Start background relay worker task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        """Gracefully terminate relay worker task and close connections."""
        self._running = False
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

        if self._channel and not self._channel.is_closed:
            await self._channel.close()
        if self._connection and not self._connection.is_closed:
            await self._connection.close()
        logger.info("Outbox relay stopped cleanly.")
