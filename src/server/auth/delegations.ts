import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { createDelegationSchema, delegationScopeSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { checkToolPolicy } from '../policy/policy.js'
import { hashToken, revokeFamily } from './tokens.js'
import proxmox from '../../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import kubernetes from '../../../tools/inventories/kubernetes-axi.json' with { type: 'json' }
import type { ToolName } from '../store/credential-store.js'
import { toolManifests } from '../../shared/tool-manifests.js'
import type { Adapter } from '../adapters/types.js'

const exactCommands: Partial<Record<ToolName, readonly string[]>> = {
  'awx-axi': ['user token-create'],
  'kubernetes-axi': ['create token'],
  'technitium-axi': ['user create-token', 'user create-single-use-token', 'admin session create-token',
    'settings backup', 'settings set', 'settings restore', 'admin cluster primary transfer-config'],
  'proxmox-axi': proxmox.commands.filter(command => command.privateResult).map(command => command.command),
}
const escapeHatches: Partial<Record<ToolName, readonly string[]>> = {
  'ado-axi': ['api'], 'az-axi': ['api'], 'gitea-axi': ['api'], 'gh-axi': ['api'],
  'hybrid-axi': ['api get'], 'mg-axi': ['api get'], 'vectra-axi': ['api get'],
  'kubernetes-axi': kubernetes.commands.map(command => command.command).filter(command => command.startsWith('native -- ')),
}

export function createDelegation(db: Database.Database, creatorId: string, input: z.infer<typeof createDelegationSchema>, id = randomUUID(), now = Date.now()) {
  const settings = db.prepare('SELECT minting_enabled, max_lifetime_ms FROM delegation_settings WHERE id = 1').get() as
    { minting_enabled: number, max_lifetime_ms: number }
  if (!settings.minting_enabled) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  if (input.expiresAt <= now || input.expiresAt - now > settings.max_lifetime_ms) throw new ArtiumError('INVALID_INPUT')
  for (const item of input.scope.tools) {
    checkToolPolicy(db, creatorId, item.tool)
    if (item.commands?.some(command => !/^(?:[a-z0-9-]+(?: [a-z0-9-]+)*(?: \*)?|\*)$/.test(command))) throw new ArtiumError('INVALID_INPUT')
  }
  const active = db.prepare('SELECT count(*) AS count FROM delegations WHERE creator_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .get(creatorId, now) as { count: number }
  if (active.count >= 20) throw new ArtiumError('TOO_MANY_CALLS')
  const token = `artd_${randomBytes(32).toString('base64url')}`
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, creatorId, hashToken(token), input.label, JSON.stringify(input.scope),
    Number(input.readOnly), Number(!input.reusable), now, input.expiresAt)
  return { id, token, expiresAt: input.expiresAt }
}

export function checkDelegation(scopeJson: string, readOnly: boolean, tool: ToolName, command: string, effect: 'read' | 'write') {
  const scope = delegationScopeSchema.parse(JSON.parse(scopeJson))
  const grants = scope.tools.filter(item => item.tool === tool)
  const operation = tool === 'kubernetes-axi' ? command.replace(/^(?:prepare|server-dry-run) -- /, '') : command
  const exact = grants.some(item => item.commands?.includes(operation))
  const wildcard = operation !== 'unknown' && grants.some(item => item.commands?.some(pattern => pattern === '*' || pattern.endsWith(' *') && operation.startsWith(pattern.slice(0, -1))))
  const wide = grants.some(item => item.commands === undefined)
  const credentialCommand = exactCommands[tool]?.includes(operation)
  const escapeHatch = escapeHatches[tool]?.includes(command)
  const tokenWorkflow = tool === 'kubernetes-axi' && ['preview', 'confirm'].includes(command)
    && grants.some(item => item.commands?.includes('create token'))
  if ((!wide && !exact && !wildcard && !tokenWorkflow) || ((credentialCommand || escapeHatch || /^(?:api|native)(?: |$)/.test(command)) && !exact) || (readOnly && (effect !== 'read' || credentialCommand))) {
    throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  }
}

function commandRoutes(tool: ToolName) {
  const manifest = toolManifests[tool] as { commands: { command: string, effect?: string }[], writeCommands?: { command: string, effect?: string }[], workflows?: { command: string, effect?: string }[] }
  return [...manifest.commands, ...manifest.writeCommands ?? [], ...manifest.workflows ?? []]
}

export function resolveDelegatedPattern(pattern: string, adapter: Adapter<unknown>): string {
  if (!/^(?:[a-z0-9-]+(?: [a-z0-9-]+)*(?: \*)?|\*)$/.test(pattern)) throw new ArtiumError('INVALID_INPUT')
  if (pattern === '*') return pattern
  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -1)
    const prefixes = new Set(commandRoutes(adapter.name).flatMap(route => {
      if (!route.command.startsWith(prefix)) return []
      const resolved = adapter.classify(route.command.split(' ')).command
      if (resolved === 'unknown' || resolved === 'home') return []
      const suffixLength = route.command.slice(prefix.length).split(' ').length
      return [resolved.split(' ').slice(0, -suffixLength).join(' ')]
    }))
    if (prefixes.size !== 1 || prefixes.has('')) throw new ArtiumError('INVALID_INPUT')
    return [...prefixes][0] + ' *'
  }
  const resolved = adapter.classify(pattern.split(' ')).command
  if (resolved === 'unknown' || resolved === 'home') throw new ArtiumError('INVALID_INPUT')
  return resolved
}

export function delegatedCommands(scopeJson: string, readOnly: boolean, adapter: Adapter<unknown>): string[] | undefined {
  const tool = adapter.name
  const grants = delegationScopeSchema.parse(JSON.parse(scopeJson)).tools.filter(item => item.tool === tool)
  if (grants.some(item => !item.commands)) return undefined
  return [...new Set(commandRoutes(tool).flatMap(route => {
    if (!route.command || route.command === 'home' || route.effect === 'blocked') return []
    const classification = adapter.classify(route.command.split(' '))
    try {
      adapter.validateArgs([...route.command.split(' '), '--help'])
      checkDelegation(scopeJson, readOnly, tool, classification.command, classification.effect)
      return [route.command]
    }
    catch { return [] }
  }))].sort()
}

export function delegationIncludesTool(scopeJson: string, tool: ToolName): boolean {
  return delegationScopeSchema.parse(JSON.parse(scopeJson)).tools.some(item => item.tool === tool)
}

export function credentialIssuingCommand(tool: ToolName, command: string): boolean {
  const operation = tool === 'kubernetes-axi' ? command.replace(/^(?:prepare|server-dry-run) -- /, '') : command
  return exactCommands[tool]?.includes(operation) ?? false
}

export function revokeDelegation(db: Database.Database, id: string, actorId: string, administrator: boolean, now = Date.now()) {
  const row = db.prepare('SELECT creator_id FROM delegations WHERE id = ?').get(id) as { creator_id: string } | undefined
  if (!row || (!administrator && row.creator_id !== actorId)) throw new ArtiumError('NOT_FOUND')
  db.prepare('UPDATE delegations SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(now, actorId, id)
  const families = db.prepare('SELECT id FROM session_families WHERE delegation_id = ? AND revoked_at IS NULL').all(id) as { id: string }[]
  for (const family of families) revokeFamily(db, family.id, now)
}
