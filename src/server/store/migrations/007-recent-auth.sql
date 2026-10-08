CREATE TABLE recent_auth_tickets (
  family_id TEXT PRIMARY KEY REFERENCES session_families(id),
  hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
