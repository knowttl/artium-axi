CREATE TABLE ssh_connection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  family_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  sudo INTEGER NOT NULL CHECK (sudo IN (0,1)),
  event TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  binding TEXT NOT NULL
);
CREATE INDEX ssh_connection_events_expiry ON ssh_connection_events(occurred_at);
CREATE INDEX ssh_execution_expiry ON ssh_executions(finished_at);
CREATE INDEX ssh_execution_results_expiry ON ssh_execution_results(updated_at);
