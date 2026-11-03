CREATE TABLE ssh_executions (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Historical identity survives the session invalidation performed by restore.
  family_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  account TEXT NOT NULL,
  binding TEXT NOT NULL,
  command TEXT NOT NULL,
  sudo INTEGER NOT NULL CHECK (sudo IN (0, 1)),
  request_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'completed', 'failed', 'cancelled', 'timed_out', 'unknown')),
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ssh_execution_owner ON ssh_executions(user_id, family_id, started_at);
CREATE TABLE ssh_execution_results (
  id TEXT PRIMARY KEY REFERENCES ssh_executions(id) ON DELETE CASCADE,
  tool TEXT NOT NULL CHECK (tool = 'ssh-axi'),
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  authentication_tag BLOB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
