import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { createDelegationSchema, delegationScopeSchema, toolAllowsWrites } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { checkToolPolicy } from '../policy/policy.js'
import { hashToken, revokeFamily } from './tokens.js'
import proxmox from '../../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import kubernetes from '../../../tools/inventories/kubernetes-axi.json' with { type: 'json' }
import type { ToolName } from '../store/credential-store.js'
import { toolManifests } from '../../shared/tool-manifests.js'
import type { Adapter } from '../adapters/types.js'
import type { RunnerInput } from '../runner/input.js'

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
const commandPattern = /^(?:[^\s*]+(?: [^\s*]+)*(?: \*)?|\*)$/

function commandOperation(tool: ToolName, command: string): string {
  return tool === 'kubernetes-axi' ? command.replace(/^(?:prepare|server-dry-run) -- /, '') : command
}

export function classifyDelegatedCommand(adapter: Adapter<unknown>, args: readonly string[], input?: RunnerInput) {
  const classification = adapter.classify(args, input)
  return { ...classification, command: commandOperation(adapter.name, classification.command) }
}

function commandInvocations(tool: ToolName, command: string): string[] {
  return tool === 'kubernetes-axi' && kubernetes.writeCommands.some(route => route.command === command)
    ? [`prepare -- ${command}`, `server-dry-run -- ${command}`] : [command]
}

export function createDelegation(db: Database.Database, creatorId: string, input: z.infer<typeof createDelegationSchema>, id = randomUUID(), now = Date.now()) {
  const settings = db.prepare('SELECT minting_enabled, max_lifetime_ms FROM delegation_settings WHERE id = 1').get() as
    { minting_enabled: number, max_lifetime_ms: number }
  if (!settings.minting_enabled) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  if (input.expiresAt <= now || input.expiresAt - now > settings.max_lifetime_ms) throw new ArtiumError('INVALID_INPUT')
  for (const item of input.scope.tools) {
    checkToolPolicy(db, creatorId, item.tool)
    if (item.commands?.some(command => !commandPattern.test(command))) throw new ArtiumError('INVALID_INPUT')
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

export function checkDelegation(scopeJson: string, readOnly: boolean, adapter: Adapter<unknown>, command: string, effect: 'read' | 'write') {
  const tool = adapter.name
  const scope = delegationScopeSchema.parse(JSON.parse(scopeJson))
  const grants = scope.tools.filter(item => item.tool === tool)
  const exact = grants.some(item => item.commands?.includes(command))
  const wildcard = command !== 'unknown' && grants.some(item => item.commands?.some(pattern => pattern === '*'
    || pattern.endsWith(' *') && wildcardDescendants(pattern, adapter, command).some(item => item.command === command)))
  const wide = grants.some(item => item.commands === undefined)
  const credentialCommand = exactCommands[tool]?.includes(command)
  const escapeHatch = escapeHatches[tool]?.includes(command)
  const tokenWorkflow = tool === 'kubernetes-axi' && ['preview', 'confirm'].includes(command)
    && grants.some(item => item.commands?.includes('create token'))
  if ((!wide && !exact && !wildcard && !tokenWorkflow) || ((credentialCommand || escapeHatch || /^(?:api|native)(?: |$)/.test(command)) && !exact) || (readOnly && (effect !== 'read' || credentialCommand))) {
    throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  }
}

function commandRoutes(tool: ToolName) {
  const manifest = toolManifests[tool] as { commands: { command: string, effect?: string, canonicalCommand?: string }[], writeCommands?: { command: string, effect?: string, canonicalCommand?: string }[], workflows?: { command: string, effect?: string, canonicalCommand?: string }[] }
  return [...manifest.commands, ...manifest.writeCommands ?? [], ...manifest.workflows ?? []]
}

function wildcardDescendants(pattern: string, adapter: Adapter<unknown>, operation?: string) {
  const words = commandOperation(adapter.name, pattern.slice(0, -2)).split(' ')
  return commandRoutes(adapter.name).flatMap(route => {
    if (operation !== undefined && commandOperation(adapter.name, route.canonicalCommand ?? route.command) !== operation) return []
    const suffix = route.command.split(' ').slice(words.length)
    if (!suffix.length) return []
    return commandInvocations(adapter.name, route.command).flatMap(invocation => {
      const candidate = invocation.slice(0, -route.command.length) + [...words, ...suffix].join(' ')
      const resolved = classifyDelegatedCommand(adapter, [...candidate.split(' '), '--help']).command
      if (resolved === 'unknown' || resolved === 'home' || resolved !== classifyDelegatedCommand(adapter, route.command.split(' ')).command) return []
      const prefix = resolved.endsWith(' ' + suffix.join(' '))
        ? resolved.split(' ').slice(0, -suffix.length).join(' ') : words.join(' ')
      return [{ command: resolved, prefix }]
    })
  })
}

export function resolveDelegatedPattern(pattern: string, adapter: Adapter<unknown>): string {
  if (!commandPattern.test(pattern)) throw new ArtiumError('INVALID_INPUT')
  if (pattern === '*') return pattern
  if (pattern.endsWith(' *')) {
    const prefixes = new Set(wildcardDescendants(pattern, adapter).map(item => item.prefix))
    if (prefixes.size !== 1 || prefixes.has('')) throw new ArtiumError('INVALID_INPUT')
    return [...prefixes][0] + ' *'
  }
  const resolved = classifyDelegatedCommand(adapter, pattern.split(' ')).command
  if (resolved === 'unknown' || resolved === 'home') throw new ArtiumError('INVALID_INPUT')
  return resolved
}

export function authorizeDelegatedOperation(db: Database.Database, userId: string,
  delegation: { scopeJson: string, readOnly: boolean }, adapter: Adapter<unknown>,
  classification: { command: string, effect: 'read' | 'write' }) {
  checkToolPolicy(db, userId, adapter.name)
  checkDelegation(delegation.scopeJson, delegation.readOnly, adapter, classification.command, classification.effect)
  const row = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(adapter.name) as { native_settings: string }
  const settings = JSON.parse(row.native_settings)
  if (classification.effect === 'write' || credentialIssuingCommand(adapter.name, classification.command)) {
    if (!toolAllowsWrites(adapter.name, settings)) throw new ArtiumError('FLAG_BLOCKED')
    adapter.authorizeOperation?.(classification.command, settings)
  }
}

export function delegatedCommands(scopeJson: string, readOnly: boolean, adapter: Adapter<unknown>,
  authorize = (classification: { command: string, effect: 'read' | 'write' }) =>
    checkDelegation(scopeJson, readOnly, adapter, classification.command, classification.effect)): string[] {
  const tool = adapter.name
  return [...new Set(commandRoutes(tool).flatMap(route => {
    if (!route.command || route.command === 'home' || route.effect === 'blocked') return []
    const classification = classifyDelegatedCommand(adapter, route.command.split(' '))
    return commandInvocations(tool, route.command).flatMap(command => {
      try {
        adapter.validateArgs([...command.split(' '), '--help'])
        authorize(classification)
        return [command]
      }
      catch { return [] }
    })
  }))].sort()
}

export function delegatedDiscovery(db: Database.Database, userId: string, delegation: { scopeJson: string, readOnly: boolean }, adapters: readonly Adapter<unknown>[]) {
  return adapters.flatMap(adapter => {
    if (!delegationIncludesTool(delegation.scopeJson, adapter.name)) return []
    const row = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(adapter.name) as { native_settings: string }
    const readOnly = delegation.readOnly || !toolAllowsWrites(adapter.name, JSON.parse(row.native_settings))
    const commands = delegatedCommands(delegation.scopeJson, delegation.readOnly, adapter,
      classification => authorizeDelegatedOperation(db, userId, delegation, adapter, classification))
    return commands.length ? [{ adapter, readOnly, commands }] : []
  })
}

export function delegationIncludesTool(scopeJson: string, tool: ToolName): boolean {
  return delegationScopeSchema.parse(JSON.parse(scopeJson)).tools.some(item => item.tool === tool)
}

export function credentialIssuingCommand(tool: ToolName, command: string): boolean {
  return exactCommands[tool]?.includes(command) ?? false
}

export function revokeDelegation(db: Database.Database, id: string, actorId: string, administrator: boolean, now = Date.now()) {
  const row = db.prepare('SELECT creator_id FROM delegations WHERE id = ?').get(id) as { creator_id: string } | undefined
  if (!row || (!administrator && row.creator_id !== actorId)) throw new ArtiumError('NOT_FOUND')
  db.prepare('UPDATE delegations SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(now, actorId, id)
  const families = db.prepare('SELECT id FROM session_families WHERE delegation_id = ? AND revoked_at IS NULL').all(id) as { id: string }[]
  for (const family of families) revokeFamily(db, family.id, now)
}
