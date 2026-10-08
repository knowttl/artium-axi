CREATE TABLE tools (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  pinned_version TEXT NOT NULL,
  native_settings TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL UNIQUE REFERENCES tools(name),
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL,
  authentication_tag BLOB NOT NULL CHECK (length(authentication_tag) = 16),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);
