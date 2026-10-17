-- 0001_init.sql: Image service schema
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS images (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'ready', 'rejected')),
    content_type VARCHAR(100) NULL,
    size_bytes BIGINT NULL,
    width INT NULL,
    height INT NULL,
    gps_present BOOLEAN NOT NULL DEFAULT false,
    reject_reason VARCHAR(255) NULL,
    incoming_key VARCHAR(255) NOT NULL,
    full_key VARCHAR(255) NULL,
    thumb_key VARCHAR(255) NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    processed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_images_status_next_attempt
ON images (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_images_owner
ON images (owner_id);

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

CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished
ON outbox_events (occurred_at ASC)
WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID NOT NULL,
    consumer VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (event_id, consumer)
);
