ALTER TABLE audit ADD COLUMN action TEXT;
ALTER TABLE audit ADD COLUMN target_id TEXT;
ALTER TABLE audit ADD COLUMN cutoff INTEGER;
ALTER TABLE audit ADD COLUMN deleted_count INTEGER;

CREATE INDEX audit_retention ON audit(occurred_at, id);
CREATE INDEX audit_request ON audit(request_id, event);
CREATE UNIQUE INDEX audit_run_start ON audit(request_id) WHERE event = 'run-start';
CREATE UNIQUE INDEX audit_run_terminal ON audit(request_id) WHERE event = 'run-terminal';
