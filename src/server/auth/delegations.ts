import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { createDelegationSchema, delegationScopeSchema, toolAllowsWrites, transferSelectionSchema, transferTool } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { checkToolPolicy, instanceGranted } from '../policy/policy.js'
import { hashToken, revokeFamily } from './tokens.js'
import proxmox from '../../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import kubernetes from '../../../tools/inventories/kubernetes-axi.json' with { type: 'json' }
import ssh from '../../../tools/inventories/ssh-axi.json' with { type: 'json' }
import type { ToolName } from '../store/credential-store.js'
import { toolManifests } from '../../shared/tool-manifests.js'
import type { Adapter } from '../adapters/types.js'
import type { RunnerInput } from '../runner/input.js'
import { kubernetesHostedRoutes } from '../../shared/kubernetes.js'
import { proxmoxHostedRoutes } from '../../shared/proxmox-commands.js'
import { authorizeKubernetesOwner } from '../policy/kubernetes.js'
import { checkTransferPolicy } from '../transfer.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'

const exactCommands: Partial<Record<ToolName, readonly string[]>> = {
  'awx-axi': ['user token-create'],
  'kubernetes-axi': ['create token'],
  'technitium-axi': ['user create-token', 'user create-single-use-token', 'admin session create-token',
    'settings backup', 'settings set', 'settings restore', 'admin cluster primary transfer-config'],
  'proxmox-axi': [...proxmox.commands, ...proxmox.streamCommands].filter(command => command.privateResult).map(command => command.command),
}
const escapeHatches: Partial<Record<ToolName, readonly string[]>> = {
  'ado-axi': ['api'], 'az-axi': ['api'], 'gitea-axi': ['api'], 'gh-axi': ['api'],
  'hybrid-axi': ['api get'], 'mg-axi': ['api get'], 'vectra-axi': ['api get'],
  'kubernetes-axi': kubernetes.commands.map(command => command.command).filter(command => command.startsWith('native -- ')),
}
const exactCommand = /^[^\s*]+(?: [^\s*]+)*$/
const sshExecPrerequisites = [
  { command: 'execution show', effect: 'read' },
  { command: 'execution cancel', effect: 'write' },
] as const

function commandOperation(tool: ToolName, command: string): string {
  return tool === 'kubernetes-axi' ? command.replace(/^(?:prepare|server-dry-run) -- /, '') : command
}

function requiresExact(tool: ToolName, command: string): boolean {
  return Boolean(exactCommands[tool]?.includes(command) || escapeHatches[tool]?.includes(command) || /^(?:api|native)(?: |$)/.test(command)
    || tool === 'kubernetes-axi' && ['workspace download', 'session artifact'].includes(command)
    || tool === 'proxmox-axi' && ['transfer get /nodes/{node}/qemu/{vmid}/agent/file-read',
      'transfer get /nodes/{node}/storage/{storage}/file-restore/download'].includes(command)
    || transferSelectionSchema.options.some(option => option.shape.operation.value === command && transferTool(option.shape.operation.value) === tool))
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
  const scope = { tools: input.scope.tools.map(({ instances: names, ...item }) => {
    checkToolPolicy(db, creatorId, item.tool)
    const instances = names && [...new Set(names.map(name => {
      const row = db.prepare('SELECT id FROM credentials WHERE tool = ? AND name = ?').get(item.tool, name) as { id: string } | undefined
      if (!row) throw new ArtiumError('INSTANCE_NOT_FOUND')
      checkToolPolicy(db, creatorId, item.tool, row.id)
      return row.id
    }))].sort()
    const scoped: typeof item & { instances?: string[] } = instances ? { ...item, instances } : item
    if (!item.commands) return scoped
    const adapter = adapters.find(adapter => adapter.name === item.tool)
    if (!adapter) throw new ArtiumError('INVALID_INPUT')
    return { ...scoped, commands: item.commands.map(command => resolveDelegatedCommand(command, adapter)) }
  }) }
  const sshGrants = scope.tools.filter(item => item.tool === 'ssh-axi')
  if (sshGrants.some(item => item.commands?.includes('exec')) && !sshGrants.some(item => item.commands === undefined)) {
    const missing = sshExecPrerequisites.filter(required => !sshGrants.some(item => item.commands?.includes(required.command)))
    if (missing.length) throw new ArtiumError('INVALID_INPUT',
      `SSH exec requires missing picks: ${missing.map(item => `ssh-axi:${item.command}`).join(', ')}.`)
  }
  const active = db.prepare('SELECT count(*) AS count FROM delegations WHERE creator_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .get(creatorId, now) as { count: number }
  if (active.count >= 20) throw new ArtiumError('TOO_MANY_CALLS')
  const token = `artd_${randomBytes(32).toString('base64url')}`
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, creatorId, hashToken(token), input.label, JSON.stringify(scope),
    Number(input.readOnly), Number(!input.reusable), now, input.expiresAt)
  return { id, token, expiresAt: input.expiresAt }
}

export function checkDelegation(scopeJson: string, readOnly: boolean, adapter: Adapter<unknown>, command: string, effect: 'read' | 'write', help = false, instanceId?: string) {
  const tool = adapter.name
  const scope = delegationScopeSchema.parse(JSON.parse(scopeJson))
  const grants = scope.tools.filter(item => item.tool === tool && (instanceId === undefined || !item.instances || item.instances.includes(instanceId)))
  const exact = grants.some(item => item.commands?.includes(command))
  const wide = grants.some(item => item.commands === undefined)
  const credentialCommand = exactCommands[tool]?.includes(command)
  const download = tool === 'kubernetes-axi' && ['workspace download', 'session artifact'].includes(command)
    || tool === 'proxmox-axi' && ['transfer get /nodes/{node}/qemu/{vmid}/agent/file-read',
    'transfer get /nodes/{node}/storage/{storage}/file-restore/download'].includes(command)
  const proxmoxStream = tool === 'proxmox-axi' && proxmox.streamCommands.some(route => route.command === command)
  if ((!wide && !exact) || (requiresExact(tool, command) && !exact) || (readOnly && (effect !== 'read' || credentialCommand || download || proxmoxStream))) {
    throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  }
  if (tool === 'ssh-axi' && command === 'exec' && !help) {
    for (const required of sshExecPrerequisites) checkDelegation(scopeJson, readOnly, adapter, required.command, required.effect, false, instanceId)
  }
}

function commandRoutes(tool: ToolName): { command: string, effect?: string, canonicalCommand?: string }[] {
  type Route = { command: string, effect?: string, canonicalCommand?: string }
  const manifest = toolManifests[tool] as { commands: Route[], writeCommands?: Route[], workflows?: Route[], managedCommands?: Route[] }
  return [...manifest.commands, ...manifest.writeCommands ?? [], ...manifest.workflows ?? [], ...manifest.managedCommands ?? [],
    ...(tool === 'kubernetes-axi' ? kubernetesHostedRoutes : []),
    ...(tool === 'proxmox-axi' ? [...proxmox.streamCommands, ...proxmoxHostedRoutes] : [])]
}

export function resolveDelegatedCommand(command: string, adapter: Adapter<unknown>): string {
  if (command.includes('*')) throw new ArtiumError('INVALID_INPUT', 'Wildcards are not supported yet.', 'Select exact commands or use --tool for tool-wide access.')
  if (!exactCommand.test(command)) throw new ArtiumError('INVALID_INPUT')
  if (transferSelectionSchema.options.some(option => option.shape.operation.value === command && transferTool(option.shape.operation.value) === adapter.name)) return command
  if (adapter.name === 'ssh-axi' && ssh.managedCommands.some(route => route.command === command)) return command
  if (adapter.name === 'proxmox-axi' && proxmoxHostedRoutes.some(route => route.command === command)) return command
  const invocation = commandInvocations(adapter.name, command)[0]
  const resolved = classifyDelegatedCommand(adapter, [...invocation.split(' '), '--help']).command
  if (resolved === 'unknown' || resolved === 'home' || adapter.name === 'kubernetes-axi' && resolved === 'session start') throw new ArtiumError('INVALID_INPUT')
  return resolved
}

export function authorizeDelegatedOperation(db: Database.Database, userId: string,
  delegation: { scopeJson: string, readOnly: boolean }, adapter: Adapter<unknown>,
  classification: { command: string, effect: 'read' | 'write', help?: boolean }, instanceId?: string) {
  checkToolPolicy(db, userId, adapter.name)
  checkDelegation(delegation.scopeJson, delegation.readOnly, adapter, classification.command, classification.effect, classification.help, instanceId)
  const row = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(adapter.name) as { native_settings: string }
  const settings = JSON.parse(row.native_settings)
  if (classification.effect === 'write' || credentialIssuingCommand(adapter.name, classification.command)) {
    if (!toolAllowsWrites(adapter.name, settings)) throw new ArtiumError('FLAG_BLOCKED')
    adapter.authorizeOperation?.(classification.command, settings)
  }
}

export function authorizeDelegatedCall(db: Database.Database, userId: string,
  delegation: { scopeJson: string, readOnly: boolean }, adapter: Adapter<unknown>, args: readonly string[], input?: RunnerInput, continuationCommand?: string, instanceId?: string, resolver?: IdentityResolver) {
  const classification = continuationCommand === undefined ? classifyDelegatedCommand(adapter, args, input)
    : { command: continuationCommand, effect: 'write' as const }
  if (adapter.kubernetesContinuation?.(args, input)?.help) {
    if (!delegatedDiscovery(db, userId, delegation, [adapter], resolver)[0]?.commands.includes(classification.command)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
    return []
  }
  const operations = [classification, ...(adapter.nestedOperations?.(args, input) ?? [])
    .map(operation => ({ ...operation, command: commandOperation(adapter.name, operation.command) }))]
  const help = adapter.name === 'ssh-axi' && args.includes('--help')
    && ssh.managedCommands.some(route => route.command === classification.command)
  for (const operation of operations) authorizeDelegatedOperation(db, userId, delegation, adapter, { ...operation, help }, instanceId)
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
    const managed = tool === 'ssh-axi' && ssh.managedCommands.some(item => item.command === route.command)
    const classification = managed ? { command: route.command, effect: route.effect === 'write' ? 'write' as const : 'read' as const }
      : classifyDelegatedCommand(adapter, route.command.split(' '))
    return commandInvocations(tool, route.command).flatMap(command => {
      try {
        if (!managed && !(tool === 'kubernetes-axi' && kubernetesHostedRoutes.some(route => route.command === command))
          && !(tool === 'proxmox-axi' && (proxmoxHostedRoutes.some(route => route.command === command) || proxmox.streamCommands.some(route => route.command === command)))) adapter.validateArgs([...command.split(' '), '--help'])
        if (managed && readOnly && ['connection open', 'connection set'].includes(command)) return []
        authorize(classification)
        return [command]
      }
      catch { return [] }
    })
  })
  if (tool === 'kubernetes-axi' && commands.some(command => command.startsWith('prepare -- '))) commands.push('preview', 'confirm')
  return [...new Set(commands)].sort()
}

export function delegatedDiscovery(db: Database.Database, userId: string, delegation: { scopeJson: string, readOnly: boolean }, adapters: readonly Adapter<unknown>[], resolver?: IdentityResolver) {
  return adapters.flatMap(adapter => {
    if (!delegationIncludesTool(delegation.scopeJson, adapter.name)) return []
    const row = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(adapter.name) as { native_settings: string }
    const readOnly = delegation.readOnly || !toolAllowsWrites(adapter.name, JSON.parse(row.native_settings))
    const available = (command: string) => adapter.name === 'ssh-axi' || !resolver || resolver.usableInstances(userId, adapter.name, delegation, command)
      .some(instance => instanceGranted(db, userId, adapter.name, instance.id))
    const commands = delegatedCommands(delegation.scopeJson, delegation.readOnly, adapter,
      classification => {
        if (!available(classification.command)) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
        if (adapter.name === 'kubernetes-axi' && kubernetesHostedRoutes.some(route => route.command === classification.command)) {
          authorizeKubernetesOwner(db, { user: userId, delegation }, adapter, classification.command)
        } else authorizeDelegatedOperation(db, userId, delegation, adapter, classification)
      })
    if (!delegation.readOnly) {
      const scope = delegationScopeSchema.parse(JSON.parse(delegation.scopeJson))
      for (const option of transferSelectionSchema.options) {
        const operation = option.shape.operation.value
        if (transferTool(operation) !== adapter.name || !available(operation) || !scope.tools.some(item => item.tool === adapter.name && item.commands?.includes(operation))) continue
        try { checkTransferPolicy(db, userId, operation); commands.push(operation) } catch { /* Current policy hides unavailable transfers. */ }
      }
      commands.sort()
    }
    return commands.length ? [{ adapter, readOnly, commands }] : []
  })
}

export function delegationIncludesTool(scopeJson: string, tool: ToolName): boolean {
  return delegationScopeSchema.parse(JSON.parse(scopeJson)).tools.some(item => item.tool === tool)
}

export function delegatedInstanceIds(delegation: { scopeJson: string } | null | undefined, tool: ToolName, command?: string): ReadonlySet<string> | undefined {
  if (!delegation) return undefined
  const selections = delegationScopeSchema.parse(JSON.parse(delegation.scopeJson)).tools.filter(item => item.tool === tool &&
    (command === undefined || item.commands?.includes(command) || !item.commands && !requiresExact(tool, command)))
  if (selections.some(item => !item.instances)) return undefined
  return new Set(selections.flatMap(item => item.instances ?? []))
}

export function delegationScopeWithInstanceNames(db: Database.Database, scopeJson: string) {
  return { tools: delegationScopeSchema.parse(JSON.parse(scopeJson)).tools.map(item => item.instances ? { ...item, instances: item.instances.map(id =>
    (db.prepare('SELECT name FROM credentials WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `deleted:${id}`) } : item) }
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
