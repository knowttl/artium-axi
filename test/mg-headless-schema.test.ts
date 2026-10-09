import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

type StringConstraint = { type: 'string'; pattern: string }
type CredentialForm = { properties: Record<string, StringConstraint> }
const schema = JSON.parse(readFileSync(
  new URL('../tools/inventories/mg-axi-headless.schema.json', import.meta.url), 'utf8',
)) as { properties: { credentialRef: { oneOf: CredentialForm[] } } }

describe.each(['secretFile', 'keyFile'])('Generated headless schema %s path constraint', field => {
  const constraint = schema.properties.credentialRef.oneOf.find(form => Object.hasOwn(form.properties, field))!.properties[field]

  test.each([
    ['/tmp/credential', true],
    ['relative-credential', true],
    ['  credential  ', true],
    ['', false],
    ['   ', false],
    ['\t\n', false],
  ])('accepts %j: %s', (value, accepted) => {
    expect(constraint.type).toBe('string')
    expect(new RegExp(constraint.pattern).test(value)).toBe(accepted)
  })
})
