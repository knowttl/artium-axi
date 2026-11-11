import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Audit } from '../audit/audit.js'
import { diffSettings } from '../audit/settings-diff.js'
import { validateRawApiRoutes } from './raw-api.js'

const methods = ['POST', 'PATCH', 'PUT', 'DELETE']

export function migrateAdoApiWritePaths(db: Database.Database, audit: Audit, environment: NodeJS.ProcessEnv = process.env): boolean {
  const configured = environment.ARTIUM_AXI_ADO_API_WRITE_PATHS
  const row = db.prepare("SELECT raw_api_routes FROM tools WHERE name = 'ado-axi'").get() as { raw_api_routes: string | null } | undefined
  if (configured === undefined || !row || row.raw_api_routes !== null) return false
  let rules: unknown
  try { rules = JSON.parse(configured) } catch { rules = {} }
  const entries = rules && typeof rules === 'object' && !Array.isArray(rules) ? Object.entries(rules) : []
  const write = entries.filter(([method]) => methods.includes(method)).flatMap(([method, patterns]) =>
    (Array.isArray(patterns) ? patterns : []).flatMap((pattern: unknown) => {
      if (typeof pattern !== 'string') return []
      const entry = `${method} ${pattern}`
      try { validateRawApiRoutes({ get: [], write: [entry] }) } catch { return [] }
      return [entry]
    }))
  const routes = { get: [], write }
  audit.change({ event: 'admin-change', action: 'migrate-tool-raw-api-routes', targetId: 'ado-axi', userId: null, tool: 'ado-axi',
    outcome: 'success', requestId: randomUUID(), clientAddress: null, settingsChanges: diffSettings({ get: [], write: [] }, routes, ['rawApiRoutes']) }, () => {
    db.prepare("UPDATE tools SET raw_api_routes = ?, revision = revision + 1, updated_at = ? WHERE name = 'ado-axi'")
      .run(JSON.stringify(routes), Date.now())
  })
  return true
}
