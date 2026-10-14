-- Migration 0003: Add waiting_since column to track when recipient data was first found missing
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ NULL;

-- Index on waiting_since for queries/monitoring
CREATE INDEX IF NOT EXISTS idx_notifications_waiting_since ON notifications (waiting_since) WHERE status = 'pending';
