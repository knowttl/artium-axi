CREATE TABLE role_tool_instances (
  role_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, tool, credential_id),
  FOREIGN KEY (role_id, tool) REFERENCES role_tools(role_id, tool) ON DELETE CASCADE
);
