-- 0003_photos.sql: Photos support for reports and out-of-order image tracking
CREATE TABLE IF NOT EXISTS images_seen (
    image_id UUID PRIMARY KEY,
    owner_id UUID NULL,
    status VARCHAR(32) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL,
    width INT NULL,
    height INT NULL,
    gps_present BOOLEAN NOT NULL DEFAULT FALSE,
    reject_reason VARCHAR(64) NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE images_seen ADD COLUMN IF NOT EXISTS owner_id UUID NULL;

CREATE TABLE IF NOT EXISTS report_photos (
    report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    image_id UUID NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    width INT NULL,
    height INT NULL,
    gps_present BOOLEAN NOT NULL DEFAULT FALSE,
    reject_reason VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (report_id, image_id)
);

CREATE INDEX IF NOT EXISTS idx_report_photos_image_id ON report_photos (image_id);
