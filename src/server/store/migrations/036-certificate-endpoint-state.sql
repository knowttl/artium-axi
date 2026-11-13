CREATE TABLE certificate_endpoint_state (
  credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  confirmed_leaf_pem TEXT,
  PRIMARY KEY (credential_id, endpoint)
);
