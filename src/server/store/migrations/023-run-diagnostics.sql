CREATE TABLE run_diagnostics (
  request_id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  diagnostic TEXT NOT NULL CHECK (length(CAST(diagnostic AS BLOB)) <= 4096)
);
CREATE INDEX run_diagnostics_time ON run_diagnostics(occurred_at);
