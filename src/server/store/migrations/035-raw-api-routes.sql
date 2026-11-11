ALTER TABLE tools ADD COLUMN raw_api_routes TEXT CHECK (raw_api_routes IS NULL OR json_valid(raw_api_routes));
