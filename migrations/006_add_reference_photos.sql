-- Migration 006: Add Reference Photos Library
CREATE TABLE IF NOT EXISTS reference_photos (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    label VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reference_photos_label ON reference_photos(label);
