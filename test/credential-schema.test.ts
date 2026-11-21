import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { loadCredentialProfile } from '../src/server/adapters/credential-profile.js'
import { evaluateCredentialSchema } from '../src/views/credential-schema.js'

const applicationSchema = {
  type: 'object',
  required: ['tenantId'],
  oneOf: [
    { properties: { auth: { const: 'secret' } }, required: ['clientSecret'], not: { anyOf: [{ required: ['privateKey'] }, { required: ['thumbprint'] }] } },
    { properties: { auth: { const: 'certificate' } }, required: ['privateKey', 'thumbprint'], not: { required: ['clientSecret'] } },
  ],
}

const conditionalSchema = {
  type: 'object',
  allOf: [
    { if: { properties: { origin: { pattern: '^https://' } } }, then: { required: ['token'] }, else: { required: ['username'], not: { required: ['token'] } } },
    { if: { required: ['region'], properties: { kind: { enum: ['qux'] } } }, then: { required: ['apiVersion'] } },
  ],
}

const evaluate = (schema: Record<string, unknown>, current: Record<string, unknown>, identity: Record<string, unknown> = {}, configured = false) => {
  const { required, forbidden, sameIdentity } = evaluateCredentialSchema(schema, identity, configured, current)
  return { required: [...required].sort(), forbidden: [...forbidden].sort(), sameIdentity }
}

test.each([
  ['no selector chosen yet', applicationSchema, {}, ['tenantId'], []],
  ['the secret branch requires its secret and forbids certificate material', applicationSchema, { auth: 'secret' }, ['clientSecret', 'tenantId'], ['privateKey', 'thumbprint']],
  ['the certificate branch requires its key and forbids the secret', applicationSchema, { auth: 'certificate' }, ['privateKey', 'tenantId', 'thumbprint'], ['clientSecret']],
  ['a pattern condition selects the matching branch', conditionalSchema, { origin: 'https://synthetic.invalid' }, ['token'], []],
  ['a failed pattern condition selects the else branch', conditionalSchema, { origin: 'http://synthetic.invalid' }, ['username'], ['token']],
  ['a missing origin fails its pattern condition', conditionalSchema, {}, ['username'], ['token']],
  ['required keys and selector enums gate a condition together', conditionalSchema, { region: 'us-1', kind: 'qux' }, ['apiVersion', 'username'], ['token']],
  ['a condition without its required key does not apply', conditionalSchema, { kind: 'qux' }, ['username'], ['token']],
])('%s', (_name, schema, current, required, forbidden) => {
  expect(evaluate(schema, current)).toMatchObject({ required, forbidden })
})

test.each([
  ['an unconfigured credential never keeps secrets', { auth: 'secret', tenantId: 'tenant-a' }, { auth: 'secret', tenantId: 'tenant-a' }, false, false],
  ['an unchanged identity keeps stored secrets', { auth: 'secret', tenantId: 'tenant-a' }, { auth: 'secret', tenantId: 'tenant-a' }, true, true],
  ['a changed identity field needs new secrets', { auth: 'secret', tenantId: 'tenant-b' }, { auth: 'secret', tenantId: 'tenant-a' }, true, false],
  ['a cleared identity field needs new secrets', { auth: 'secret', tenantId: null }, { auth: 'secret', tenantId: 'tenant-a' }, true, false],
])('%s', (_name, current, identity, configured, sameIdentity) => {
  expect(evaluate(applicationSchema, current, identity, configured).sameIdentity).toBe(sameIdentity)
})

test('Graph delegated mode excludes application authentication and keeps the delegated identity', () => {
  const path = fileURLToPath(new URL('../tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json', import.meta.url))
  const { inputSchema } = loadCredentialProfile('mg-axi', path)!
  const identity = { mode: 'delegated', tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222', auth: null }
  expect(evaluate(inputSchema, identity, identity, true).required).toEqual(['clientId', 'mode', 'tenantId', 'token'])
  expect(evaluate(inputSchema, { ...identity, auth: 'client-secret' }, identity, true)).toMatchObject({
    forbidden: ['auth', 'clientSecret', 'privateKey', 'thumbprintSha256'], sameIdentity: true,
  })
})
