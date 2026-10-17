-- 0001_init.sql: Schema for Routing and Assignment service (D-044, D-045)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Wards table with geometry polygons and GiST spatial index
CREATE TABLE IF NOT EXISTS wards (
    code VARCHAR(16) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    geom geometry(Polygon, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wards_geom ON wards USING GIST (geom);

-- Departments table
CREATE TABLE IF NOT EXISTS departments (
    code VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Categories table with department_code foreign key
CREATE TABLE IF NOT EXISTS categories (
    slug VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    department_code VARCHAR(50) NOT NULL REFERENCES departments(code),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Assignments table
CREATE TABLE IF NOT EXISTS assignments (
    report_id UUID PRIMARY KEY,
    ward_code VARCHAR(16) NULL REFERENCES wards(code),
    department_code VARCHAR(50) NULL REFERENCES departments(code),
    source VARCHAR(10) NOT NULL CHECK (source IN ('auto', 'manual')),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Transactional outbox table
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

-- Idempotent consumer inbox table
CREATE TABLE IF NOT EXISTS processed_events (
    event_id UUID NOT NULL,
    consumer VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (event_id, consumer)
);
