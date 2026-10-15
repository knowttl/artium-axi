ALTER TABLE identities ADD COLUMN claim_values TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(claim_values) AND json_type(claim_values) = 'object');
UPDATE identities SET claim_values = json_object('roles', json(role_claims));
ALTER TABLE identities DROP COLUMN role_claims;
