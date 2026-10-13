# 03: Architecture and Communication

> **Status:** Approved · **Last updated:** 2026-10-13
> **Principle:** split by business capability; each service owns its data; keep the service count small enough to run on free-tier resources.

---

## 1. Services

| Service | Responsibility | Owns (data) |
|---|---|---|
| **API Gateway** | Single entry point: routing, JWT validation, rate limiting, CORS, correlation ID injection | None (stateless) |
| **Auth & User** | Registration, login, JWT issuing, roles, officer account creation, profiles, password reset | Users, credentials, roles |
| **Report** (core) | Report intake, **status state machine**, status history, comments, upvotes, duplicate detection, flagging and moderation | Reports, status history, comments, upvotes, outbox |
| **Image** | Upload, validation, resize, thumbnails, EXIF stripping, before/after photos | Image metadata and the object storage bucket |
| **Routing & Assignment** | Location to ward mapping, category to department mapping, officer assignment, priority scoring, SLA tracking and escalation, admin management of departments, wards, categories and SLA rules | Master data (wards, departments, categories, SLA rules), assignments |
| **Notification** | Email, in-app notifications, delivery retries (preferences are Optional) | Notifications (and preferences if built) |
| **Analytics & Audit** | Read-optimized public view and dashboard statistics, plus an **append-only audit log**, both built from events. **Kept as a separate service.** | Read models, audit log |
| **Frontend** | One responsive web app covering citizen, public, officer and admin views | None |

### Why these boundaries
- **Report** is the only owner of report state, so the status rules live in exactly one place (DAT-05).
- **Image** is separate because it is CPU-heavy and slow, so it scales and fails independently of intake.
- **Routing** is separate because its rules (wards, departments, SLAs) change for different reasons than the report lifecycle.
- **Analytics & Audit** is the read side: heavy public map and dashboard reads never slow report submission, and the audit trail is append-only and not editable by the services it records (OPS-01).

## 2. Communication

### Synchronous (REST over HTTP), only where the client needs an immediate answer
- Frontend to Gateway to the relevant service (login, submit report, list my reports, update status).
- Report to Image to get an upload URL or confirm an image exists (kept minimal).

### Asynchronous (events through RabbitMQ), for every workflow step and side effect

| Event | Published by | Consumed by |
|---|---|---|
| `ReportSubmitted` | Report | Image, Routing, Analytics & Audit |
| `ImageProcessed` | Image | Report, Routing |
| `ReportAssigned` | Routing | Report, Notification, Analytics & Audit |
| `StatusChanged` | Report | Notification, Analytics & Audit |
| `SLABreached` | Routing | Report, Notification, Analytics & Audit |
| `ReportReopened` / `ReportRejected` | Report | Routing, Notification, Analytics & Audit |
| `UserCreated` | Auth | Notification, Analytics & Audit |

**Event envelope (on every message):** event ID, event type, version, timestamp (UTC), correlation ID, payload.

### Main flow (choreography, no central coordinator)
1. The citizen submits a report. Report saves it as *Submitted* and publishes `ReportSubmitted`. The citizen gets an immediate acknowledgement.
2. Image processes the photos and publishes `ImageProcessed`.
3. Routing maps the ward and department, assigns the report, and publishes `ReportAssigned`.
4. Report moves the status to *Assigned* and publishes `StatusChanged`.
5. Notification emails the citizen and the officer. Analytics & Audit updates its read models and audit log.

If Image or Notification is down, events wait in the queue and are processed on recovery. The report is never lost (AVL-07).

## 3. Key design decisions

| Decision | Detail |
|---|---|
| **Database per service** | No service reads another's database. Needed data travels in events or API calls (DAT-01). |
| **Auth without a call per request** | The JWT carries user ID and role. The gateway and services verify it locally with the public key, so Auth is not a bottleneck or single point of failure. |
| **Reliable publishing (outbox pattern)** | The producing service writes the event to an outbox table in the same transaction as its data. A relay publishes it. No report exists without its event, and no event without its report. |
| **Idempotent consumers and a DLQ** | Duplicate or retried messages cannot create duplicates. Messages that keep failing go to a dead-letter queue (DAT-03, DAT-04). |
| **Versioned events with a shared envelope** | Every message follows the envelope above, and events are versioned. |
| **Master data access** | Report keeps a small local cache of categories, updated through events from Routing, so it can validate categories without a synchronous call. |
| **RabbitMQ topology** | Defined in `contracts/events/README.md` (D-036) |
| **Outbox relay** | Polling relay with `FOR UPDATE SKIP LOCKED` every 500 ms; idempotent consumers with an inbox table (D-036) |

## 4. Trade-offs accepted

- **Service count vs. free tier.** Eight deployables is heavy for free resources. Mitigated by running 2 replicas only on critical services (see `06`).
- **Eventual consistency.** A citizen may briefly see *Submitted* before *Assigned*. Accepted (DAT-02).
- **Choreography vs. orchestration.** Choreography is simpler and loosely coupled for this flow, but the end-to-end flow is harder to see in one place. The correlation ID and structured logging (OBS-01) are the mitigation.

## 5. Status transitions (D-040)

| From | To | Allowed |
|---|---|---|
| (new) | Submitted | citizen, officer, admin (creator) |
| Submitted | Verified | officer, admin |
| Submitted | Assigned | admin, system |
| Submitted | Rejected | officer, admin |
| Verified | Assigned | admin, system |
| Verified | Rejected | officer, admin |
| Assigned | In Progress | officer, admin |
| Assigned | Rejected | officer, admin |
| In Progress | Resolved | officer, admin |
| Resolved | Closed | admin, system |
| Resolved | Reopened | citizen (own report), admin |
| Closed | Reopened | citizen (own report), admin |
| Reopened | Assigned | admin, system |
| Reopened | In Progress | officer, admin |

Rejected is terminal. Rejection needs a reason code (duplicate, invalid, out_of_jurisdiction) and an optional note (STS-07). `system` transitions are made by event consumers (cycle 4) and are not callable through the API. Every transition writes a history row and publishes `report.status-changed`.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| JSON Schemas for the remaining events (the first three exist: D-036) | Phase 1, per feature |
| OpenAPI specs and endpoint lists per service | Phase 1 onward, per feature |
| Database schemas and migrations per service | Phase 1 onward, per feature |
| Gateway route table and rate-limit values | Phase 1 / Phase 4 |
| Whether Report keeps a local category cache from day one or starts with synchronous lookup | Phase 2 |
