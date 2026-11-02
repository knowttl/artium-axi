CREATE TABLE ssh_credentials (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL CHECK (tool = 'ssh-axi'),
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  authentication_tag BLOB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
CREATE TABLE ssh_hosts (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  approved_host_keys TEXT NOT NULL,
  allowed_addresses TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);
CREATE TABLE ssh_bindings (
  host_id TEXT NOT NULL REFERENCES ssh_hosts(id),
  username TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES ssh_credentials(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  sudo INTEGER NOT NULL DEFAULT 0 CHECK (sudo IN (0, 1)),
  PRIMARY KEY (host_id, sudo),
  UNIQUE (host_id, username),
  UNIQUE (host_id, credential_id)
);
CREATE TABLE ssh_grants (
  user_id TEXT NOT NULL REFERENCES users(id),
  host_id TEXT NOT NULL REFERENCES ssh_hosts(id),
  shell INTEGER NOT NULL DEFAULT 0 CHECK (shell IN (0, 1)),
  sudo INTEGER NOT NULL DEFAULT 0 CHECK (sudo IN (0, 1) AND sudo <= shell),
  PRIMARY KEY (user_id, host_id)
);
