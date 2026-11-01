import { expect, test } from 'vitest'
import writeOperations from '../tools/inventories/write-operations.json' with { type: 'json' }
import { beyondtrustWritePolicy } from '../src/server/adapters/beyondtrust.js'
import { checkpointWritePolicy } from '../src/server/adapters/checkpoint.js'
import { falconWritePolicy } from '../src/server/adapters/falcon.js'
import { ghWritePolicy } from '../src/server/adapters/gh.js'
import { hybridWritePolicy } from '../src/server/adapters/hybrid.js'
import { mgWritePolicy } from '../src/server/adapters/mg.js'
import { tenableWritePolicy } from '../src/server/adapters/tenable.js'
import { vectraWritePolicy } from '../src/server/adapters/vectra.js'

type WriteOperationMap = Record<string, { groups: { operations: Record<string, unknown> }[] }>
const reviewed = writeOperations as WriteOperationMap

const policies = {
  'vectra-axi': vectraWritePolicy,
  'beyondtrust-axi': beyondtrustWritePolicy,
  'checkpoint-axi': checkpointWritePolicy,
  'hybrid-axi': hybridWritePolicy,
  'tenable-axi': tenableWritePolicy,
  'mg-axi': mgWritePolicy,
  'gh-axi': ghWritePolicy,
  'falcon-axi': falconWritePolicy,
}

// A new upstream operation fails here until someone reviews it and adds its label, group and risk tags.
test.each(Object.entries(policies))('%s write-operations.json lists exactly the supported operations once each', (tool, policy) => {
  const listed = reviewed[tool].groups.flatMap(group => Object.keys(group.operations))
  expect(listed.sort()).toEqual([...(policy.read({}).supportedOperations ?? [])].sort())
})

test('write-operations.json only covers tools with an operation allow-list', () => {
  expect(Object.keys(reviewed).sort()).toEqual(Object.keys(policies).sort())
})
