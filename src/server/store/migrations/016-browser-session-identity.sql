ALTER TABLE sessions ADD COLUMN identity_id TEXT REFERENCES identities(id);
