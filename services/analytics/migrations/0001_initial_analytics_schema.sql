-- Migration: 0001_initial_analytics_schema.sql
-- Analytics & Audit service schema: audit_log (immutable append-only), report_index, processed_events, and role privileges

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  version SMALLINT NOT NULL DEFAULT 1,
  correlation_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor TEXT NULL,
  subject_type TEXT NULL,
  subject_id TEXT NULL,
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_subject_id ON audit_log (subject_id);

-- Trigger function rejecting UPDATE, DELETE, and TRUNCATE on audit_log for every role
CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % operations are prohibited', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_mutation ON audit_log;
CREATE TRIGGER trg_audit_log_no_mutation
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION reject_audit_log_mutation();

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log;
CREATE TRIGGER trg_audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
EXECUTE FUNCTION reject_audit_log_mutation();

-- Read model report_index
CREATE TABLE IF NOT EXISTS report_index (
  report_id UUID PRIMARY KEY,
  category VARCHAR(50) NOT NULL,
  current_status VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id UUID NOT NULL,
  consumer VARCHAR(64) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, consumer)
);

-- Least privilege access grants
REVOKE ALL ON audit_log FROM PUBLIC;
REVOKE ALL ON report_index FROM PUBLIC;
REVOKE ALL ON processed_events FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civic_analytics_rw') THEN
    GRANT INSERT, SELECT ON audit_log TO civic_analytics_rw;
    GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO civic_analytics_rw;
    GRANT INSERT, SELECT, UPDATE ON report_index TO civic_analytics_rw;
    GRANT INSERT, SELECT ON processed_events TO civic_analytics_rw;
  END IF;
END $$;
