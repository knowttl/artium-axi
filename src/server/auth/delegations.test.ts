import { expect, test } from 'vitest'
import { checkDelegation } from './delegations.js'

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
