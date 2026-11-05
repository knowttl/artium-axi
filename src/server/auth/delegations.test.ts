import { expect, test } from 'vitest'
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

const source = { getCredential: async () => { throw new Error('Unexpected credential access') } }

test.each([
  { adapter: createAzAdapter(source, 'synthetic-writes.log'), pattern: 'group *', command: 'group list' },
  { adapter: createAdoAdapter(source), pattern: 'pr *', command: 'pr create' },
  { adapter: createMgAdapter(source, 'synthetic-writes.log'), pattern: 'entra user *', command: 'entra user list' },
  { adapter: createVectraAdapter(source, 'synthetic-writes.log'), pattern: 'detection *', command: 'detection list' },
  { adapter: createLdapAdapter(source), pattern: 'entry *', command: 'entry search' },
  { adapter: createTechnitiumAdapter(source), pattern: 'user session *', command: 'user session get' },
  { adapter: createHybridAdapter(source, 'synthetic-writes.log'), pattern: 'feed *', command: 'feed latest' },
  { adapter: createTenableAdapter(source, 'synthetic-writes.log'), pattern: 'asset *', command: 'asset list' },
  { adapter: createCheckpointAdapter(source, 'synthetic-writes.log'), pattern: 'email *', command: 'email search' },
  { adapter: createBeyondtrustAdapter(source, 'synthetic-writes.log'), pattern: 'admin-request *', command: 'admin-request list' },
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
  { adapter: createMgAdapter(source, 'synthetic-writes.log'), allowed: 'entra user list', blocked: ['mail message export', 'profile list'] },
])('$adapter.name discovery excludes routes unavailable through the adapter (R4)', ({ adapter, allowed, blocked }) => {
  const scope = JSON.stringify({ tools: [{ tool: adapter.name, commands: ['*'] }] })
  const commands = delegatedCommands(scope, false, adapter)
  expect(commands).toContain(allowed)
  for (const command of blocked) expect(commands).not.toContain(command)
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
