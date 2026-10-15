CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY REFERENCES sso_providers(id),
  tool TEXT NOT NULL UNIQUE CHECK (tool = 'sso:' || id),
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL,
  authentication_tag BLOB NOT NULL CHECK (length(authentication_tag) = 16),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id)
);
