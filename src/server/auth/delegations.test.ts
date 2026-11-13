import { expect, test } from 'vitest'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../store/db.js'
import { authorizeDelegatedCall, authorizeDelegatedOperation, checkDelegation, classifyDelegatedCommand, delegatedCommands, delegatedDiscovery, delegatedInstanceIds, resolveDelegatedCommand } from './delegations.js'
import { delegationScopeSchema } from '../../shared/api.js'
import { createAzAdapter } from '../adapters/az.js'
import { createAdoAdapter } from '../adapters/ado.js'
import { createAwxAdapter } from '../adapters/awx.js'
import { createMgAdapter } from '../adapters/mg.js'
import { createVectraAdapter } from '../adapters/vectra.js'
import { createLdapAdapter } from '../adapters/ldap.js'
import { createTechnitiumAdapter } from '../adapters/technitium.js'
import { createHybridAdapter } from '../adapters/hybrid.js'
import { createTenableAdapter } from '../adapters/tenable.js'
import { createFalconAdapter } from '../adapters/falcon.js'
import { createCheckpointAdapter } from '../adapters/checkpoint.js'
import { createBeyondtrustAdapter } from '../adapters/beyondtrust.js'
import { createProxmoxAdapter } from '../adapters/proxmox.js'
import { createKubernetesAdapter } from '../adapters/kubernetes.js'
import { createGhAdapter } from '../adapters/gh.js'
import { createGiteaAdapter } from '../adapters/gitea.js'
import { createUnifiAdapter } from '../adapters/unifi.js'

const source = { getCredential: async () => { throw new Error('Unexpected credential access') } }
const writeLog = join(process.cwd(), 'synthetic-writes.log')

test.each([
  { adapter: createGhAdapter(source), settings: { writes: { allowWrites: true, operations: ['issue create'] } }, readOnly: false,
    candidates: ['issue list', 'issue create', 'issue edit'], allowed: ['issue list', 'issue create'], enabled: true, granted: true },
  { adapter: createGhAdapter(source), settings: { writes: { allowWrites: true, operations: ['issue create'] } }, readOnly: true,
    candidates: ['issue list', 'issue create', 'issue edit'], allowed: ['issue list'], enabled: true, granted: true },
  { adapter: createGhAdapter(source), settings: { writes: { allowWrites: false, operations: ['issue create'] } }, readOnly: false,
    candidates: ['issue list', 'issue create', 'issue edit'], allowed: ['issue list'], enabled: true, granted: true },
  { adapter: createAwxAdapter(source), settings: { allowWrites: true }, readOnly: false,
    candidates: ['job list', 'job cancel', 'user token-create'], allowed: ['job list', 'job cancel'], enabled: true, granted: true },
  { adapter: createAwxAdapter(source), settings: { allowWrites: false }, readOnly: false,
    candidates: ['job list', 'job cancel', 'user token-create'], allowed: ['job list'], enabled: true, granted: true },
  { adapter: createAdoAdapter(source), settings: { allowWrites: true }, readOnly: false,
    candidates: ['pr list', 'pr create'], allowed: ['pr list', 'pr create'], enabled: true, granted: true },
  { adapter: createGhAdapter(source), settings: { writes: { allowWrites: true, operations: ['issue create'] } }, readOnly: false,
    candidates: ['issue list', 'issue create', 'issue edit'], allowed: [], enabled: false, granted: true },
  { adapter: createGhAdapter(source), settings: { writes: { allowWrites: true, operations: ['issue create'] } }, readOnly: false,
    candidates: ['issue list', 'issue create', 'issue edit'], allowed: [], enabled: true, granted: false },
  { adapter: createUnifiAdapter(source, writeLog), settings: { writes: { allowWrites: true, operations: ['createAclRule'] } }, readOnly: false,
    candidates: ['doctor', 'acl-rule create', 'acl-rule delete'], allowed: ['doctor', 'acl-rule create'], enabled: true, granted: true },
  { adapter: createUnifiAdapter(source, writeLog), settings: { writes: { allowWrites: true, operations: [] } }, readOnly: false,
    candidates: ['doctor', 'acl-rule create', 'acl-rule delete'], allowed: ['doctor'], enabled: true, granted: true },
  { adapter: createFalconAdapter(source), settings: { writes: { allowWrites: true, operations: ['search start'] } }, readOnly: false,
    candidates: ['host list', 'search start', 'search stop'], allowed: ['host list', 'search start'], enabled: true, granted: true },
  { adapter: createFalconAdapter(source), settings: { writes: { allowWrites: false, operations: ['search start'] } }, readOnly: false,
    candidates: ['host list', 'search start', 'search stop'], allowed: ['host list'], enabled: true, granted: true },
  { adapter: createGiteaAdapter(source, writeLog), settings: { writes: { allowWrites: true, operations: ['issueCreateIssue'] } }, readOnly: false,
    candidates: ['repo view', 'issue create', 'issue edit'], allowed: ['repo view', 'issue create', 'issue edit'], enabled: true, granted: true },
  { adapter: createGiteaAdapter(source, writeLog), settings: { writes: { allowWrites: true, operations: [] } }, readOnly: false,
    candidates: ['repo view', 'issue create', 'issue edit'], allowed: ['repo view'], enabled: true, granted: true },
  { adapter: createTechnitiumAdapter(source), readOnly: false, enabled: true, granted: true,
    settings: { hostWrites: { allowWrites: true, operations: ['OP-119'] }, writes: { allowWrites: true, operations: ['OP-119', 'OP-120'] } },
    candidates: ['status', 'admin cluster init', 'admin cluster primary delete'], allowed: ['status', 'admin cluster init'] },
  { adapter: createTechnitiumAdapter(source), readOnly: false, enabled: true, granted: true,
    settings: { hostWrites: { allowWrites: true, operations: ['OP-119', 'OP-120'] }, writes: { allowWrites: true, operations: ['OP-120'] } },
    candidates: ['status', 'admin cluster init', 'admin cluster primary delete'], allowed: ['status', 'admin cluster primary delete'] },
  { adapter: createTechnitiumAdapter(source), readOnly: false, enabled: true, granted: true,
    settings: { hostWrites: { allowWrites: true, operations: ['OP-119'] } },
    candidates: ['status', 'admin cluster init'], allowed: ['status'] },
  { adapter: createTechnitiumAdapter(source), readOnly: false, enabled: true, granted: true,
    settings: { hostWrites: { allowWrites: true, operations: ['OP-119'] }, writes: { allowWrites: true, operations: ['OP-119'] } },
    candidates: ['status', 'dns-client resolve'], allowed: ['status'] },
  { adapter: createTechnitiumAdapter(source), readOnly: false, enabled: true, granted: true,
    settings: { hostWrites: { allowWrites: true, operations: ['OP-077.import'] }, writes: { allowWrites: true, operations: ['OP-077.import'] } },
    candidates: ['status', 'dns-client resolve'], allowed: ['status', 'dns-client resolve'] },
  { adapter: createProxmoxAdapter(source), settings: { hostWrites: { allowWrites: true, operations: ['OP-DELETE-d6b1eb65f2'] } }, readOnly: false,
    candidates: ['task status', 'task cancel', 'delete /nodes/{node}/lxc/{vmid}'], allowed: ['task status', 'task cancel'], enabled: true, granted: true },
  { adapter: createProxmoxAdapter(source), settings: { hostWrites: { allowWrites: false, operations: ['OP-DELETE-d6b1eb65f2'] } }, readOnly: false,
    candidates: ['task status', 'task cancel'], allowed: ['task status'], enabled: true, granted: true },
])('$adapter.name discovery matches execution authorization under $settings, readOnly=$readOnly, enabled=$enabled, granted=$granted (R17)',
  ({ adapter, settings, readOnly, candidates, allowed, enabled, granted }) => {
    const db = new Database(':memory:')
    try {
      migrate(db)
      db.exec(`INSERT INTO users (id, username, display_name, password_hash)
        VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash');
        INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
        INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role')`)
      db.prepare('INSERT INTO tools (name, enabled, pinned_version, native_settings) VALUES (?, ?, ?, ?)')
        .run(adapter.name, Number(enabled), 'synthetic-version', JSON.stringify(settings))
      if (granted) db.prepare('INSERT INTO role_tools (role_id, tool) VALUES (?, ?)').run('synthetic-role', adapter.name)
      const delegation = { scopeJson: JSON.stringify({ tools: [{ tool: adapter.name }] }), readOnly }
      const discovered = delegatedDiscovery(db, 'synthetic-user', delegation, [adapter]).flatMap(item => item.commands)
      const executable = candidates.filter(command => {
        try {
          authorizeDelegatedOperation(db, 'synthetic-user', delegation, adapter,
            classifyDelegatedCommand(adapter, [...command.split(' '), '--help']))
          return true
        } catch { return false }
      })
      expect(executable).toEqual(allowed)
      expect(discovered.filter(command => candidates.includes(command))).toEqual([...allowed].sort())
    } finally { db.close() }
  })

test.each([
  { adapter: createAzAdapter(source, writeLog), command: 'group list' },
  { adapter: createAdoAdapter(source), command: 'pr create' },
  { adapter: createMgAdapter(source, writeLog), command: 'entra user list' },
  { adapter: createVectraAdapter(source, writeLog), command: 'detection list' },
  { adapter: createLdapAdapter(source), command: 'entry search' },
  { adapter: createTechnitiumAdapter(source), command: 'user session get' },
  { adapter: createHybridAdapter(source, writeLog), command: 'feed latest' },
  { adapter: createTenableAdapter(source, writeLog), command: 'asset list' },
  { adapter: createCheckpointAdapter(source, writeLog), command: 'email search' },
  { adapter: createBeyondtrustAdapter(source, writeLog), command: 'admin-request list' },
])('$adapter.name resolves exact $command (R2)', ({ adapter, command }) => {
  const resolved = resolveDelegatedCommand(command, adapter)
  expect(resolved).toBe(command)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolved] }] })
  const classification = adapter.classify(command.split(' '))
  expect(() => checkDelegation(scope, false, adapter, classification.command, classification.effect)).not.toThrow()
})

test.each([
  { adapter: createAwxAdapter(source), allowed: 'job list', blocked: ['auth login', 'setup', 'update'] },
  { adapter: createAdoAdapter(source), allowed: 'pr list', blocked: ['pipeline runs artifact download', 'config show'] },
  { adapter: createMgAdapter(source, writeLog), allowed: 'entra user list', blocked: ['mail message export', 'profile list'] },
])('$adapter.name discovery excludes routes unavailable through the adapter (R4)', ({ adapter, allowed, blocked }) => {
  const scope = JSON.stringify({ tools: [{ tool: adapter.name }] })
  const commands = delegatedCommands(scope, false, adapter)
  expect(commands).toContain(allowed)
  for (const command of blocked) expect(commands).not.toContain(command)
})

test.each([
  { command: 'wi list', expected: 'work-item list' },
  { command: 'prs list', expected: 'pr list' },
  { command: 'work-item links list', expected: 'work-item link list' },
  { command: 'wi links list', expected: 'work-item link list' },
])('$command resolves its supported alias (R7)', ({ command, expected }) => {
  expect(resolveDelegatedCommand(command, createAdoAdapter(source))).toBe(expected)
})

test.each(['get /version', 'create /access/users/{userid}/token/{tokenid}'])('Proxmox exact route %s is accepted (R1)', pattern => {
  const adapter = createProxmoxAdapter(source)
  expect(resolveDelegatedCommand(pattern, adapter)).toBe(pattern)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [pattern] }] })
  const classification = adapter.classify(pattern.split(' '))
  expect(() => checkDelegation(scope, false, adapter, classification.command, classification.effect)).not.toThrow()
})

test('Proxmox tool-wide access still excludes credential issuance (R1)', () => {
  const adapter = createProxmoxAdapter(source)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name }] })
  expect(() => checkDelegation(scope, false, adapter, 'create /access/users/{userid}/token/{tokenid}', 'write'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test('Proxmox resolves the exact post alias (R7)', () => {
  expect(resolveDelegatedCommand('post /nodes/{node}/execute', createProxmoxAdapter(source))).toBe('create /nodes/{node}/execute')
})

test.each(['*', 'job *', 'security alert list *', 'defender alerts *', 'prepare -- create *'])('wildcard %s is unsupported (R25)', command => {
  expect(() => resolveDelegatedCommand(command, createAdoAdapter(source)))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: 'Wildcards are not supported yet.' }))
})

test('stored scopes reject compiled wildcard selections (R25)', () => {
  expect(delegationScopeSchema.safeParse({ tools: [{ tool: 'az-axi',
    commands: [{ pattern: 'defender alerts *', operations: ['security alert update'] }] }] }).success).toBe(false)
})

test.each([
  { invocation: 'monitor activity-log list', canonical: 'activity list' },
  { invocation: 'security alert list', canonical: 'defender alerts' },
  { invocation: 'security secure-scores list', canonical: 'defender score' },
  { invocation: 'defender alerts update', canonical: 'security alert update' },
  { invocation: 'defender alerts get', canonical: 'defender alerts get' },
])('Azure exact alias $invocation retains its canonical operation (R19)', ({ invocation, canonical }) => {
  const adapter = createAzAdapter(source, writeLog)
  const resolved = resolveDelegatedCommand(invocation, adapter)
  expect(resolved).toBe(canonical)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolved] }] })
  const classification = classifyDelegatedCommand(adapter, [...invocation.split(' '), '--help'])
  expect(classification.command).toBe(canonical)
  expect(() => checkDelegation(scope, false, adapter, classification.command, classification.effect)).not.toThrow()
  expect(delegatedCommands(scope, false, adapter)).toContain(canonical)
  expect(() => checkDelegation(scope, false, adapter, 'sub list', 'read'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test.each([
  { workflow: 'prepare', descendant: 'create deployment' },
  { workflow: 'server-dry-run', descendant: 'create deployment' },
  { workflow: 'prepare', descendant: 'apply set-last-applied' },
  { workflow: 'server-dry-run', descendant: 'apply set-last-applied' },
  { workflow: 'prepare', descendant: 'set env' },
  { workflow: 'server-dry-run', descendant: 'set env' },
])('Kubernetes $workflow -- $descendant grants its canonical operation (R16)', async ({ workflow, descendant }) => {
  const adapter = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const resolved = resolveDelegatedCommand(`${workflow} -- ${descendant}`, adapter)
  expect(resolved).toBe(descendant)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolved] }] })
  const classification = classifyDelegatedCommand(adapter, [workflow, '--', ...descendant.split(' '), '--help'])
  expect(classification.command).toBe(descendant)
  expect(() => checkDelegation(scope, false, adapter, classification.command, classification.effect)).not.toThrow()
  expect(delegatedCommands(scope, false, adapter)).toContain(`${workflow} -- ${descendant}`)
  expect(() => checkDelegation(scope, false, adapter, 'create token', 'write'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test.each(['apply', 'create token'])('Kubernetes %s discovery advertises admitted mutation workflows (R6)', async command => {
  const adapter = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [command] }] })
  expect(delegatedCommands(scope, false, adapter)).toEqual(expect.arrayContaining([
    `prepare -- ${command}`, `server-dry-run -- ${command}`, 'preview', 'confirm',
  ]))
  expect(delegatedCommands(scope, false, adapter)).not.toContain(command)
  expect(delegatedCommands(scope, true, adapter)).not.toContain(`prepare -- ${command}`)
  expect(delegatedCommands(scope, true, adapter)).not.toContain(`server-dry-run -- ${command}`)
  expect(delegatedCommands(scope, true, adapter)).not.toContain('preview')
  expect(delegatedCommands(scope, true, adapter)).not.toContain('confirm')
})

test.each([
  { settings: { allowWrites: true }, issued: false },
  { settings: { allowWrites: true, acquireCredential: false }, issued: false },
  { settings: { allowWrites: true, acquireCredential: true }, issued: true },
])('Kubernetes create token discovery follows execution under $settings', async ({ settings, issued }) => {
  const adapter = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    db.exec(`INSERT INTO users (id, username, display_name, password_hash)
      VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash');
      INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
      INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role')`)
    db.prepare("INSERT INTO tools (name, enabled, pinned_version, native_settings) VALUES ('kubernetes-axi', 1, 'synthetic', ?)").run(JSON.stringify(settings))
    db.prepare("INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'kubernetes-axi')").run()
    const delegation = { scopeJson: JSON.stringify({ tools: [{ tool: adapter.name, commands: ['create token'] }] }), readOnly: false }
    const discovered = delegatedDiscovery(db, 'synthetic-user', delegation, [adapter])[0]?.commands ?? []
    expect(discovered.includes('prepare -- create token')).toBe(issued)
    const authorize = () => authorizeDelegatedCall(db, 'synthetic-user', delegation, adapter, ['prepare', '--', 'create', 'token', '--help'])
    if (issued) expect(authorize).not.toThrow()
    else expect(authorize).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
  } finally { db.close() }
})

test.each([
  { grant: 'apply', operation: 'apply' },
  { grant: 'create configmap', operation: 'create configmap' },
  { grant: 'set env', operation: 'set env' },
])('$grant authorizes its full $operation workflow (R23)', async ({ grant, operation }) => {
  const adapter = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    db.exec(`INSERT INTO users (id, username, display_name, password_hash)
      VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash');
      INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
      INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role');
      INSERT INTO tools (name, enabled, pinned_version, native_settings) VALUES ('kubernetes-axi', 1, 'synthetic', '{"allowWrites":true}');
      INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'kubernetes-axi')`)
    const delegation = { scopeJson: JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolveDelegatedCommand(grant, adapter)] }] }), readOnly: false }
    const key = '00000000-0000-4000-8000-000000000001'
    expect(authorizeDelegatedCall(db, 'synthetic-user', delegation, adapter, ['prepare', '--', ...operation.split(' '), '--help']))
      .toEqual([{ command: operation, effect: 'write' }])
    expect(authorizeDelegatedCall(db, 'synthetic-user', delegation, adapter, ['preview', key], undefined, operation))
      .toEqual([{ command: operation, effect: 'write' }])
    expect(authorizeDelegatedCall(db, 'synthetic-user', delegation, adapter, ['confirm', key, '--digest', 'a'.repeat(64)], undefined, operation))
      .toEqual([{ command: operation, effect: 'write' }])
    expect(delegatedDiscovery(db, 'synthetic-user', delegation, [adapter])[0].commands).toEqual(expect.arrayContaining(['preview', 'confirm']))
    expect(delegatedCommands(JSON.stringify({ tools: [{ tool: adapter.name, commands: ['preview', 'confirm'] }] }), false, adapter)).toEqual([])
  } finally { db.close() }
})

test.each([
  { descendant: 'create deployment' },
  { descendant: 'apply set-last-applied' },
  { descendant: 'certificate approve' },
  { descendant: 'create secret generic' },
  { descendant: 'create service clusterip' },
  { descendant: 'set env' },
])('Kubernetes exact $descendant resolves through mutation workflows (R9)', async ({ descendant }) => {
  const adapter = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const resolved = resolveDelegatedCommand(descendant, adapter)
  expect(resolved).toBe(descendant)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolved] }] })
  expect(delegatedCommands(scope, false, adapter)).toContain(`prepare -- ${descendant}`)
  expect(delegatedCommands(scope, false, adapter)).toContain(`server-dry-run -- ${descendant}`)
  expect(delegatedCommands(scope, false, adapter)).not.toContain('prepare -- create token')
})

test.each([
  { commands: undefined, readOnly: true, writes: [] },
  { commands: ['job list', 'job cancel'], readOnly: true, writes: [] },
  { commands: undefined, readOnly: false, writes: ['job cancel'] },
  { commands: ['job list', 'job cancel'], readOnly: false, writes: ['job cancel'] },
])('AWX discovery filters broad grants with readOnly=$readOnly (R10)', ({ commands, readOnly, writes }) => {
  const adapter = createAwxAdapter(source)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: commands?.map(command => resolveDelegatedCommand(command, adapter)) }] })
  const permitted = delegatedCommands(scope, readOnly, adapter)
  expect(permitted).toContain('job list')
  expect(permitted.filter(command => command === 'job cancel')).toEqual(writes)
  expect(permitted).not.toContain('user token-create')
  expect(permitted).not.toContain('auth login')
})

const credentialOutputs = [
  { command: 'user create-token', effect: 'write' },
  { command: 'user create-single-use-token', effect: 'write' },
  { command: 'admin session create-token', effect: 'write' },
  { command: 'settings backup', effect: 'read' },
  { command: 'settings set', effect: 'write' },
  { command: 'settings restore', effect: 'write' },
  { command: 'admin cluster primary transfer-config', effect: 'read' },
] as const

test.each(credentialOutputs.flatMap(operation => [
  { ...operation, grant: 'tool-wide', commands: undefined, readOnly: false },
  { ...operation, grant: 'different exact', commands: ['status'], readOnly: false },
  { ...operation, grant: 'read-only exact', commands: [operation.command], readOnly: true },
]))('Technitium $command rejects a $grant delegation (R8)', ({ command, effect, commands, readOnly }) => {
  const adapter = createTechnitiumAdapter(source)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: commands?.map(command => resolveDelegatedCommand(command, adapter)) }] })
  expect(() => checkDelegation(scope, readOnly, adapter, command, effect))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test.each(credentialOutputs)('Technitium $command accepts an exact writable delegation (R8)', ({ command, effect }) => {
  const scope = JSON.stringify({ tools: [{ tool: 'technitium-axi', commands: [command] }] })
  expect(() => checkDelegation(scope, false, createTechnitiumAdapter(source), command, effect)).not.toThrow()
})

test.each([
  { tool: 'gh-axi', command: 'api' },
  { tool: 'kubernetes-axi', command: 'native -- get' },
] as const)('tool-wide access excludes the $command escape hatch', async ({ tool, command }) => {
  const adapter = tool === 'gh-axi' ? createGhAdapter(source)
    : await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const scope = JSON.stringify({ tools: [{ tool }] })
  expect(() => checkDelegation(scope, false, adapter, command, 'read'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test.each([
  { adapter: createFalconAdapter(source), command: 'raw get', effect: 'read' },
  { adapter: createFalconAdapter(source), command: 'raw write', effect: 'read' },
  { adapter: createFalconAdapter(source), command: 'raw write', effect: 'write' },
  { adapter: createTenableAdapter(source, writeLog), command: 'raw get', effect: 'read' },
  { adapter: createTenableAdapter(source, writeLog), command: 'raw write', effect: 'read' },
  { adapter: createTenableAdapter(source, writeLog), command: 'raw write', effect: 'write' },
] as const)('$adapter.name $command requires an exact grant for $effect', ({ adapter, command, effect }) => {
  const wide = { scopeJson: JSON.stringify({ tools: [{ tool: adapter.name, instances: ['wide'] }] }), readOnly: false }
  const exact = { scopeJson: JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolveDelegatedCommand(command, adapter)], instances: ['exact'] }] }), readOnly: false }
  expect(() => checkDelegation(wide.scopeJson, false, adapter, command, effect))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
  expect(() => checkDelegation(exact.scopeJson, false, adapter, command, effect)).not.toThrow()
  expect(delegatedCommands(wide.scopeJson, false, adapter)).not.toContain(command)
  expect(delegatedCommands(exact.scopeJson, false, adapter)).toContain(command)
  expect(delegatedInstanceIds(wide, adapter.name, command)).toEqual(new Set())
  expect(delegatedInstanceIds(exact, adapter.name, command)).toEqual(new Set(['exact']))
})

test('exact picks do not grant sibling commands', () => {
  const adapter = createAwxAdapter(source)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: ['job list'] }] })
  expect(() => checkDelegation(scope, false, adapter, 'job list', 'read')).not.toThrow()
  expect(() => checkDelegation(scope, false, adapter, 'job-template list', 'read'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test.each([
  { tool: 'kubernetes-axi', args: ['prepare', '--', 'create', 'token', '--help'] },
  { tool: 'kubernetes-axi', args: ['server-dry-run', '--', 'create', 'token', '--help'] },
  { tool: 'kubernetes-axi', args: ['native', '--', 'get', '--help'] },
  { tool: 'gh-axi', args: ['api', '--help'] },
] as const)('canonical $tool $args requires an exact pick in tool-wide grants (R15)', async ({ tool, args }) => {
  const adapter = tool === 'gh-axi' ? createGhAdapter(source)
    : await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const scope = JSON.stringify({ tools: [{ tool }] })
  const classification = classifyDelegatedCommand(adapter, args)
  expect(classification.command).not.toBe('unknown')
  expect(() => checkDelegation(scope, false, adapter, classification.command, classification.effect))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})
