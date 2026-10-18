CREATE TABLE trusted_certificates (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  leaf_fingerprint TEXT NOT NULL,
  pem TEXT NOT NULL,
  leaf_pem TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('pin', 'intermediate')),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE (credential_id, endpoint, leaf_fingerprint)
);
