import { expect, test } from 'vitest'
import { mutationReceiptSchema } from './mutation-outcome.js'

const receipt = { auditId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', operation: 'OP-080', status: 'ok' }

test.each([
  { auditId: 'CANARY-private-value' },
  { operation: 'CANARY-private-operation' },
  { status: 'CANARY-private-status' },
  { credential: 'CANARY-private-credential' },
  { cluster: { scope: 'selected node', completion: 'selected-node state only', effects: 'CANARY-private-effects' } },
])('the native recovery boundary refuses unrecognized metadata: %j', invalid => {
  expect(mutationReceiptSchema.safeParse({ ...receipt, ...invalid }).success).toBe(false)
})

test('the native recovery boundary strips result bytes, paths and provider fields', () => {
  expect(mutationReceiptSchema.parse({ ...receipt, response: { token: 'CANARY-private-response' },
    result: { path: '/private/CANARY-path', bytes: 10, sha256: 'a'.repeat(64) }, username: 'CANARY-user' })).toEqual(receipt)
})
