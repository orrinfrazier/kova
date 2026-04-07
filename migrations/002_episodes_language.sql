-- Add language column to episodes table for cross-repo language filtering.
-- Nullable for backwards compatibility with existing rows.

ALTER TABLE episodes ADD COLUMN IF NOT EXISTS language TEXT;

CREATE INDEX IF NOT EXISTS idx_episodes_language ON episodes (language);
