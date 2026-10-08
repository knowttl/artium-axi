import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate } from '../store/db.js'
import { checkToolPolicy } from './policy.js'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash, administrator)
      VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash', 1);
    INSERT INTO tools (name, enabled, pinned_version) VALUES ('falcon-axi', 1, '0.3.0');
    INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role');
    INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'falcon-axi');
  `)
})
afterEach(() => { db.close() })

test('enabled user with a tool grant is allowed', () => {
  expect(() => checkToolPolicy(db, 'synthetic-user', 'falcon-axi')).not.toThrow()
})

test.each([
  ['UPDATE users SET disabled = 1', 'USER_DISABLED'],
  ['UPDATE tools SET enabled = 0', 'TOOL_DISABLED'],
  ['DELETE FROM role_tools', 'TOOL_NOT_GRANTED'],
  ['DELETE FROM user_roles', 'TOOL_NOT_GRANTED'],
])('policy applies current state: %s', (sql, code) => {
  db.exec(sql)
  expect(() => checkToolPolicy(db, 'synthetic-user', 'falcon-axi')).toThrow(expect.objectContaining({ code }))
})

test('role grant removal and restoration apply on the next call', () => {
  checkToolPolicy(db, 'synthetic-user', 'falcon-axi')
  db.exec('DELETE FROM role_tools')
  expect(() => checkToolPolicy(db, 'synthetic-user', 'falcon-axi')).toThrow(expect.objectContaining({ code: 'TOOL_NOT_GRANTED' }))
  db.exec("INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'falcon-axi')")
  expect(() => checkToolPolicy(db, 'synthetic-user', 'falcon-axi')).not.toThrow()
})
