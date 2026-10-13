-- Migration: 0001_initial_notification_schema.sql
-- Notification service: recipients, report_index, notifications, and processed_events

CREATE TABLE IF NOT EXISTS recipients (
  user_id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  role VARCHAR(32) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS report_index (
  report_id UUID PRIMARY KEY,
  reporter_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL,
  kind TEXT NOT NULL,
  recipient_user_id UUID NULL,
  recipient_email VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  sent_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_notifications_event_kind UNIQUE (event_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_notifications_status_next_attempt
ON notifications (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id UUID NOT NULL,
  consumer VARCHAR(64) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, consumer)
);
