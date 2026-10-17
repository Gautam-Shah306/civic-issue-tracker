"""Report assignment and manual reassignment API routes."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from psycopg_pool import AsyncConnectionPool

from app.auth import UserClaims, require_role
from app.db import get_global_pool
from app.errors import AppError
from app.events.validator import get_event_validator
from app.logging import correlation_id_ctx
from app.models import AssignmentResponse, CreateAssignmentRequest, ReassignReportRequest

router = APIRouter(tags=["Assignments"])


def _make_cid() -> str:
    cid = correlation_id_ctx.get()
    return cid or str(uuid.uuid4())


async def _execute_assignment(
    report_id: str,
    department_code: str,
    ward_code: str | None,
) -> dict[str, Any]:
    pool: AsyncConnectionPool = get_global_pool()
    validator = get_event_validator()
    cid = _make_cid()

    async with pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
        # Validate departmentCode exists and is active
        await cur.execute(
            "SELECT code, name, email FROM departments WHERE code = %s AND active = true;",
            (department_code,),
        )
        dept_row = await cur.fetchone()
        if not dept_row:
            raise AppError(
                status_code=400,
                code="bad_request",
                message=f"Active department {department_code} not found",
            )

        dept_code, dept_name, dept_email = dept_row

        # Validate wardCode if provided
        if ward_code is not None:
            await cur.execute(
                "SELECT code FROM wards WHERE code = %s AND active = true;",
                (ward_code,),
            )
            if not await cur.fetchone():
                raise AppError(
                    status_code=400,
                    code="bad_request",
                    message=f"Active ward {ward_code} not found",
                )

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

        # Upsert assignment record with source = 'manual'
        await cur.execute(
            """
            INSERT INTO assignments (
                report_id, ward_code, department_code, source, assigned_at
            )
            VALUES (%s, %s, %s, 'manual', NOW())
            ON CONFLICT (report_id) DO UPDATE SET
                ward_code = EXCLUDED.ward_code,
                department_code = EXCLUDED.department_code,
                source = EXCLUDED.source,
                assigned_at = EXCLUDED.assigned_at
            RETURNING report_id, ward_code, department_code, source, assigned_at;
            """,
            (report_id, ward_code, dept_code),
        )
        asgn_row = await cur.fetchone()
        if asgn_row is None:
            raise AppError(
                status_code=500,
                code="internal_error",
                message="Failed to save assignment",
            )

        # Build and validate report.assigned event
        event_payload = {
            "reportId": str(report_id),
            "wardCode": ward_code,
            "departmentCode": dept_code,
            "departmentName": dept_name,
            "departmentEmail": dept_email,
            "source": "manual",
            "assignedAt": now_iso,
        }
        event_envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "report.assigned",
            "version": 1,
            "occurredAt": now_iso,
            "correlationId": cid,
            "payload": event_payload,
        }
        validator.validate_event("report.assigned", 1, event_envelope)

        await cur.execute(
            """
            INSERT INTO outbox_events (
                event_id, event_type, version, correlation_id, payload, occurred_at
            )
            VALUES (%s, %s, %s, %s, %s, %s);
            """,
            (
                event_envelope["eventId"],
                "report.assigned",
                1,
                cid,
                json.dumps(event_payload),
                now_iso,
            ),
        )

    assigned_at_str = (
        asgn_row[4].isoformat() if hasattr(asgn_row[4], "isoformat") else str(asgn_row[4])
    )
    return {
        "reportId": str(asgn_row[0]),
        "wardCode": asgn_row[1],
        "departmentCode": asgn_row[2],
        "source": asgn_row[3],
        "assignedAt": assigned_at_str,
    }


async def _fetch_assignment(report_id: str) -> dict[str, Any]:
    pool: AsyncConnectionPool = get_global_pool()
    async with pool.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT report_id, ward_code, department_code, source, assigned_at
            FROM assignments
            WHERE report_id = %s;
            """,
            (report_id,),
        )
        row = await cur.fetchone()
        if not row:
            raise AppError(
                status_code=404,
                code="not_found",
                message=f"Assignment for report {report_id} not found",
            )

    assigned_at_str = row[4].isoformat() if hasattr(row[4], "isoformat") else str(row[4])
    return {
        "reportId": str(row[0]),
        "wardCode": row[1],
        "departmentCode": row[2],
        "source": row[3],
        "assignedAt": assigned_at_str,
    }


@router.post("/assignments", response_model=AssignmentResponse, status_code=200)
async def create_or_reassign_assignment(
    payload: CreateAssignmentRequest,
    user: UserClaims = Depends(require_role("admin")),
) -> dict[str, Any]:
    """Manually assign or reassign a report (admin)."""
    return await _execute_assignment(
        report_id=str(payload.reportId),
        department_code=payload.departmentCode,
        ward_code=payload.wardCode,
    )


@router.get("/assignments/{report_id}", response_model=AssignmentResponse)
async def get_assignment_by_id(
    report_id: uuid.UUID,
    user: UserClaims = Depends(require_role("officer", "admin")),
) -> dict[str, Any]:
    """Retrieve current assignment details for a report."""
    return await _fetch_assignment(str(report_id))


@router.post("/reports/{report_id}/reassign", response_model=AssignmentResponse)
async def reassign_report(
    report_id: uuid.UUID,
    payload: ReassignReportRequest,
    user: UserClaims = Depends(require_role("admin")),
) -> dict[str, Any]:
    """Manually reassign a report to an active department and optional active ward."""
    return await _execute_assignment(
        report_id=str(report_id),
        department_code=payload.departmentCode,
        ward_code=payload.wardCode,
    )


@router.get("/reports/{report_id}", response_model=AssignmentResponse)
async def get_report_assignment(
    report_id: uuid.UUID,
    user: UserClaims = Depends(require_role("officer", "admin")),
) -> dict[str, Any]:
    """Retrieve current assignment details for a report (alias)."""
    return await _fetch_assignment(str(report_id))
