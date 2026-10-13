-- 0001_init.sql: Initial database schema for Report service
CREATE EXTENSION IF NOT EXISTS postgis;

-- categories: local copy of Routing master data until cycle 4
CREATE TABLE IF NOT EXISTS categories (
    slug VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO categories (slug, name, active) VALUES
    ('pothole', 'Pothole', true),
    ('garbage', 'Garbage', true),
    ('streetlight', 'Streetlight', true),
    ('water-leak', 'Water Leak', true)
ON CONFLICT (slug) DO NOTHING;

-- reports table
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL,
    title VARCHAR(120) NOT NULL,
    description VARCHAR(2000) NOT NULL,
    category_slug VARCHAR(50) NOT NULL REFERENCES categories(slug),
    lat DOUBLE PRECISION NOT NULL CHECK (lat >= -90 AND lat <= 90),
    lng DOUBLE PRECISION NOT NULL CHECK (lng >= -180 AND lng <= 180),
    address VARCHAR(300) NULL,
    geom geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
    status TEXT NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'Verified', 'Assigned', 'In Progress', 'Resolved', 'Closed', 'Rejected', 'Reopened')),
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_geom ON reports USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON reports (reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports (status, created_at DESC);

-- status_history table
CREATE TABLE IF NOT EXISTS status_history (
    id BIGSERIAL PRIMARY KEY,
    report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    from_status TEXT NULL,
    to_status TEXT NOT NULL,
    reason_code TEXT NULL,
    note TEXT NULL,
    changed_by TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_history_report ON status_history (report_id, changed_at ASC);

-- idempotency_keys table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id UUID NOT NULL,
    key VARCHAR(255) NOT NULL,
    report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, key)
);

-- outbox_events table (as in Auth)
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL UNIQUE,
    event_type VARCHAR(128) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    correlation_id UUID NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    published_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished
ON outbox_events (occurred_at ASC)
WHERE published_at IS NULL;

-- processed_events table (unused until cycle 4)
CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID NOT NULL,
    consumer VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (event_id, consumer)
);
