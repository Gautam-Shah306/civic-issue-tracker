-- Migration: 0003_report_index_routing.sql
-- Add ward_code, department_code, and assignment_event_at for routing indexing and aggregation

ALTER TABLE report_index ADD COLUMN IF NOT EXISTS ward_code VARCHAR(16) NULL;
ALTER TABLE report_index ADD COLUMN IF NOT EXISTS department_code VARCHAR(50) NULL;
ALTER TABLE report_index ADD COLUMN IF NOT EXISTS assignment_event_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_report_index_ward_code ON report_index (ward_code);
CREATE INDEX IF NOT EXISTS idx_report_index_department_code ON report_index (department_code);
