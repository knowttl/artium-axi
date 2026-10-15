ALTER TABLE identities ADD COLUMN role_claims TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(role_claims) AND json_type(role_claims) = 'array');
ALTER TABLE identities ADD COLUMN claims_at INTEGER;
