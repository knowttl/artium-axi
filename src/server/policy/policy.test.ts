import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { migrate } from '../store/db.js'
import type { Adapter } from '../adapters/types.js'
import { createAzAdapter } from '../adapters/az.js'
import { createGhAdapter } from '../adapters/gh.js'
import { createAdoAdapter } from '../adapters/ado.js'
import { createGiteaAdapter } from '../adapters/gitea.js'
import { createMgAdapter } from '../adapters/mg.js'
import { createVectraAdapter } from '../adapters/vectra.js'
import { createHybridAdapter } from '../adapters/hybrid.js'
import { createTenableAdapter } from '../adapters/tenable.js'
import { createFalconAdapter } from '../adapters/falcon.js'
import { createAwxAdapter } from '../adapters/awx.js'
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

const source = { getCredential: async () => ({}) }
const log = join(process.cwd(), 'synthetic-policy.log')
const az = createAzAdapter(source, log)
const gh = createGhAdapter(source)
const mg = createMgAdapter(source, log)
const tenable = createTenableAdapter(source, log)
const falcon = createFalconAdapter(source, log)
const awx = createAwxAdapter(source)
const adapters: Adapter<unknown>[] = [az, gh, mg, createAdoAdapter(source), createGiteaAdapter(source, log),
  createVectraAdapter(source, log), createHybridAdapter(source, log), tenable, falcon, awx]

beforeEach(() => {
  for (const adapter of adapters) {
    db.prepare('INSERT OR IGNORE INTO tools (name, enabled, pinned_version) VALUES (?, 1, ?)').run(adapter.name, 'synthetic-version')
    db.prepare('INSERT OR IGNORE INTO role_tools (role_id, tool) VALUES (?, ?)').run('synthetic-role', adapter.name)
  }
})

test.each([
  ['a new tool and role grant', az, 'off', 0, ['api', 'GET', '/subscriptions'], 'RAW_API_DENIED'],
  ['mode off with a role grant', az, 'off', 1, ['api', 'GET', '/subscriptions'], 'RAW_API_DENIED'],
  ['mode read and a role grant allows a read', az, 'read', 1, ['api', 'GET', '/subscriptions'], undefined],
  ['mode read allows GET with execute', az, 'read', 1, ['api', 'GET', '/subscriptions', '--execute'], undefined],
  ['mode read allows GET with execute=true', az, 'read', 1, ['api', 'GET', '/subscriptions', '--execute=true'], undefined],
  ['mode read allows GET with execute=false', az, 'read', 1, ['api', 'GET', '/subscriptions', '--execute=false'], undefined],
  ['mode read allows a write preview', az, 'read', 1, ['api', 'PUT', '/subscriptions/synthetic'], undefined],
  ['mode read denies an executed write', az, 'read', 1, ['api', 'PUT', '/subscriptions/synthetic', '--execute'], 'RAW_API_DENIED'],
  ['mode read denies an executed Graph write', az, 'read', 1, ['api', 'POST', '/v1.0/directoryObjects/getByIds', '--resource=graph', '--execute'], 'RAW_API_DENIED'],
  ['mode read-writes allows an executed write', az, 'read-writes', 1, ['api', 'PUT', '/subscriptions/synthetic', '--execute'], undefined],
  ['mode read-writes allows a read-only route', gh, 'read-writes', 1, ['api', 'repos/synthetic/synthetic'], undefined],
  ['mode read-writes denies a write on a read-only adapter', gh, 'read-writes', 1, ['api', 'repos/synthetic/synthetic', '--method', 'POST'], 'RAW_API_DENIED'],
  ['mode read denies a Graph write', mg, 'read', 1, ['api', 'post', '/users', '--body', '{}'], 'RAW_API_DENIED'],
  ['mode read-writes allows a Graph write', mg, 'read-writes', 1, ['api', 'patch', '/users/synthetic', '--body', '{}', '--execute'], undefined],
  ['mode read-writes without a role grant denies a Graph write', mg, 'read-writes', 0, ['api', 'delete', '/users/synthetic'], 'RAW_API_DENIED'],
  ['mode read without a role grant', az, 'read', 0, ['api', 'GET', '/subscriptions'], 'RAW_API_DENIED'],
  ['mode off for a flag value of --help', gh, 'off', 0, ['api', 'repos/synthetic/synthetic', '--jq', '--help'], 'RAW_API_DENIED'],
  ['mode off for an inline flag value of --help', gh, 'off', 0, ['api', 'repos/synthetic/synthetic', '--jq=--help'], 'RAW_API_DENIED'],
  ['mode off for a path value of --help', adapters.find(adapter => adapter.name === 'vectra-axi')!, 'off', 0, ['api', 'get', '--path', '--help'], 'RAW_API_DENIED'],
  ['mode off for disabled help', az, 'off', 0, ['api', 'GET', '/subscriptions', '--help=false'], 'RAW_API_DENIED'],
  ['mode off for another command', az, 'off', 0, ['account', 'list'], undefined],
  ...([
    [tenable, ['raw', 'get', '--path', '/api/v1/t1/tags/properties'], ['raw', 'write', '--method', 'POST', '--path', '/api/v1/t1/tags']],
    [falcon, ['raw', 'get', '--path', '/synthetic/v1'], ['raw', 'write', '--method', 'POST', '--path', '/synthetic/v1']],
    [awx, ['api', 'get', 'jobs/'], ['api', 'post', 'jobs/1/cancel/', '--confirm']],
  ] as const).flatMap(([adapter, read, write]) => [
    [`${adapter.name} mode off denies a raw read`, adapter, 'off', 1, read, 'RAW_API_DENIED'],
    [`${adapter.name} mode read allows a raw read`, adapter, 'read', 1, read, undefined],
    [`${adapter.name} mode read denies a raw write`, adapter, 'read', 1, write, 'RAW_API_DENIED'],
    [`${adapter.name} mode read-writes without a role grant denies a raw write`, adapter, 'read-writes', 0, write, 'RAW_API_DENIED'],
    [`${adapter.name} mode read-writes allows a raw write`, adapter, 'read-writes', 1, write, undefined],
  ] as const),
] as const)('raw API policy: %s', (_name, adapter, mode, grant, args, code) => {
  db.prepare('UPDATE tools SET raw_api_mode = ? WHERE name = ?').run(mode, adapter.name)
  db.prepare('UPDATE role_tools SET raw_api = ? WHERE tool = ?').run(grant, adapter.name)
  const check = () => checkRawApiPolicy(db, 'synthetic-user', adapter, args)
  if (code) expect(check).toThrow(expect.objectContaining({ code }))
  else expect(check).not.toThrow()
})

test('a raw route call the adapter cannot classify is treated as a write', () => {
  db.prepare('UPDATE tools SET raw_api_mode = ? WHERE name = ?').run('read', mg.name)
  db.prepare('UPDATE role_tools SET raw_api = 1 WHERE tool = ?').run(mg.name)
  expect(() => checkRawApiPolicy(db, 'synthetic-user', mg, ['api', 'get', 'malformed', '--bogus', '--help']))
    .toThrow(expect.objectContaining({ code: 'RAW_API_DENIED' }))
})

test.each([
  ['gh-axi', ['api', '--help']],
  ['gh-axi', ['api', '-h']],
  ['gh-axi', ['api', 'repos/synthetic/synthetic', '--help']],
  ['az-axi', ['api', 'GET', '/subscriptions', '--help']],
  ['az-axi', ['api', 'GET', '/subscriptions', '-h']],
  ['ado-axi', ['api', '--help']],
  ['gitea-axi', ['api', '--help']],
  ['mg-axi', ['api', 'get', '/users', '--help']],
  ['vectra-axi', ['api', 'get', '--path', '/detections', '--help']],
  ['hybrid-axi', ['api', 'get', '/report', '--help']],
  ['tenable-axi', ['raw', 'get', '--help']],
  ['tenable-axi', ['raw', 'write', '--help']],
  ['falcon-axi', ['raw', 'get', '--help']],
  ['falcon-axi', ['raw', 'write', '--help']],
  ['awx-axi', ['api', 'get', '--help']],
  ['awx-axi', ['api', 'post', '--help']],
] as const)('%s local help %j needs no raw permission', (tool, args) => {
  const adapter = adapters.find(adapter => adapter.name === tool)!
  adapter.validateArgs(args)
  expect(() => checkRawApiPolicy(db, 'synthetic-user', adapter, args)).not.toThrow()
})

test('a raw API grant on any one role allows the call', () => {
  db.exec(`UPDATE tools SET raw_api_mode = 'read' WHERE name = 'az-axi';
    INSERT INTO roles (id, name) VALUES ('second-role', 'Second Role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'second-role');
    INSERT INTO role_tools (role_id, tool, raw_api) VALUES ('second-role', 'az-axi', 1)`)
  expect(() => checkRawApiPolicy(db, 'synthetic-user', az, ['api', 'GET', '/subscriptions'])).not.toThrow()
})

describe('instance grants', () => {
  beforeEach(() => {
    db.exec(`
      INSERT INTO credentials (id, tool, name, schema_version, key_id, nonce, ciphertext, authentication_tag)
        VALUES ('synthetic-lab', 'falcon-axi', 'lab', 1, 'k', zeroblob(12), x'00', zeroblob(16)),
               ('synthetic-production', 'falcon-axi', 'production', 1, 'k', zeroblob(12), x'00', zeroblob(16));
      INSERT INTO roles (id, name) VALUES ('synthetic-second-role', 'Second Role');
      INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-second-role', 'falcon-axi');
    `)
  })

  test.each([
    ['all instances', '', 'synthetic-production', undefined],
    ['listed instance', "UPDATE role_tools SET all_instances = 0; INSERT INTO role_tool_instances VALUES ('synthetic-role', 'falcon-axi', 'synthetic-lab')", 'synthetic-lab', undefined],
    ['unlisted instance', "UPDATE role_tools SET all_instances = 0; INSERT INTO role_tool_instances VALUES ('synthetic-role', 'falcon-axi', 'synthetic-lab')", 'synthetic-production', 'INSTANCE_NOT_FOUND'],
    ['selected scope without instances', 'UPDATE role_tools SET all_instances = 0', 'synthetic-lab', 'INSTANCE_NOT_FOUND'],
    ['instance of a role the user lacks', "UPDATE role_tools SET all_instances = 0; INSERT INTO role_tool_instances VALUES ('synthetic-role', 'falcon-axi', 'synthetic-lab'); INSERT INTO role_tool_instances VALUES ('synthetic-second-role', 'falcon-axi', 'synthetic-production')", 'synthetic-production', 'INSTANCE_NOT_FOUND'],
  ])('%s', (_name, setup, credentialId, code) => {
    db.exec(setup)
    const check = () => checkToolPolicy(db, 'synthetic-user', 'falcon-axi', credentialId)
    if (code) expect(check).toThrow(expect.objectContaining({ code }))
    else expect(check).not.toThrow()
  })

  test('grants add up across a user\'s roles', () => {
    db.exec(`UPDATE role_tools SET all_instances = 0;
      INSERT INTO role_tool_instances VALUES ('synthetic-role', 'falcon-axi', 'synthetic-lab');
      INSERT INTO role_tool_instances VALUES ('synthetic-second-role', 'falcon-axi', 'synthetic-production');
      INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-second-role')`)
    expect(() => checkToolPolicy(db, 'synthetic-user', 'falcon-axi', 'synthetic-lab')).not.toThrow()
    expect(() => checkToolPolicy(db, 'synthetic-user', 'falcon-axi', 'synthetic-production')).not.toThrow()
  })

  test('removing the tool from a role removes its instance grants', () => {
    db.exec(`UPDATE role_tools SET all_instances = 0 WHERE role_id = 'synthetic-role';
      INSERT INTO role_tool_instances VALUES ('synthetic-role', 'falcon-axi', 'synthetic-lab')`)
    db.exec("DELETE FROM role_tools WHERE role_id = 'synthetic-role'")
    expect(db.prepare('SELECT COUNT(*) AS n FROM role_tool_instances').get()).toEqual({ n: 0 })
  })
})
