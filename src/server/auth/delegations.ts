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
const exactCommand = /^[^\s*]+(?: [^\s*]+)*$/

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

export function createDelegation(db: Database.Database, creatorId: string, input: z.infer<typeof createDelegationSchema>, adapters: readonly Adapter<unknown>[], id = randomUUID(), now = Date.now()) {
  const settings = db.prepare('SELECT minting_enabled, max_lifetime_ms FROM delegation_settings WHERE id = 1').get() as
    { minting_enabled: number, max_lifetime_ms: number }
  if (!settings.minting_enabled) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  if (input.expiresAt <= now || input.expiresAt - now > settings.max_lifetime_ms) throw new ArtiumError('INVALID_INPUT')
  const scope = { tools: input.scope.tools.map(item => {
    checkToolPolicy(db, creatorId, item.tool)
    if (!item.commands) return item
    const adapter = adapters.find(adapter => adapter.name === item.tool)
    if (!adapter) throw new ArtiumError('INVALID_INPUT')
    return { ...item, commands: item.commands.map(command => resolveDelegatedCommand(command, adapter)) }
  }) }
  const active = db.prepare('SELECT count(*) AS count FROM delegations WHERE creator_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .get(creatorId, now) as { count: number }
  if (active.count >= 20) throw new ArtiumError('TOO_MANY_CALLS')
  const token = `artd_${randomBytes(32).toString('base64url')}`
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, creatorId, hashToken(token), input.label, JSON.stringify(scope),
    Number(input.readOnly), Number(!input.reusable), now, input.expiresAt)
  return { id, token, expiresAt: input.expiresAt }
}

export function checkDelegation(scopeJson: string, readOnly: boolean, adapter: Adapter<unknown>, command: string, effect: 'read' | 'write') {
  const tool = adapter.name
  const scope = delegationScopeSchema.parse(JSON.parse(scopeJson))
  const grants = scope.tools.filter(item => item.tool === tool)
  const exact = grants.some(item => item.commands?.includes(command))
  const wide = grants.some(item => item.commands === undefined)
  const credentialCommand = exactCommands[tool]?.includes(command)
  const escapeHatch = escapeHatches[tool]?.includes(command)
  if ((!wide && !exact) || ((credentialCommand || escapeHatch || /^(?:api|native)(?: |$)/.test(command)) && !exact) || (readOnly && (effect !== 'read' || credentialCommand))) {
    throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  }
}

function commandRoutes(tool: ToolName) {
  type Route = { command: string, effect?: string, canonicalCommand?: string }
  const manifest = toolManifests[tool] as { commands: Route[], writeCommands?: Route[], workflows?: Route[] }
  return [...manifest.commands, ...manifest.writeCommands ?? [], ...manifest.workflows ?? []]
}

export function resolveDelegatedCommand(command: string, adapter: Adapter<unknown>): string {
  if (command.includes('*')) throw new ArtiumError('INVALID_INPUT', 'Wildcards are not supported yet.', 'Select exact commands or use --tool for tool-wide access.')
  if (!exactCommand.test(command)) throw new ArtiumError('INVALID_INPUT')
  const invocation = commandInvocations(adapter.name, command)[0]
  const resolved = classifyDelegatedCommand(adapter, [...invocation.split(' '), '--help']).command
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

export function authorizeDelegatedCall(db: Database.Database, userId: string,
  delegation: { scopeJson: string, readOnly: boolean }, adapter: Adapter<unknown>, args: readonly string[], input?: RunnerInput, continuationCommand?: string) {
  const classification = continuationCommand === undefined ? classifyDelegatedCommand(adapter, args, input)
    : { command: continuationCommand, effect: 'write' as const }
  if (adapter.kubernetesContinuation?.(args, input)?.help) {
    if (!delegatedDiscovery(db, userId, delegation, [adapter])[0]?.commands.includes(classification.command)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
    return []
  }
  const operations = [classification, ...(adapter.nestedOperations?.(args, input) ?? [])
    .map(operation => ({ ...operation, command: commandOperation(adapter.name, operation.command) }))]
  for (const operation of operations) authorizeDelegatedOperation(db, userId, delegation, adapter, operation)
  return operations
}

export function delegatedDiscoveryRequest(adapter: Adapter<unknown>, args: readonly string[], input?: RunnerInput): boolean {
  if (!args.length) return true
  const { command } = classifyDelegatedCommand(adapter, args, input)
  if (['home', 'help', 'commands', 'inventory'].includes(command)) return true
  return args.some(arg => ['--help', '-h'].includes(arg))
    && !commandRoutes(adapter.name).some(route => commandOperation(adapter.name, route.canonicalCommand ?? route.command) === command)
}

export function delegatedCommands(scopeJson: string, readOnly: boolean, adapter: Adapter<unknown>,
  authorize = (classification: { command: string, effect: 'read' | 'write' }) =>
    checkDelegation(scopeJson, readOnly, adapter, classification.command, classification.effect)): string[] {
  const tool = adapter.name
  const commands = commandRoutes(tool).flatMap(route => {
    if (!route.command || route.command === 'home' || route.effect === 'blocked') return []
    if (tool === 'kubernetes-axi' && ['preview', 'confirm'].includes(route.command)) return []
    const classification = classifyDelegatedCommand(adapter, route.command.split(' '))
    return commandInvocations(tool, route.command).flatMap(command => {
      try {
        adapter.validateArgs([...command.split(' '), '--help'])
        authorize(classification)
        return [command]
      }
      catch { return [] }
    })
  })
  if (tool === 'kubernetes-axi' && commands.some(command => command.startsWith('prepare -- '))) commands.push('preview', 'confirm')
  return [...new Set(commands)].sort()
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
