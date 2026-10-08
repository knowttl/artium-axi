ALTER TABLE tools ADD COLUMN updated_at INTEGER;
ALTER TABLE tools ADD COLUMN updated_by TEXT REFERENCES users(id);
ALTER TABLE credentials ADD COLUMN updated_at INTEGER;
ALTER TABLE credentials ADD COLUMN updated_by TEXT REFERENCES users(id);

CREATE TABLE tool_health (
  tool TEXT PRIMARY KEY REFERENCES tools(name),
  credential_revision INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code TEXT
);
