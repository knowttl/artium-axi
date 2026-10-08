ALTER TABLE audit ADD COLUMN checked_at INTEGER;
ALTER TABLE audit ADD COLUMN credential_revision INTEGER;
ALTER TABLE audit ADD COLUMN error_code TEXT;
