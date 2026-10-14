ALTER TABLE users ADD COLUMN archived_at INTEGER CHECK (archived_at IS NULL OR disabled = 1);
