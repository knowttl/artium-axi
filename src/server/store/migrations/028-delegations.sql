CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  read_only INTEGER NOT NULL CHECK (read_only IN (0, 1)),
  single_use INTEGER NOT NULL CHECK (single_use IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES users(id),
  consumed_at INTEGER
);

ALTER TABLE session_families ADD COLUMN delegation_id TEXT REFERENCES delegations(id);
ALTER TABLE audit ADD COLUMN delegation_id TEXT REFERENCES delegations(id);

CREATE TABLE delegation_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minting_enabled INTEGER NOT NULL DEFAULT 0 CHECK (minting_enabled IN (0, 1)),
  max_lifetime_ms INTEGER NOT NULL DEFAULT 2592000000 CHECK (max_lifetime_ms > 0)
);
INSERT INTO delegation_settings (id) VALUES (1);
