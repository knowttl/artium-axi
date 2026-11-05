import { expect, test } from 'vitest'
import { join } from 'node:path'
import { checkDelegation, delegatedCommands, resolveDelegatedPattern } from './delegations.js'
import { createAzAdapter } from '../adapters/az.js'
import { createAdoAdapter } from '../adapters/ado.js'
import { createAwxAdapter } from '../adapters/awx.js'
import { createMgAdapter } from '../adapters/mg.js'
import { createVectraAdapter } from '../adapters/vectra.js'
import { createLdapAdapter } from '../adapters/ldap.js'
import { createTechnitiumAdapter } from '../adapters/technitium.js'
import { createHybridAdapter } from '../adapters/hybrid.js'
import { createTenableAdapter } from '../adapters/tenable.js'
import { createCheckpointAdapter } from '../adapters/checkpoint.js'
import { createBeyondtrustAdapter } from '../adapters/beyondtrust.js'
import { createProxmoxAdapter } from '../adapters/proxmox.js'
import { createKubernetesAdapter } from '../adapters/kubernetes.js'

const source = { getCredential: async () => { throw new Error('Unexpected credential access') } }
const writeLog = join(process.cwd(), 'synthetic-writes.log')

test.each([
  { adapter: createAzAdapter(source, writeLog), pattern: 'group *', command: 'group list' },
  { adapter: createAdoAdapter(source), pattern: 'pr *', command: 'pr create' },
  { adapter: createMgAdapter(source, writeLog), pattern: 'entra user *', command: 'entra user list' },
  { adapter: createVectraAdapter(source, writeLog), pattern: 'detection *', command: 'detection list' },
  { adapter: createLdapAdapter(source), pattern: 'entry *', command: 'entry search' },
  { adapter: createTechnitiumAdapter(source), pattern: 'user session *', command: 'user session get' },
  { adapter: createHybridAdapter(source, writeLog), pattern: 'feed *', command: 'feed latest' },
  { adapter: createTenableAdapter(source, writeLog), pattern: 'asset *', command: 'asset list' },
  { adapter: createCheckpointAdapter(source, writeLog), pattern: 'email *', command: 'email search' },
  { adapter: createBeyondtrustAdapter(source, writeLog), pattern: 'admin-request *', command: 'admin-request list' },
])('$pattern preserves its namespace instead of resolving a default leaf (R2)', ({ adapter, pattern, command }) => {
  const resolved = resolveDelegatedPattern(pattern, adapter)
  expect(resolved).toBe(pattern)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolved] }] })
  const classification = adapter.classify(command.split(' '))
  expect(() => checkDelegation(scope, false, adapter.name, classification.command, classification.effect)).not.toThrow()
})

test.each([
  { adapter: createAwxAdapter(source), allowed: 'job list', blocked: ['auth login', 'setup', 'update'] },
  { adapter: createAdoAdapter(source), allowed: 'pr list', blocked: ['pipeline runs artifact download', 'config show'] },
  { adapter: createMgAdapter(source, writeLog), allowed: 'entra user list', blocked: ['mail message export', 'profile list'] },
])('$adapter.name discovery excludes routes unavailable through the adapter (R4)', ({ adapter, allowed, blocked }) => {
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: ['*'] }] })
  const commands = delegatedCommands(scope, false, adapter)
  expect(commands).toContain(allowed)
  for (const command of blocked) expect(commands).not.toContain(command)
})

test.each([
  { pattern: 'wi *', expected: 'work-item *' },
  { pattern: 'prs *', expected: 'pr *' },
  { pattern: 'work-item links *', expected: 'work-item link *' },
  { pattern: 'wi links *', expected: 'work-item link *' },
])('$pattern resolves its supported alias namespace (R7)', ({ pattern, expected }) => {
  expect(resolveDelegatedPattern(pattern, createAdoAdapter(source))).toBe(expected)
})

test.each(['get /version', 'create /access/users/{userid}/token/{tokenid}'])('Proxmox exact route %s is accepted (R1)', pattern => {
  const adapter = createProxmoxAdapter(source)
  expect(resolveDelegatedPattern(pattern, adapter)).toBe(pattern)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [pattern] }] })
  const classification = adapter.classify(pattern.split(' '))
  expect(() => checkDelegation(scope, false, adapter.name, classification.command, classification.effect)).not.toThrow()
})

test('Proxmox wildcard still excludes credential issuance (R1)', () => {
  const adapter = createProxmoxAdapter(source)
  const pattern = resolveDelegatedPattern('create *', adapter)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [pattern] }] })
  expect(() => checkDelegation(scope, false, adapter.name, 'create /access/users/{userid}/token/{tokenid}', 'write'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test('Proxmox wildcard resolves the post namespace alias (R7)', () => {
  expect(resolveDelegatedPattern('post *', createProxmoxAdapter(source))).toBe('create *')
})

test('wildcard prefixes cannot consume descendant words as positional arguments (R7)', () => {
  expect(() => resolveDelegatedPattern('pr list *', createAdoAdapter(source)))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

test.each(['apply', 'create token'])('Kubernetes %s discovery advertises admitted mutation workflows (R6)', async command => {
  const adapter = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [command] }] })
  expect(delegatedCommands(scope, false, adapter)).toEqual(expect.arrayContaining([
    `prepare -- ${command}`, `server-dry-run -- ${command}`,
  ]))
  expect(delegatedCommands(scope, false, adapter)).not.toContain(command)
  expect(delegatedCommands(scope, true, adapter)).not.toContain(`prepare -- ${command}`)
  expect(delegatedCommands(scope, true, adapter)).not.toContain(`server-dry-run -- ${command}`)
})

test.each([
  { pattern: 'create *', descendant: 'create deployment' },
  { pattern: 'apply *', descendant: 'apply set-last-applied' },
  { pattern: 'certificate *', descendant: 'certificate approve' },
  { pattern: 'create secret *', descendant: 'create secret generic' },
  { pattern: 'create service *', descendant: 'create service clusterip' },
  { pattern: 'set *', descendant: 'set env' },
])('Kubernetes $pattern resolves through mutation workflows (R9)', async ({ pattern, descendant }) => {
  const adapter = await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))
  const resolved = resolveDelegatedPattern(pattern, adapter)
  expect(resolved).toBe(pattern)
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: [resolved] }] })
  expect(delegatedCommands(scope, false, adapter)).toContain(`prepare -- ${descendant}`)
  expect(delegatedCommands(scope, false, adapter)).toContain(`server-dry-run -- ${descendant}`)
  expect(delegatedCommands(scope, false, adapter)).not.toContain('prepare -- create token')
})

test.each([
  { commands: undefined, readOnly: true, writes: [] },
  { commands: ['*'], readOnly: true, writes: [] },
  { commands: undefined, readOnly: false, writes: ['job cancel'] },
  { commands: ['*'], readOnly: false, writes: ['job cancel'] },
])('AWX discovery filters broad grants with readOnly=$readOnly (R10)', ({ commands, readOnly, writes }) => {
  const scope = JSON.stringify({ tools: [{ tool: 'awx-axi', commands }] })
  const permitted = delegatedCommands(scope, readOnly, createAwxAdapter(source))
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
  { ...operation, grant: 'wildcard', commands: ['*'], readOnly: false },
  { ...operation, grant: 'read-only exact', commands: [operation.command], readOnly: true },
]))('Technitium $command rejects a $grant delegation (R8)', ({ command, effect, commands, readOnly }) => {
  const scope = JSON.stringify({ tools: [{ tool: 'technitium-axi', commands }] })
  expect(() => checkDelegation(scope, readOnly, 'technitium-axi', command, effect))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test.each(credentialOutputs)('Technitium $command accepts an exact writable delegation (R8)', ({ command, effect }) => {
  const scope = JSON.stringify({ tools: [{ tool: 'technitium-axi', commands: [command] }] })
  expect(() => checkDelegation(scope, false, 'technitium-axi', command, effect)).not.toThrow()
})

test.each([
  { tool: 'gh-axi', command: 'api' },
  { tool: 'kubernetes-axi', command: 'native -- get' },
] as const)('wildcard excludes the $command escape hatch', ({ tool, command }) => {
  const scope = JSON.stringify({ tools: [{ tool, commands: ['*'] }] })
  expect(() => checkDelegation(scope, false, tool, command, 'read'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test('wildcards match complete command words', () => {
  const scope = JSON.stringify({ tools: [{ tool: 'awx-axi', commands: ['job *'] }] })
  expect(() => checkDelegation(scope, false, 'awx-axi', 'job list', 'read')).not.toThrow()
  expect(() => checkDelegation(scope, false, 'awx-axi', 'job-template list', 'read'))
    .toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})
