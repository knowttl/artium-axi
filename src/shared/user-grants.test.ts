import { expect, test } from 'vitest'
import { nativeSettingsSchemas } from './api.js'
import { userGrantPolicies } from './user-grants.js'

const policies = Object.entries(userGrantPolicies).flatMap(([tool, entries]) =>
  Object.entries(entries).map(([policy, entry]) => ({ tool: tool as keyof typeof nativeSettingsSchemas, policy, entry })))

test.each(policies)('$tool $policy offers only operations its grant schema accepts', ({ tool, policy, entry }) => {
  const shape = nativeSettingsSchemas[tool].shape as unknown as Record<string, { unwrap: () => { shape: { grants: { safeParse: (value: unknown) => { success: boolean } } } } }>
  const ids = entry.operations.map(operation => operation.id)
  expect(ids.length).toBeGreaterThan(0)
  expect(new Set(ids).size).toBe(ids.length)
  expect(shape[policy]!.unwrap().shape.grants.safeParse({ person: ids }).success).toBe(true)
})
