ALTER TABLE users ADD COLUMN break_glass INTEGER NOT NULL DEFAULT 0
  CHECK (break_glass IN (0, 1) AND (break_glass = 0 OR (source = 'local' AND administrator = 1)));
