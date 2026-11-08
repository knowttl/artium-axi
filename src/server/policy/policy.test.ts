import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate } from '../store/db.js'
import type { Adapter } from '../adapters/types.js'
import { checkRawApiPolicy, checkToolPolicy } from './policy.js'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash, administrator)
      VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash', 1);
    INSERT INTO users (id, username, display_name, password_hash, administrator)
      VALUES ('synthetic-other-admin', 'synthetic-other-admin', 'Other Admin', 'unusable', 1);
    INSERT INTO tools (name, enabled, pinned_version) VALUES ('falcon-axi', 1, '0.6.0');
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
  ["UPDATE users SET disabled = 1 WHERE id = 'synthetic-user'", 'USER_DISABLED'],
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

const rawAdapter = (writes: boolean) => ({ name: 'falcon-axi', rawApi: { commands: ['api'], writes },
  classify: (args: readonly string[]) => ({ command: args[0], effect: args.includes('POST') ? 'write' : 'read' }) }) as unknown as Adapter<unknown>
const modeSql = (mode: string) => `UPDATE tools SET raw_api_mode = '${mode}' WHERE name = 'falcon-axi'`
const grantSql = "UPDATE role_tools SET raw_api = 1 WHERE tool = 'falcon-axi'"

test.each([
  ['a new tool and role grant', '', true, ['api', 'GET'], 'RAW_API_DENIED'],
  ['mode off with a role grant', grantSql, true, ['api', 'GET'], 'RAW_API_DENIED'],
  ['mode read and a role grant allows a read', `${modeSql('read')};${grantSql}`, true, ['api', 'GET'], undefined],
  ['mode read and a role grant denies a write', `${modeSql('read')};${grantSql}`, true, ['api', 'POST'], 'RAW_API_DENIED'],
  ['mode read-writes allows a write on a writes-capable adapter', `${modeSql('read-writes')};${grantSql}`, true, ['api', 'POST'], undefined],
  ['mode read-writes allows a read on a read-only adapter', `${modeSql('read-writes')};${grantSql}`, false, ['api', 'GET'], undefined],
  ['mode read-writes denies a write on a read-only adapter', `${modeSql('read-writes')};${grantSql}`, false, ['api', 'POST'], 'RAW_API_DENIED'],
  ['mode read without a role grant', modeSql('read'), true, ['api', 'GET'], 'RAW_API_DENIED'],
  ['mode off for a help request', '', true, ['api', '--help'], undefined],
  ['mode off for a request whose flag value is --help', '', true, ['api', '--body', '--help'], 'RAW_API_DENIED'],
  ['mode off for another command', '', true, ['status'], undefined],
])('raw API policy: %s', (_name, sql, writes, args, code) => {
  db.exec(sql)
  const check = () => checkRawApiPolicy(db, 'synthetic-user', rawAdapter(writes), args)
  if (code) expect(check).toThrow(expect.objectContaining({ code }))
  else expect(check).not.toThrow()
})

test('a raw route call the adapter cannot classify is treated as a write', () => {
  db.exec(`${modeSql('read')};${grantSql}`)
  const adapter = { name: 'falcon-axi', rawApi: { commands: ['api get'], writes: false },
    classify: () => ({ command: 'unknown', effect: 'write' }) } as unknown as Adapter<unknown>
  expect(() => checkRawApiPolicy(db, 'synthetic-user', adapter, ['api', 'get', 'malformed', '--bogus']))
    .toThrow(expect.objectContaining({ code: 'RAW_API_DENIED' }))
})

test('a raw API grant on any one role allows the call', () => {
  db.exec(`${modeSql('read')};
    INSERT INTO roles (id, name) VALUES ('second-role', 'Second Role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'second-role');
    INSERT INTO role_tools (role_id, tool, raw_api) VALUES ('second-role', 'falcon-axi', 1)`)
  expect(() => checkRawApiPolicy(db, 'synthetic-user', rawAdapter(true), ['api', 'GET'])).not.toThrow()
})
