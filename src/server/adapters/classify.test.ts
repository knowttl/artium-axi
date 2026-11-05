import { expect, test } from 'vitest'
import { createAwxAdapter } from './awx.js'
import { createAzAdapter } from './az.js'
import { createBeyondtrustAdapter } from './beyondtrust.js'
import { createCheckpointAdapter } from './checkpoint.js'
import { createHybridAdapter } from './hybrid.js'

const source = { getCredential: async () => ({}) }
const log = '/tmp/synthetic-classifier.log'
const adapters = [createAwxAdapter(source), createAzAdapter(source, log), createBeyondtrustAdapter(source, log),
  createCheckpointAdapter(source, log), createHybridAdapter(source, log)]

test.each([
  ['awx-axi', 'job list', 'read'], ['awx-axi', 'job launch', 'write'],
  ['az-axi', 'auth status', 'read'], ['az-axi', 'tag update', 'write'],
  ['beyondtrust-axi', 'admin-request list', 'read'], ['beyondtrust-axi', 'admin-request create', 'write'],
  ['checkpoint-axi', 'email search', 'read'], ['checkpoint-axi', 'email quarantine', 'write'],
  ['hybrid-axi', 'api get', 'read'], ['hybrid-axi', 'hunting yara create', 'write'],
] as const)('%s classifies %s from its inventory even for help', (tool, command, effect) => {
  expect(adapters.find(adapter => adapter.name === tool)!.classify!(command.split(' ').concat('--help')))
    .toEqual({ command, effect })
})

test.each(adapters)('$name classifies an unknown command as write', adapter => {
  expect(adapter.classify!(['synthetic-unknown']).effect).toBe('write')
})
