CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source = 'local'),
  must_change INTEGER NOT NULL DEFAULT 1 CHECK (must_change IN (0, 1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  administrator INTEGER NOT NULL DEFAULT 0 CHECK (administrator IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE role_tools (
  role_id TEXT NOT NULL REFERENCES roles(id),
  tool TEXT NOT NULL REFERENCES tools(name),
  PRIMARY KEY (role_id, tool)
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE session_families (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  reauthenticated_at INTEGER,
  UNIQUE (id, user_id)
);

CREATE TABLE tokens (
  hash TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('access', 'refresh', 'password-change')),
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  consumed_at INTEGER,
  FOREIGN KEY (family_id, user_id) REFERENCES session_families(id, user_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reauthenticated_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (family_id, user_id) REFERENCES session_families(id, user_id)
);

CREATE TABLE bootstrap_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bootstrapped_at INTEGER NOT NULL
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  event TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  tool TEXT REFERENCES tools(name),
  arguments TEXT,
  request_id TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  stdout_bytes INTEGER,
  stderr_bytes INTEGER,
  client_address TEXT,
  outcome TEXT NOT NULL
);
