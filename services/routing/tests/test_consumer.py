"""Consumer integration tests for routing service."""

import json
import uuid
from typing import Any

import psycopg
import pytest

from app.config import Settings
from app.db import create_pool
from app.events.consumer import ReportSubmittedConsumer
from app.events.validator import get_event_validator
from app.migrate import run_migrations


class MockIncomingMessage:
    """Mock aio_pika IncomingMessage for deterministic unit testing."""

    def __init__(self, body_dict: dict[str, Any] | str | bytes) -> None:
        if isinstance(body_dict, dict):
            self.body = json.dumps(body_dict).encode("utf-8")
        elif isinstance(body_dict, str):
            self.body = body_dict.encode("utf-8")
        else:
            self.body = body_dict
        self.acked = False
        self.rejected = False
        self.requeue: bool | None = None

    async def ack(self, multiple: bool = False) -> None:
        self.acked = True

    async def reject(self, requeue: bool = False) -> None:
        self.rejected = True
        self.requeue = requeue


def _make_report_submitted_event(
    report_id: str,
    lat: float = 23.01,
    lng: float = 72.48,
    category: str = "pothole",
) -> dict[str, Any]:
    return {
        "eventId": str(uuid.uuid4()),
        "eventType": "report.submitted",
        "version": 1,
        "occurredAt": "2026-10-14T10:00:00.000Z",
        "correlationId": str(uuid.uuid4()),
        "payload": {
            "reportId": report_id,
            "reporterId": str(uuid.uuid4()),
            "title": "Large pothole on main road",
            "description": "Hazardous road condition causing traffic congestion.",
            "category": category,
            "location": {"lat": lat, "lng": lng, "address": "123 Main St"},
            "submittedAt": "2026-10-14T10:00:00.000Z",
        },
    }


@pytest.mark.asyncio
async def test_consumer_topology_declaration(test_settings: Settings) -> None:
    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)
    try:
        await consumer.setup_topology()
    finally:
        await consumer.stop()
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_auto_assigns_valid_report(test_settings: Settings) -> None:
    with psycopg.connect(test_settings.postgres_dsn) as conn:
        run_migrations(conn)

    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)
    validator = get_event_validator()

    try:
        report_id = str(uuid.uuid4())
        event = _make_report_submitted_event(report_id, lat=23.01, lng=72.48, category="pothole")
        msg = MockIncomingMessage(event)

        await consumer.handle_message(msg)  # type: ignore[arg-type]
        assert msg.acked is True
        assert msg.rejected is False

        # Verify database effects
        async with pool.connection() as conn, conn.cursor() as cur:
            # 1. Processed events recorded
            await cur.execute(
                "SELECT consumer FROM processed_events WHERE event_id = %s;",
                (event["eventId"],),
            )
            pe_row = await cur.fetchone()
            assert pe_row is not None
            assert pe_row[0] == "routing.report-submitted"

            # 2. Assignment record created
            await cur.execute(
                "SELECT report_id, ward_code, department_code, source FROM assignments WHERE report_id = %s;",
                (report_id,),
            )
            asgn_row = await cur.fetchone()
            assert asgn_row is not None
            assert str(asgn_row[0]) == report_id
            assert asgn_row[1] == "W-R2C1"
            assert asgn_row[2] == "roads"
            assert asgn_row[3] == "auto"

            # 3. Exactly ONE report.assigned outbox row
            await cur.execute(
                "SELECT event_id, event_type, payload FROM outbox_events WHERE correlation_id = %s;",
                (event["correlationId"],),
            )
            outbox_rows = await cur.fetchall()
            assert len(outbox_rows) == 1
            outbox_row = outbox_rows[0]
            assert outbox_row[1] == "report.assigned"
            payload = json.loads(outbox_row[2]) if isinstance(outbox_row[2], str) else outbox_row[2]
            assert payload["reportId"] == report_id
            assert payload["wardCode"] == "W-R2C1"
            assert payload["departmentCode"] == "roads"
            assert payload["departmentName"] == "Roads & Infrastructure"
            assert payload["departmentEmail"] == "roads@civic.example.test"
            assert payload["source"] == "auto"
            assert "assignedAt" in payload

            # Validate against contract schema
            full_outbox_event = {
                "eventId": str(outbox_row[0]),
                "eventType": "report.assigned",
                "version": 1,
                "occurredAt": payload["assignedAt"],
                "correlationId": event["correlationId"],
                "payload": payload,
            }
            validator.validate_event("report.assigned", 1, full_outbox_event)
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_deduplicates_duplicate_event(test_settings: Settings) -> None:
    with psycopg.connect(test_settings.postgres_dsn) as conn:
        run_migrations(conn)

    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)

    try:
        report_id = str(uuid.uuid4())
        event = _make_report_submitted_event(report_id, lat=23.01, lng=72.48, category="garbage")

        msg1 = MockIncomingMessage(event)
        await consumer.handle_message(msg1)  # type: ignore[arg-type]
        assert msg1.acked is True

        # Count outbox events
        async with pool.connection() as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) FROM outbox_events WHERE correlation_id = %s;",
                (event["correlationId"],),
            )
            count1 = (await cur.fetchone())[0]
            assert count1 == 1

        # Second delivery of same event
        msg2 = MockIncomingMessage(event)
        await consumer.handle_message(msg2)  # type: ignore[arg-type]
        assert msg2.acked is True
        assert msg2.rejected is False

        # Count outbox events remains 1
        async with pool.connection() as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) FROM outbox_events WHERE correlation_id = %s;",
                (event["correlationId"],),
            )
            count2 = (await cur.fetchone())[0]
            assert count2 == 1
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_unassignable_location_outside_grid(test_settings: Settings) -> None:
    with psycopg.connect(test_settings.postgres_dsn) as conn:
        run_migrations(conn)

    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)

    try:
        report_id = str(uuid.uuid4())
        event = _make_report_submitted_event(report_id, lat=10.0, lng=10.0, category="pothole")
        msg = MockIncomingMessage(event)

        await consumer.handle_message(msg)  # type: ignore[arg-type]
        assert msg.acked is True
        assert msg.rejected is False

        async with pool.connection() as conn, conn.cursor() as cur:
            # Processed events recorded
            await cur.execute(
                "SELECT 1 FROM processed_events WHERE event_id = %s;", (event["eventId"],)
            )
            assert await cur.fetchone() is not None

            # No assignment
            await cur.execute("SELECT 1 FROM assignments WHERE report_id = %s;", (report_id,))
            assert await cur.fetchone() is None

            # No outbox event
            await cur.execute(
                "SELECT 1 FROM outbox_events WHERE correlation_id = %s;", (event["correlationId"],)
            )
            assert await cur.fetchone() is None
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_unassignable_unknown_category(test_settings: Settings) -> None:
    with psycopg.connect(test_settings.postgres_dsn) as conn:
        run_migrations(conn)

    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)

    try:
        report_id = str(uuid.uuid4())
        event = _make_report_submitted_event(
            report_id, lat=23.01, lng=72.48, category="non-existent-category"
        )
        msg = MockIncomingMessage(event)

        await consumer.handle_message(msg)  # type: ignore[arg-type]
        assert msg.acked is True
        assert msg.rejected is False

        async with pool.connection() as conn, conn.cursor() as cur:
            await cur.execute("SELECT 1 FROM assignments WHERE report_id = %s;", (report_id,))
            assert await cur.fetchone() is None
            await cur.execute(
                "SELECT 1 FROM outbox_events WHERE correlation_id = %s;", (event["correlationId"],)
            )
            assert await cur.fetchone() is None
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_invalid_json_rejected_to_dlq(test_settings: Settings) -> None:
    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)

    try:
        msg = MockIncomingMessage("invalid-not-json{{{")
        await consumer.handle_message(msg)  # type: ignore[arg-type]
        assert msg.acked is False
        assert msg.rejected is True
        assert msg.requeue is False
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_invalid_schema_rejected_to_dlq(test_settings: Settings) -> None:
    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)

    try:
        # Missing required fields
        invalid_event = {
            "eventId": str(uuid.uuid4()),
            "eventType": "report.submitted",
            "version": 1,
            "payload": {"foo": "bar"},
        }
        msg = MockIncomingMessage(invalid_event)
        await consumer.handle_message(msg)  # type: ignore[arg-type]
        assert msg.acked is False
        assert msg.rejected is True
        assert msg.requeue is False
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_missing_correlation_id_rejected_to_dlq(test_settings: Settings) -> None:
    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)

    try:
        report_id = str(uuid.uuid4())
        event = _make_report_submitted_event(report_id)
        del event["correlationId"]
        msg = MockIncomingMessage(event)
        await consumer.handle_message(msg)  # type: ignore[arg-type]
        assert msg.acked is False
        assert msg.rejected is True
        assert msg.requeue is False
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_consumer_extra_envelope_field_rejected_to_dlq(test_settings: Settings) -> None:
    pool = create_pool(test_settings)
    await pool.open()
    consumer = ReportSubmittedConsumer(pool, test_settings.RABBITMQ_URL)

    try:
        report_id = str(uuid.uuid4())
        event = _make_report_submitted_event(report_id)
        event["extraProhibitedField"] = "forbidden"
        msg = MockIncomingMessage(event)
        await consumer.handle_message(msg)  # type: ignore[arg-type]
        assert msg.acked is False
        assert msg.rejected is True
        assert msg.requeue is False
    finally:
        await pool.close()
