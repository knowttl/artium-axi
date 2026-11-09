CREATE TABLE credentials_new (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL REFERENCES tools(name),
  name TEXT NOT NULL DEFAULT 'default' CHECK (name GLOB '[a-z0-9]*' AND length(name) BETWEEN 1 AND 32),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL,
  authentication_tag BLOB NOT NULL CHECK (length(authentication_tag) = 16),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER,
  updated_by TEXT REFERENCES users(id),
  UNIQUE (tool, name)
);
INSERT INTO credentials_new (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, revision, updated_at, updated_by)
  SELECT id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, revision, updated_at, updated_by FROM credentials;

CREATE TABLE tool_health_new (
  credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  tool TEXT NOT NULL REFERENCES tools(name),
  credential_revision INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code TEXT
);
INSERT INTO tool_health_new (credential_id, tool, credential_revision, checked_at, status, error_code)
  SELECT credentials_new.id, tool_health.tool, tool_health.credential_revision, tool_health.checked_at, tool_health.status, tool_health.error_code
  FROM tool_health JOIN credentials_new ON credentials_new.tool = tool_health.tool;

DROP TABLE tool_health;
DROP TABLE credentials;
ALTER TABLE credentials_new RENAME TO credentials;
ALTER TABLE tool_health_new RENAME TO tool_health;

ALTER TABLE role_tools ADD COLUMN all_instances INTEGER NOT NULL DEFAULT 1 CHECK (all_instances IN (0, 1));
ALTER TABLE audit ADD COLUMN credential_id TEXT;
ALTER TABLE audit ADD COLUMN instance TEXT;
