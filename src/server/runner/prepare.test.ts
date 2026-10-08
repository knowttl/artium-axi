import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate } from '../store/db.js'
import { createFalconAdapter } from '../adapters/falcon.js'
import { SharedIdentityResolver } from '../policy/identity-resolver.js'
import { FakeCredentialStore } from '../../../test/fixtures/credential-store.js'
import { issueTestAccessToken } from '../../../test/fixtures/tokens.js'
import { prepareToolRun } from './prepare.js'

let db: Database.Database
let token: string
const getCredential = vi.fn(async () => ({ clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }))
const adapter = createFalconAdapter({ getCredential })
const resolver = new SharedIdentityResolver(new FakeCredentialStore([
  { reference: { id: 'synthetic-credential', tool: 'falcon-axi' }, value: {} },
]))

beforeEach(() => {
  getCredential.mockClear()
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash)
      VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash');
    INSERT INTO tools (name, enabled, pinned_version) VALUES ('falcon-axi', 1, '0.3.0');
    INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role');
    INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'falcon-axi');
  `)
  token = issueTestAccessToken(db, 'synthetic-user')
})
afterEach(() => { db.close() })

test.each([
  ['UPDATE users SET disabled = 1', 'USER_DISABLED'],
  ['UPDATE tools SET enabled = 0', 'TOOL_DISABLED'],
  ['DELETE FROM user_roles', 'TOOL_NOT_GRANTED'],
  ['UPDATE tokens SET revoked_at = 1', 'TOKEN_INVALID'],
])('run preparation denies before secret retrieval: %s', async (sql, code) => {
  db.exec(sql)
  await expect(prepareToolRun(db, token, [], adapter, resolver)).rejects.toMatchObject({ code })
  expect(getCredential).not.toHaveBeenCalled()
})

test('a role change denies the next preparation with the same token before retrieval', async () => {
  const result = await prepareToolRun(db, token, ['detection', 'list'], adapter, resolver)
  expect(result.userId).toBe('synthetic-user')
  expect(result.prepared.environment.FALCON_CLIENT_SECRET).toBe('CANARY-secret')
  expect(getCredential).toHaveBeenCalledTimes(1)
  db.exec('DELETE FROM role_tools')
  getCredential.mockClear()
  await expect(prepareToolRun(db, token, ['detection', 'list'], adapter, resolver)).rejects.toMatchObject({ code: 'TOOL_NOT_GRANTED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test('authorized preparation still rejects unsafe arguments before retrieval', async () => {
  await expect(prepareToolRun(db, token, ['--region=other'], adapter, resolver)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})
