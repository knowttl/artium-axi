import argon2 from 'argon2'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Audit } from '../audit/audit.js'
import { migrate } from '../store/db.js'
import { LocalAuthProvider, hashPassword } from './local.js'
import { verifyAccessToken } from './tokens.js'
import { issueTestAccessToken } from '../../../test/fixtures/tokens.js'

let db: Database.Database
let provider: LocalAuthProvider
const password = 'CANARY-local-password'

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  provider = new LocalAuthProvider(db)
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

async function account(mustChange = 1) {
  const hash = await hashPassword(password)
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, must_change) VALUES (?, ?, ?, ?, ?)')
    .run('synthetic-user', 'synthetic-user', 'Synthetic User', hash, mustChange)
  return hash
}

test.each(['short', '😀'.repeat(14), 'x'.repeat(129), '😀'.repeat(129), '123456789012345', 'passwordpassword'])
('rejects invalid or bundled common password %j', value => {
  expect(() => hashPassword(value)).toThrow(expect.objectContaining({ code: 'PASSWORD_INVALID' }))
})

test.each(['x'.repeat(15), 'x'.repeat(128), '😀'.repeat(15), '😀'.repeat(128), ' spaces remain ', 'e\u0301'.repeat(8)])
('hashes exact Unicode and space-preserving password %j', async value => {
  const hash = await hashPassword(value)
  expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/)
  expect(await argon2.verify(hash, value)).toBe(true)
  expect(await argon2.verify(hash, `${value}x`)).toBe(false)
})

test('must-change sign-in returns the internal identity through canonical username lookup', async () => {
  await account()
  expect(await provider.signIn(' Synthetic-USER ', password)).toEqual({ userId: 'synthetic-user', mustChange: true })
})

test('unknown and incorrect usernames perform the same-cost hash comparison and return the same failure', async () => {
  const hash = await account()
  const verify = vi.spyOn(argon2, 'verify')
  await expect(provider.signIn('unknown', password)).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' })
  const dummy = verify.mock.calls[0][0]
  expect(dummy).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/)
  await expect(provider.signIn('synthetic-user', 'CANARY-wrong-password')).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' })
  expect(verify.mock.calls[1][0]).toBe(hash)
})

test('disabled accounts cannot sign in', async () => {
  await account()
  db.exec('UPDATE users SET disabled = 1')
  await expect(provider.signIn('synthetic-user', password)).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' })
})

test('development accounts perform a dummy comparison and reject password sign-in', async () => {
  await account()
  db.exec("UPDATE users SET password_hash = 'unusable'")
  const verify = vi.spyOn(argon2, 'verify')
  await expect(provider.signIn('synthetic-user', password)).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' })
  expect(verify.mock.calls[0][0]).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/)
})

test('development accounts perform a dummy comparison and reject password change', async () => {
  await account()
  db.exec("UPDATE users SET password_hash = 'unusable'")
  const verify = vi.spyOn(argon2, 'verify')
  await expect(provider.changePassword('synthetic-user', password, 'CANARY-new-password', new Audit(db),
    { requestId: 'synthetic-change', clientAddress: null })).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' })
  expect(verify.mock.calls[0][0]).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/)
  expect(db.prepare('SELECT password_hash FROM users').get()).toEqual({ password_hash: 'unusable' })
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 0 })
})

test('hashing admission is shared by hashing and verification across providers and releases after failure', async () => {
  let finish!: (value: boolean) => void
  let fail!: (error: Error) => void
  vi.spyOn(argon2, 'verify')
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const first = provider.signIn('unknown', password)
  const second = new LocalAuthProvider(db).signIn('unknown', password)
  await expect(hashPassword(password)).rejects.toMatchObject({ code: 'AUTH_BUSY' })
  await expect(provider.signIn('unknown', password)).rejects.toMatchObject({ code: 'AUTH_BUSY' })
  const firstFailure = expect(first).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' })
  const secondFailure = expect(second).rejects.toThrow('synthetic failure')
  finish(false)
  fail(new Error('synthetic failure'))
  await Promise.all([firstFailure, secondFailure])
  expect(await hashPassword(password)).toMatch(/^\$argon2id\$/)
})

test('password change clears must-change and revokes every existing session with an internal-identity audit', async () => {
  await account()
  const token = issueTestAccessToken(db, 'synthetic-user')
  db.exec(`INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at)
    SELECT 'synthetic-browser', id, user_id, 'CANARY-csrf', created_at, created_at, expires_at FROM session_families`)
  await provider.changePassword('synthetic-user', password, 'CANARY-new-password', new Audit(db),
    { requestId: 'synthetic-change', clientAddress: '192.0.2.1' })
  expect(await provider.signIn('synthetic-user', 'CANARY-new-password')).toEqual({ userId: 'synthetic-user', mustChange: false })
  await expect(provider.signIn('synthetic-user', password)).rejects.toMatchObject({ code: 'SIGN_IN_FAILED' })
  expect(() => verifyAccessToken(db, token)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
  expect(db.prepare('SELECT revoked_at FROM sessions').get()).toEqual({ revoked_at: expect.any(Number) })
  expect(db.prepare('SELECT event, user_id, arguments, outcome FROM audit').all()).toEqual([
    { event: 'password-change', user_id: 'synthetic-user', arguments: null, outcome: 'success' },
  ])
})

test.each([
  ['CANARY-wrong-password', 'CANARY-new-password', 'SIGN_IN_FAILED'],
  [password, 'short', 'PASSWORD_INVALID'],
  [password, 'passwordpassword', 'PASSWORD_INVALID'],
])('failed password change preserves the hash and audit: %s', async (current, next, code) => {
  const hash = await account()
  await expect(provider.changePassword('synthetic-user', current, next, new Audit(db),
    { requestId: 'synthetic-change', clientAddress: null })).rejects.toMatchObject({ code })
  expect(db.prepare('SELECT password_hash, must_change FROM users').get()).toEqual({ password_hash: hash, must_change: 1 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 0 })
})

test('audit failure rolls back the password and revocations', async () => {
  const hash = await account()
  const token = issueTestAccessToken(db, 'synthetic-user')
  db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expect(provider.changePassword('synthetic-user', password, 'CANARY-new-password', new Audit(db),
    { requestId: 'synthetic-change', clientAddress: null })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
  expect(db.prepare('SELECT password_hash FROM users WHERE id = ?').get('synthetic-user')).toEqual({ password_hash: hash })
  expect(verifyAccessToken(db, token)).toBe('synthetic-user')
})
