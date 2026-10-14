-- Migration: 0002_report_index_ordering_guard.sql
-- Add last_event_at column to report_index for out-of-order event protection

ALTER TABLE report_index ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ NULL;
