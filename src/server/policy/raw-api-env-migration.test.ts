import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Audit } from '../audit/audit.js'
import { migrate } from '../store/db.js'
import { migrateAdoApiWritePaths } from './raw-api-env-migration.js'

let db: Database.Database
let audit: Audit
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare("INSERT INTO tools (name, enabled, pinned_version) VALUES ('ado-axi', 1, 'synthetic-version')").run()
  audit = new Audit(db, Date.now, () => {})
})
afterEach(() => { db.close() })

const stored = () => db.prepare("SELECT raw_api_routes AS routes, revision FROM tools WHERE name = 'ado-axi'").get()
const journal = () => db.prepare("SELECT user_id AS userId, action, target_id AS targetId, arguments FROM audit WHERE event = 'admin-change'").all()

test('the environment allow list becomes admin write routes once and is journaled', () => {
  const environment = { ARTIUM_AXI_ADO_API_WRITE_PATHS: '{"PATCH":["_apis/wit/workitems/*"],"DELETE":["_apis/projects/*"]}' }
  const before = stored() as { revision: number }
  expect(migrateAdoApiWritePaths(db, audit, environment)).toBe(true)
  expect(stored()).toEqual({ routes: JSON.stringify({ get: [], write: ['PATCH _apis/wit/workitems/*', 'DELETE _apis/projects/*'] }), revision: before.revision + 1 })
  expect(journal()).toEqual([{ userId: null, action: 'migrate-tool-raw-api-routes', targetId: 'ado-axi', arguments: JSON.stringify({ settings: [
    { path: ['rawApiRoutes', 'write'], added: ['PATCH _apis/wit/workitems/*', 'DELETE _apis/projects/*'], removed: [] }] }) }])
  expect(migrateAdoApiWritePaths(db, audit, environment)).toBe(false)
  expect(journal()).toHaveLength(1)
})

test('entries that never authorized a path are dropped', () => {
  const environment = { ARTIUM_AXI_ADO_API_WRITE_PATHS: '{"PATCH":["_apis/ok/*",7,"/leading","a/../b"],"GET":["_apis/read"],"post":["_apis/lower"]}' }
  expect(migrateAdoApiWritePaths(db, audit, environment)).toBe(true)
  expect(stored()).toMatchObject({ routes: JSON.stringify({ get: [], write: ['PATCH _apis/ok/*'] }) })
})

test.each(['{invalid', '[]', '"x"', '{}'])('environment value %s migrates to no write routes', value => {
  expect(migrateAdoApiWritePaths(db, audit, { ARTIUM_AXI_ADO_API_WRITE_PATHS: value })).toBe(true)
  expect(stored()).toMatchObject({ routes: JSON.stringify({ get: [], write: [] }) })
})

test('an unset environment value changes nothing', () => {
  const before = stored()
  expect(migrateAdoApiWritePaths(db, audit, {})).toBe(false)
  expect(stored()).toEqual(before)
  expect(journal()).toEqual([])
})

test('routes an administrator already saved are never replaced by the environment', () => {
  db.prepare("UPDATE tools SET raw_api_routes = '{\"get\":[],\"write\":[]}' WHERE name = 'ado-axi'").run()
  expect(migrateAdoApiWritePaths(db, audit, { ARTIUM_AXI_ADO_API_WRITE_PATHS: '{"PATCH":["_apis/wit/workitems/*"]}' })).toBe(false)
  expect(stored()).toMatchObject({ routes: '{"get":[],"write":[]}' })
})
