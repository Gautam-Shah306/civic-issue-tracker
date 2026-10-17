"""RabbitMQ consumer for routing.report-submitted event queue."""

import json
import logging
import uuid
from datetime import UTC, datetime

import aio_pika
from psycopg_pool import AsyncConnectionPool

from app.events.validator import get_event_validator

logger = logging.getLogger("routing.consumer")

QUEUE_NAME = "routing.report-submitted"
DLQ_NAME = "routing.report-submitted.dlq"
EXCHANGE_NAME = "civic.events"
DLX_NAME = "civic.dlx"
ROUTING_KEY = "report.submitted"


class ReportSubmittedConsumer:
    """Idempotent consumer processing report.submitted events."""

    def __init__(
        self,
        pool: AsyncConnectionPool,
        rabbitmq_url: str,
        delivery_limit: int = 5,
    ) -> None:
        """Initialize consumer."""
        self.pool = pool
        self.rabbitmq_url = rabbitmq_url
        self.delivery_limit = delivery_limit
        self._running = False
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractRobustChannel | None = None
        self._queue: aio_pika.abc.AbstractRobustQueue | None = None
        self.validator = get_event_validator()

    async def setup_topology(self) -> None:
        """Declare exchanges, queues, DLQ, and bindings idempotently."""
        self._connection = await aio_pika.connect_robust(self.rabbitmq_url)
        self._channel = await self._connection.channel()
        await self._channel.set_qos(prefetch_count=10)

        # 1. Exchanges
        events_exchange = await self._channel.declare_exchange(
            EXCHANGE_NAME,
            type=aio_pika.ExchangeType.TOPIC,
            durable=True,
        )
        dlx_exchange = await self._channel.declare_exchange(
            DLX_NAME,
            type=aio_pika.ExchangeType.DIRECT,
            durable=True,
        )

        # 2. Dead-letter queue
        dlq = await self._channel.declare_queue(
            DLQ_NAME,
            durable=True,
            arguments={"x-queue-type": "quorum"},
        )
        await dlq.bind(dlx_exchange, routing_key=DLQ_NAME)

        # 3. Main quorum queue with DLQ routing
        self._queue = await self._channel.declare_queue(
            QUEUE_NAME,
            durable=True,
            arguments={
                "x-queue-type": "quorum",
                "x-delivery-limit": self.delivery_limit,
                "x-dead-letter-exchange": DLX_NAME,
                "x-dead-letter-routing-key": DLQ_NAME,
            },
        )
        await self._queue.bind(events_exchange, routing_key=ROUTING_KEY)
        logger.info("Declared RabbitMQ topology for %s", QUEUE_NAME)

    async def handle_message(self, message: aio_pika.abc.AbstractIncomingMessage) -> None:
        """Process incoming report.submitted message idempotently."""
        try:
            body_dict = json.loads(message.body.decode("utf-8"))
        except Exception:
            logger.warning("Unparseable JSON message in %s, rejecting to DLQ", QUEUE_NAME)
            await message.reject(requeue=False)
            return

        # Tolerant schema validation
        try:
            self.validator.validate_event("report.submitted", 1, body_dict)
        except Exception as e:
            logger.warning("Schema validation failed for report.submitted: %s, rejecting to DLQ", e)
            await message.reject(requeue=False)
            return

        event_id = body_dict["eventId"]
        correlation_id = body_dict["correlationId"]
        payload = body_dict["payload"]
        report_id = payload["reportId"]
        category_slug = payload["category"]
        lat = payload["location"]["lat"]
        lng = payload["location"]["lng"]

        try:
            async with (
                self.pool.connection() as conn,
                conn.transaction(),
                conn.cursor() as cur,
            ):
                # Inbox check: insert into processed_events
                await cur.execute(
                    """
                    INSERT INTO processed_events (event_id, consumer, processed_at)
                    VALUES (%s, %s, clock_timestamp())
                    ON CONFLICT (event_id, consumer) DO NOTHING;
                    """,
                    (event_id, QUEUE_NAME),
                )
                if cur.rowcount == 0:
                    logger.info("Event %s already processed by %s, skipping", event_id, QUEUE_NAME)
                    await message.ack()
                    return

                # Ward lookup: ST_Intersects on geography point, first active ward
                await cur.execute(
                    """
                    SELECT code, name FROM wards
                    WHERE active = true
                      AND ST_Intersects(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                    ORDER BY code ASC
                    LIMIT 1;
                    """,
                    (lng, lat),
                )
                ward_row = await cur.fetchone()
                ward_code = ward_row[0] if ward_row else None

                # Department lookup from category (active only)
                await cur.execute(
                    """
                    SELECT d.code, d.name, d.email
                    FROM categories c
                    JOIN departments d ON d.code = c.department_code
                    WHERE c.slug = %s AND c.active = true AND d.active = true;
                    """,
                    (category_slug,),
                )
                dept_row = await cur.fetchone()
                dept_code = dept_row[0] if dept_row else None
                dept_name = dept_row[1] if dept_row else None
                dept_email = dept_row[2] if dept_row else None

                # BOTH resolve: store assignment and outbox report.assigned
                if ward_code is not None and dept_code is not None:
                    await cur.execute(
                        """
                        INSERT INTO assignments (
                            report_id, ward_code, department_code, source, assigned_at
                        )
                        VALUES (%s, %s, %s, 'auto', NOW())
                        ON CONFLICT (report_id) DO UPDATE SET
                            ward_code = EXCLUDED.ward_code,
                            department_code = EXCLUDED.department_code,
                            source = EXCLUDED.source,
                            assigned_at = EXCLUDED.assigned_at;
                        """,
                        (report_id, ward_code, dept_code),
                    )

                    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
                    assigned_payload = {
                        "reportId": str(report_id),
                        "wardCode": ward_code,
                        "departmentCode": dept_code,
                        "departmentName": dept_name,
                        "departmentEmail": dept_email,
                        "source": "auto",
                        "assignedAt": now_iso,
                    }

                    assigned_event = {
                        "eventId": str(uuid.uuid4()),
                        "eventType": "report.assigned",
                        "version": 1,
                        "occurredAt": now_iso,
                        "correlationId": str(correlation_id),
                        "payload": assigned_payload,
                    }
                    self.validator.validate_event("report.assigned", 1, assigned_event)

                    await cur.execute(
                        """
                        INSERT INTO outbox_events (
                            event_id, event_type, version, correlation_id, payload, occurred_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s);
                        """,
                        (
                            assigned_event["eventId"],
                            "report.assigned",
                            1,
                            correlation_id,
                            json.dumps(assigned_payload),
                            now_iso,
                        ),
                    )
                    logger.info(
                        "Report %s assigned to %s / %s",
                        report_id,
                        ward_code,
                        dept_code,
                    )
                else:
                    logger.info(
                        "Report %s unassignable (ward=%s, dept=%s), left Submitted",
                        report_id,
                        ward_code,
                        dept_code,
                    )

            await message.ack()

        except Exception as e:
            logger.error("Transient error processing message in %s: %s", QUEUE_NAME, e)
            await message.reject(requeue=True)

    async def start(self) -> None:
        """Start consuming messages."""
        if self._running:
            return
        await self.setup_topology()
        self._running = True
        if self._queue is None:
            msg = "Queue not initialized"
            raise RuntimeError(msg)
        await self._queue.consume(self.handle_message)
        logger.info("Started consumer for %s", QUEUE_NAME)

    async def stop(self) -> None:
        """Stop consumer and release resources."""
        self._running = False
        if self._channel and not self._channel.is_closed:
            await self._channel.close()
        if self._connection and not self._connection.is_closed:
            await self._connection.close()
        logger.info("Stopped consumer for %s", QUEUE_NAME)
