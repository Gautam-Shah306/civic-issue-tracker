# Event Messaging Contract (Phase 1)

This document specifies the messaging contract, AMQP properties, RabbitMQ topology, outbox relay, and idempotent consumer inbox pattern for the Civic Issue Tracker services, as decided in [D-036](../../docs/12-decision-log.md).

---

## (a) Envelope Fields and AMQP Properties

Every domain event published over AMQP follows the schema defined in [`envelope.v1.schema.json`](./envelope.v1.schema.json). The JSON envelope contains exactly six top-level fields:

1. `eventId` (UUID string, RFC 4122): Unique identifier of this event instance.
2. `eventType` (string): Hierarchical event name matching `^[a-z]+(\.[a-z]+(-[a-z]+)*)+$` (e.g., `user.created`, `report.submitted`, `report.status-changed`).
3. `version` (integer >= 1): Schema version of the payload contract.
4. `occurredAt` (ISO 8601 UTC string ending in `Z`): Timestamp when the business event occurred in the originating domain.
5. `correlationId` (UUID string, RFC 4122): End-to-end request correlation ID propagated across services and HTTP requests (`x-correlation-id`).
6. `payload` (JSON object): Domain-specific event payload matching the specific event schema.

### AMQP 0-9-1 Message Properties Mapping

When published to RabbitMQ, envelope metadata is mapped to standard AMQP message properties to allow routing, filtering, tracing, and broker-level guarantees without parsing the JSON payload:

| AMQP Property | Mapped Value | Description |
|---|---|---|
| `message_id` | `envelope.eventId` | Unique message identifier for broker and consumer tracing. |
| `type` | `envelope.eventType` | Event classification string for broker/consumer routing. |
| `correlation_id` | `envelope.correlationId` | Distributed trace correlation identifier. |
| `content_type` | `application/json` | MIME type of the payload body. |
| `content_encoding` | `utf-8` | Text encoding. |
| `delivery_mode` | `2` (Persistent) | Message persistence written to disk / quorum log. |
| `timestamp` | Unix epoch seconds of `occurredAt` | Message occurrence time. |

---

## (b) Versioning Rules

Event schemas evolve according to strict backward and forward compatibility rules:

1. **Additive (Non-Breaking) Changes:**
   - Adding optional fields to an existing event payload does not increment the major version.
   - Producers validate every event strictly against its schema before publishing. Consumers validate tolerantly: required fields and types must match, unknown properties are ignored (with Ajv, `removeAdditional: true` strips properties where `additionalProperties` is false).
   - Minor modifications stay within the existing version schema (`*.v1.schema.json`).
2. **Breaking Changes:**
   - Removing fields, renaming fields, altering types, or adding mandatory fields is a breaking change.
   - Breaking changes require creating a new schema file with an incremented major version (e.g., `report.submitted.v2.schema.json`) with `version: 2`.
   - Publishers emit the new version.
   - Consumers support multiple concurrent versions during transition periods until legacy versions are decommissioned.

---

## (c) Topology (RabbitMQ 4.3)

### Core Broker Architecture
- **Primary Exchange:** `civic.events`
  - Type: `topic`
  - Durability: `durable: true`
  - Auto-delete: `false`
  - Purpose: Decoupled pub/sub event exchange for all domain events across services.
- **Routing Key:** The event routing key matches `eventType` verbatim (e.g., `user.created`, `user.updated`, `report.submitted`, `report.assigned`, `report.status-changed`, `category.upserted`, `image.processed`).
- **Dead-Letter Exchange (DLX):** `civic.dlx`
  - Type: `direct`
  - Durability: `durable: true`
  - Auto-delete: `false`
  - Purpose: Routes poison messages and exhausted delivery messages to dead-letter queues.

### Phase 1 Queues
Each consumer service declares one quorum queue per business event flow that it consumes. For Phase 1 (Notification service):

1. **`notification.user-created`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `user.created`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `notification.user-created.dlq`
   - Delivery limit: `x-delivery-limit: 5`
2. **`notification.report-submitted`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `report.submitted`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `notification.report-submitted.dlq`
   - Delivery limit: `x-delivery-limit: 5`
3. **`notification.report-status-changed`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Bound to: `civic.events` with routing key `report.status-changed`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `notification.report-status-changed.dlq`
   - Delivery limit: `x-delivery-limit: 5`
4. **`notification.report-assigned`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `report.assigned`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `notification.report-assigned.dlq`
   - Delivery limit: `x-delivery-limit: 5`
5. **`routing.report-submitted`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `report.submitted`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `routing.report-submitted.dlq`
   - Delivery limit: `x-delivery-limit: 5`
6. **`report.report-assigned`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `report.assigned`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `report.report-assigned.dlq`
   - Delivery limit: `x-delivery-limit: 5`
7. **`report.category-upserted`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `category.upserted`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `report.category-upserted.dlq`
   - Delivery limit: `x-delivery-limit: 5`
8. **`analytics.stats`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing keys `report.submitted`, `report.status-changed`, and `report.assigned`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `analytics.stats.dlq`
   - Delivery limit: `x-delivery-limit: 5`
9. **`report.image-processed`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `image.processed`
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `report.image-processed.dlq`
   - Delivery limit: `x-delivery-limit: 5`
10. **`analytics.audit`**
   - Type: `quorum` (`x-queue-type: quorum`)
   - Durability: `durable: true`
   - Bound to: `civic.events` with routing key `#` (wildcard capturing all events, including `user.created`, `user.updated`, `report.submitted`, `report.assigned`, `report.status-changed`, `category.upserted`, `image.processed`)
   - Dead-letter exchange: `x-dead-letter-exchange: civic.dlx`
   - Dead-letter routing key: `analytics.audit.dlq`
   - Delivery limit: `x-delivery-limit: 5`

### Dead-Letter Queues (DLQ)
For each quorum queue, a corresponding dead-letter queue is declared:
- `notification.user-created.dlq` bound to `civic.dlx` with routing key `notification.user-created.dlq`.
- `notification.report-submitted.dlq` bound to `civic.dlx` with routing key `notification.report-submitted.dlq`.
- `notification.report-status-changed.dlq` bound to `civic.dlx` with routing key `notification.report-status-changed.dlq`.
- `notification.report-assigned.dlq` bound to `civic.dlx` with routing key `notification.report-assigned.dlq`.
- `routing.report-submitted.dlq` bound to `civic.dlx` with routing key `routing.report-submitted.dlq`.
- `report.report-assigned.dlq` bound to `civic.dlx` with routing key `report.report-assigned.dlq`.
- `report.category-upserted.dlq` bound to `civic.dlx` with routing key `report.category-upserted.dlq`.
- `report.image-processed.dlq` bound to `civic.dlx` with routing key `report.image-processed.dlq`.
- `analytics.stats.dlq` bound to `civic.dlx` with routing key `analytics.stats.dlq`.
- `analytics.audit.dlq` bound to `civic.dlx` with routing key `analytics.audit.dlq`.

### Broker Behavior & Reliability Controls
- **Publisher Confirms:** All publishers enable publisher confirms. A message is considered published only once the broker acknowledges receipt.
- **Consumer Prefetch:** Consumers configure channel prefetch count (e.g., prefetch count of 10) to balance throughput and prevent worker starvation.
- **Manual Acknowledgments:** Consumers use manual acks. A message is positively acknowledged (`basic.ack`) ONLY after the database transaction executing the consumer effect commits.
- **Poison Message & Negative Ack Handling:**
  - When consumer processing fails due to transient faults, the message is negatively acknowledged (`basic.reject` / `basic.nack` with `requeue: true`).
  - Quorum queues track the delivery count (`x-delivery-count`). When redeliveries reach `x-delivery-limit: 5`, RabbitMQ automatically routes the message to `civic.dlx` without further delivery attempts.
  - Complex retry back-off loops with delayed exchanges arrive in Phase 4.
- **Idempotent Declarations:** Each service declares its required exchanges, queues, and bindings idempotently at service startup.

### Documentation References (RabbitMQ 4.3)
- Quorum Queues: https://www.rabbitmq.com/docs/quorum-queues
- Dead Letter Exchanges: https://www.rabbitmq.com/docs/dlx
- Reliability & Publisher Confirms: https://www.rabbitmq.com/docs/confirms
- Consumer Acknowledgments: https://www.rabbitmq.com/docs/consumers

---

## (d) Outbox Table Specification & Relay Loop

To guarantee reliable at-least-once message delivery without distributed two-phase commit transactions, publishers use the **Transactional Outbox Pattern**.

### Outbox Table Schema (PostgreSQL)

```sql
CREATE TABLE IF NOT EXISTS outbox_events (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    event_type VARCHAR(100) NOT NULL,
    version SMALLINT NOT NULL DEFAULT 1,
    correlation_id UUID NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ NULL
);

-- Partial index for high-performance polling of unpublished rows:
CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished
ON outbox_events (occurred_at ASC)
WHERE published_at IS NULL;
```

### Relay Loop Execution

The outbox relay runs as an asynchronous background loop inside the owning service process (or companion runner):
1. **Polling Query:**
   Poll batches of up to 50 pending events using `FOR UPDATE SKIP LOCKED` to allow safe concurrent relay workers without contention:
   ```sql
   SELECT id, event_id, event_type, version, correlation_id, payload, occurred_at
   FROM outbox_events
   WHERE published_at IS NULL
   ORDER BY occurred_at ASC
   LIMIT 50
   FOR UPDATE SKIP LOCKED;
   ```
2. **Publishing with Confirms:**
   For each event:
   - Assemble the envelope conforming to `envelope.v1.schema.json`.
   - Publish to exchange `civic.events` with routing key equal to `event_type`.
   - Await publisher confirm from RabbitMQ.
3. **Commit Publication:**
   Upon confirm:
   ```sql
   UPDATE outbox_events
   SET published_at = NOW()
   WHERE id = $1;
   ```
4. **Relay Interval:** Polling runs on a configurable interval (default: 500 ms) when idle, or immediately loops if a full batch (50 items) was processed.

---

## (e) Inbox Table Specification (Idempotent Consumer)

Because network redeliveries and publisher re-sends produce at-least-once semantics, every consumer must be idempotent.

### Inbox Table Schema (PostgreSQL)

Each consuming service maintains a `processed_events` inbox table in its dedicated database:

```sql
CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID NOT NULL,
    consumer VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (event_id, consumer)
);
```

### Atomic Effect Execution

When a consumer receives a message:
1. Open a local database transaction.
2. Attempt to insert the event record into `processed_events`:
   ```sql
   INSERT INTO processed_events (event_id, consumer, processed_at)
   VALUES ($1, $2, clock_timestamp())
   ON CONFLICT (event_id, consumer) DO NOTHING;
   ```
3. If no row was inserted (conflict detected), the event has already been processed:
   - Roll back or finish the transaction.
   - Positively acknowledge (`ack`) the message to RabbitMQ to discard duplicate delivery.
4. If the row was inserted:
   - Execute the domain action (e.g., render email notification record).
   - Commit the database transaction.
   - Positively acknowledge (`ack`) the message to RabbitMQ.
5. If the transaction or external service fails:
   - Roll back the transaction.
   - Negatively acknowledge (`nack`/`reject` with requeue) to allow retry until `x-delivery-limit`.
