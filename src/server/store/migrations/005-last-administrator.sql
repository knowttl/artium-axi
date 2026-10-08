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
