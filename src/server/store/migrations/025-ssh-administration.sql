ALTER TABLE ssh_hosts ADD COLUMN trust_verification TEXT NOT NULL DEFAULT '';
ALTER TABLE ssh_hosts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 1 CHECK (read_only IN (0, 1));
ALTER TABLE ssh_hosts ADD COLUMN command_seconds INTEGER NOT NULL DEFAULT 600 CHECK (command_seconds BETWEEN 1 AND 600);
ALTER TABLE ssh_hosts ADD COLUMN output_bytes INTEGER NOT NULL DEFAULT 65536 CHECK (output_bytes BETWEEN 0 AND 1048576);
ALTER TABLE ssh_hosts ADD COLUMN idle_minutes INTEGER NOT NULL DEFAULT 60 CHECK (idle_minutes BETWEEN 1 AND 60);
CREATE TABLE ssh_retired_revisions (
  kind TEXT NOT NULL CHECK (kind IN ('ssh_hosts', 'ssh_credentials')),
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (kind, id)
);
CREATE TRIGGER ssh_host_revision_retire BEFORE DELETE ON ssh_hosts BEGIN
  INSERT INTO ssh_retired_revisions VALUES ('ssh_hosts', OLD.id, OLD.revision)
    ON CONFLICT(kind, id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER ssh_credential_revision_retire BEFORE DELETE ON ssh_credentials BEGIN
  INSERT INTO ssh_retired_revisions VALUES ('ssh_credentials', OLD.id, OLD.revision)
    ON CONFLICT(kind, id) DO UPDATE SET revision=excluded.revision;
END;
