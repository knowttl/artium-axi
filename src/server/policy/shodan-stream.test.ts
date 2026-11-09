import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { issueTestAccessToken } from '../../../test/fixtures/tokens.js'
import { migrate } from '../store/db.js'
import { shodanBinding, shodanOwner, shodanScanBinding } from './shodan-stream.js'

let db: Database.Database
const credential = { id: 'synthetic-credential', tool: 'shodan-axi' as const, revision: 1 }
const settings = { sessions: { grants: { 'synthetic-user': ['OP-046'] }, perUser: 2, perCredential: 3, total: 4,
  sessionEvents: 10, totalEvents: 20, sessionBytes: 1024, totalBytes: 2048, retentionSeconds: 60, leaseSeconds: 900 } }
let owner: ReturnType<typeof shodanOwner>

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change)
      VALUES ('synthetic-user', 'synthetic-user', 'Synthetic', 'CANARY-hash', 0);
    INSERT INTO tools (name, enabled, pinned_version) VALUES ('shodan-axi', 1, '0.10.0');
    INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role');
    INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'shodan-axi');
    INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag)
      VALUES ('synthetic-credential', 'shodan-axi', 1, 'synthetic', zeroblob(12), x'00', zeroblob(16));`)
  db.prepare("UPDATE tools SET native_settings=? WHERE name='shodan-axi'").run(JSON.stringify(settings))
  const token = issueTestAccessToken(db, 'synthetic-user')
  owner = shodanOwner(db, { headers: { authorization: `Bearer ${token}` } })
})
afterEach(() => { db.close() })

test('session binding requires a matching administrator operation grant', () => {
  expect(shodanBinding(db, owner, credential, 'OP-046').settings).toEqual(settings.sessions)
  expect(() => shodanBinding(db, owner, credential, 'OP-047')).toThrow(expect.objectContaining({ code: 'TOOL_NOT_GRANTED' }))
})

test.each([
  ["UPDATE credentials SET revision=revision+1 WHERE tool='shodan-axi'", 'REVISION_CONFLICT'],
  ["UPDATE session_families SET revoked_at=1", 'TOKEN_INVALID'],
  ["DELETE FROM role_tools WHERE tool='shodan-axi'", 'TOOL_NOT_GRANTED'],
])('session binding rechecks current access after %s', (change, code) => {
  db.exec(change)
  expect(() => shodanBinding(db, owner, credential, 'OP-046')).toThrow(expect.objectContaining({ code }))
})

test('policy changes alter the session binding', () => {
  const prior = shodanBinding(db, owner, credential, 'OP-046').hash
  db.prepare("UPDATE tools SET native_settings=? WHERE name='shodan-axi'")
    .run(JSON.stringify({ sessions: { ...settings.sessions, sessionEvents: 9 } }))
  expect(shodanBinding(db, owner, credential, 'OP-046').hash).not.toBe(prior)
})

test('a binding names its instance and ignores changes to another instance', () => {
  db.exec(`INSERT INTO credentials (id, tool, name, schema_version, key_id, nonce, ciphertext, authentication_tag)
    VALUES ('other-credential', 'shodan-axi', 'other', 1, 'synthetic', zeroblob(12), x'00', zeroblob(16))`)
  const other = { ...credential, id: 'other-credential' }
  const prior = shodanBinding(db, owner, credential, 'OP-046')
  expect(prior.instance).toBe('default')
  expect(shodanBinding(db, owner, other, 'OP-046').instance).toBe('other')
  db.exec("UPDATE credentials SET revision=revision+1 WHERE id='other-credential'")
  db.exec("UPDATE tools SET revision=revision+1 WHERE name='shodan-axi'")
  expect(shodanBinding(db, owner, credential, 'OP-046').hash).toBe(prior.hash)
  expect(() => shodanBinding(db, owner, other, 'OP-046')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  db.exec("DELETE FROM credentials WHERE id='other-credential'")
  expect(shodanBinding(db, owner, credential, 'OP-046').hash).toBe(prior.hash)
})

test('session and scan bindings reject a revoked instance grant', () => {
  shodanBinding(db, owner, credential, 'OP-046')
  db.exec("UPDATE role_tools SET all_instances=0 WHERE tool='shodan-axi'")
  expect(() => shodanBinding(db, owner, credential, 'OP-046')).toThrow(expect.objectContaining({ code: 'INSTANCE_NOT_FOUND' }))
  expect(() => shodanScanBinding(db, owner, credential, [])).toThrow(expect.objectContaining({ code: 'INSTANCE_NOT_FOUND' }))
})
