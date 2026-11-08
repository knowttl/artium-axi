ALTER TABLE tools ADD COLUMN raw_api_mode TEXT NOT NULL DEFAULT 'off' CHECK (raw_api_mode IN ('off', 'read', 'read-writes'));
ALTER TABLE role_tools ADD COLUMN raw_api INTEGER NOT NULL DEFAULT 0 CHECK (raw_api IN (0, 1));
UPDATE tools SET raw_api_mode = 'read'
  WHERE name IN ('gh-axi', 'az-axi', 'ado-axi', 'gitea-axi', 'mg-axi', 'vectra-axi', 'hybrid-axi');
UPDATE role_tools SET raw_api = 1
  WHERE tool IN ('gh-axi', 'az-axi', 'ado-axi', 'gitea-axi', 'mg-axi', 'vectra-axi', 'hybrid-axi');
