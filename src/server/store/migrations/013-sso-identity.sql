CREATE TABLE users_next (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'sso')),
  must_change INTEGER NOT NULL DEFAULT 1 CHECK (must_change IN (0, 1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  administrator INTEGER NOT NULL DEFAULT 0 CHECK (administrator IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER,
  updated_by TEXT REFERENCES users(id),
  archived_at INTEGER CHECK (archived_at IS NULL OR disabled = 1),
  CHECK ((source = 'local' AND password_hash IS NOT NULL) OR
    (source = 'sso' AND password_hash IS NULL AND must_change = 0))
);
INSERT INTO users_next SELECT * FROM users;
DROP TABLE users;
ALTER TABLE users_next RENAME TO users;

CREATE TRIGGER last_administrator_update BEFORE UPDATE OF administrator, disabled ON users
WHEN OLD.administrator = 1 AND OLD.disabled = 0
  AND (NEW.administrator = 0 OR NEW.disabled = 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE administrator = 1 AND disabled = 0 AND id != OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMINISTRATOR');
END;

CREATE TRIGGER last_administrator_delete BEFORE DELETE ON users
WHEN OLD.administrator = 1 AND OLD.disabled = 0
  AND NOT EXISTS (SELECT 1 FROM users WHERE administrator = 1 AND disabled = 0 AND id != OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMINISTRATOR');
END;

CREATE TABLE sso_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('entra', 'oidc')),
  issuer TEXT NOT NULL CHECK (length(issuer) > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER,
  updated_by TEXT REFERENCES users(id)
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider_id TEXT NOT NULL REFERENCES sso_providers(id),
  issuer TEXT NOT NULL CHECK (length(issuer) > 0),
  -- Entra subjects encode the immutable tid + oid pair; OIDC uses sub.
  subject TEXT NOT NULL CHECK (length(subject) > 0),
  created_at INTEGER NOT NULL,
  UNIQUE (provider_id, issuer, subject)
);

CREATE TABLE role_rules (
  id TEXT PRIMARY KEY CHECK (id != 'direct'),
  provider_id TEXT NOT NULL REFERENCES sso_providers(id),
  claim TEXT NOT NULL CHECK (length(claim) > 0),
  value TEXT NOT NULL CHECK (length(value) > 0),
  role_id TEXT NOT NULL REFERENCES roles(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER,
  updated_by TEXT REFERENCES users(id),
  UNIQUE (provider_id, claim, value, role_id),
  UNIQUE (id, role_id)
);

CREATE TABLE user_roles_next (
  user_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  origin TEXT NOT NULL DEFAULT 'direct',
  -- NULL exempts direct grants from the rule FK; rule grants must match its role.
  origin_rule_id TEXT GENERATED ALWAYS AS (nullif(origin, 'direct')) VIRTUAL,
  PRIMARY KEY (user_id, role_id, origin),
  FOREIGN KEY (origin_rule_id, role_id) REFERENCES role_rules(id, role_id)
);
INSERT INTO user_roles_next (user_id, role_id) SELECT user_id, role_id FROM user_roles;
DROP TABLE user_roles;
ALTER TABLE user_roles_next RENAME TO user_roles;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES sso_providers(id),
  expected_username TEXT NOT NULL CHECK (length(expected_username) > 0),
  display_name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  claimed_at INTEGER,
  revoked_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (claimed_at IS NULL OR user_id IS NOT NULL)
);

CREATE TABLE invitation_roles (
  invitation_id TEXT NOT NULL REFERENCES invitations(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (invitation_id, role_id)
);
