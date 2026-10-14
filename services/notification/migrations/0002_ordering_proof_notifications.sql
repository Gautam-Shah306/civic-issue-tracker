-- Migration 0002: Ordering-proof notifications schema adjustments
-- Make recipient_user_id, recipient_email, subject, body nullable so consumer can always store pending row before recipient data is known
ALTER TABLE notifications ALTER COLUMN recipient_user_id DROP NOT NULL;
ALTER TABLE notifications ALTER COLUMN recipient_email DROP NOT NULL;
ALTER TABLE notifications ALTER COLUMN subject DROP NOT NULL;
ALTER TABLE notifications ALTER COLUMN body DROP NOT NULL;

-- Add report_id (nullable) and data (jsonb)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS report_id UUID NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB NULL;

-- Index on report_id and index for lease queries
CREATE INDEX IF NOT EXISTS idx_notifications_report_id ON notifications (report_id);
CREATE INDEX IF NOT EXISTS idx_notifications_pending_next_attempt ON notifications (status, next_attempt_at) WHERE status = 'pending';
