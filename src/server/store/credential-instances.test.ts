import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createCredentialStore, openStore } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'
import type { MutableCredentialStore } from './credential-store.js'

const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
let directory: string
let db: Database.Database
let store: MutableCredentialStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-credential-instances-'))
  db = openStore(join(directory, 'artium.db'), provider)
  store = createCredentialStore(db, provider)
  db.exec("INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'unusable')")
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const create = (name: string, secret = `CANARY-${name}`) =>
  store.createInstance('falcon-axi', { name, description: `${name} description` }, { secret }, 'synthetic-user', 1000)

test('new instances start enabled and read-only and list in name order with their own secrets', () => {
  const production = create('production')
  const lab = create('lab')
  expect(store.listInstances('falcon-axi')).toEqual([
    { id: lab.id, tool: 'falcon-axi', name: 'lab', description: 'lab description', enabled: true, readOnly: true, revision: 1 },
    { id: production.id, tool: 'falcon-axi', name: 'production', description: 'production description', enabled: true, readOnly: true, revision: 1 },
  ])
  expect(store.readCredential(lab)).toEqual({ secret: 'CANARY-lab' })
  expect(store.readCredential(production)).toEqual({ secret: 'CANARY-production' })
  expect(store.listInstances('vectra-axi')).toEqual([])
})

test('an instance is found by tool and name only', () => {
  const lab = create('lab')
  expect(store.findInstance('falcon-axi', 'lab')).toEqual(lab)
  expect(store.findInstance('falcon-axi', 'missing')).toBeUndefined()
  expect(store.findInstance('vectra-axi', 'lab')).toBeUndefined()
})

test.each([
  ['an empty name', '', 'ok'],
  ['an uppercase name', 'Lab', 'ok'],
  ['a name starting with a hyphen', '-lab', 'ok'],
  ['a name with a space', 'my lab', 'ok'],
  ['a name with a trailing newline', 'lab\n', 'ok'],
  ['a name over 32 characters', 'a'.repeat(33), 'ok'],
  ['a description over 500 characters', 'lab', 'x'.repeat(501)],
])('create rejects %s', (_label, name, description) => {
  expect(() => store.createInstance('falcon-axi', { name, description }, {}, 'synthetic-user', 1000)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  expect(store.listInstances('falcon-axi')).toEqual([])
})

test('create refuses a name already used by the same tool but allows it on another tool', () => {
  create('lab')
  expect(() => create('lab')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(store.createInstance('vectra-axi', { name: 'lab', description: '' }, {}, 'synthetic-user', 1000).tool).toBe('vectra-axi')
})

test('replace changes only the named instance secret and revision and invalidates the old reference', () => {
  const lab = create('lab')
  const production = create('production')
  const replaced = store.replaceInstance('falcon-axi', 'lab', { secret: 'CANARY-replaced' }, lab.id, 1, 'synthetic-user', 2000)
  expect(replaced).toEqual({ ...lab, revision: 2 })
  expect(store.readCredential(replaced)).toEqual({ secret: 'CANARY-replaced' })
  expect(store.readCredential(lab)).toBeUndefined()
  expect(store.readCredential(production)).toEqual({ secret: 'CANARY-production' })
  expect(db.prepare('SELECT updated_at, updated_by FROM credentials WHERE id = ?').get(lab.id)).toEqual({ updated_at: 2000, updated_by: 'synthetic-user' })
})

test.each([
  ['replace', (id: string, revision: number, name: string) => store.replaceInstance('falcon-axi', name, {}, id, revision, 'synthetic-user', 2000)],
  ['set flags', (id: string, revision: number, name: string) => store.setInstanceFlags('falcon-axi', name, { enabled: false }, id, revision, 'synthetic-user', 2000)],
  ['delete', (id: string, revision: number, name: string) => store.deleteInstance('falcon-axi', name, id, revision)],
])('%s refuses a stale revision or a missing instance and changes nothing', (_label, act) => {
  const lab = create('lab')
  expect(() => act(lab.id, 2, 'lab')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(() => act(lab.id, 1, 'missing')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(store.listInstances('falcon-axi')).toEqual([lab])
  expect(store.readCredential(lab)).toEqual({ secret: 'CANARY-lab' })
})

test.each([
  ['replace', (id: string) => store.replaceInstance('falcon-axi', 'lab', { secret: 'CANARY-stale' }, id, 1, 'synthetic-user', 2000)],
  ['set flags', (id: string) => store.setInstanceFlags('falcon-axi', 'lab', { enabled: false }, id, 1, 'synthetic-user', 2000)],
  ['delete', (id: string) => store.deleteInstance('falcon-axi', 'lab', id, 1)],
])('%s refuses a reference to a deleted instance', (_label, act) => {
  const original = create('lab')
  store.deleteInstance('falcon-axi', 'lab', original.id, original.revision)
  const replacement = create('lab', 'CANARY-new')
  expect(() => act(original.id)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(store.findInstance('falcon-axi', 'lab')).toEqual(replacement)
  expect(store.readCredential(replacement)).toEqual({ secret: 'CANARY-new' })
})

test.each([
  [{ enabled: false }, { enabled: false, readOnly: true }],
  [{ readOnly: false }, { enabled: true, readOnly: false }],
  [{ enabled: false, readOnly: false }, { enabled: false, readOnly: false }],
  [{}, { enabled: true, readOnly: true }],
])('set flags %j changes only the given flags and bumps the revision', (flags, expected) => {
  const lab = create('lab')
  const production = create('production')
  expect(store.setInstanceFlags('falcon-axi', 'lab', flags, lab.id, 1, 'synthetic-user', 2000)).toEqual({ ...lab, ...expected, revision: 2 })
  expect(store.readCredential(lab)).toBeUndefined()
  expect(store.findInstance('falcon-axi', 'production')).toEqual(production)
})

test('delete removes the instance with its health and certificate trust and leaves its siblings', () => {
  const lab = create('lab')
  const production = create('production')
  db.exec(`INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status) VALUES ('${lab.id}', 'falcon-axi', 1, 2000, 'ok');
    INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
      VALUES ('synthetic-trust', '${lab.id}', 'https://synthetic.invalid', 'ca-fingerprint', 'leaf-fingerprint', 'ca-pem', 'leaf-pem', 'ca', 1000, 'synthetic-user')`)
  store.deleteInstance('falcon-axi', 'lab', lab.id, 1)
  expect(store.listInstances('falcon-axi')).toEqual([production])
  expect(db.prepare('SELECT count(*) AS count FROM tool_health').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT count(*) AS count FROM trusted_certificates').get()).toEqual({ count: 0 })
})

test('find credential returns the only instance and nothing once a tool has several', () => {
  expect(store.findCredential('falcon-axi')).toBeUndefined()
  const lab = create('lab')
  expect(store.findCredential('falcon-axi')).toEqual({ id: lab.id, tool: 'falcon-axi', revision: 1 })
  create('production')
  expect(store.findCredential('falcon-axi')).toBeUndefined()
})

test('replace credential still manages the only instance but refuses an ambiguous tool', () => {
  const created = store.replaceCredential('falcon-axi', { secret: 'CANARY-first' }, 0, 'synthetic-user', 1000)
  expect(store.findInstance('falcon-axi', 'default')).toMatchObject({ id: created.id, revision: 1 })
  expect(store.replaceCredential('falcon-axi', { secret: 'CANARY-second' }, 1, 'synthetic-user', 2000)).toEqual({ ...created, revision: 2 })
  create('lab')
  expect(() => store.replaceCredential('falcon-axi', {}, 2, 'synthetic-user', 3000)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})
