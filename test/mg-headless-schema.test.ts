import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, test } from 'vitest'

const schema = JSON.parse(readFileSync(
  new URL('../tools/inventories/mg-axi-headless.schema.json', import.meta.url), 'utf8',
))
const validate = new Ajv2020({ strict: false }).compile(schema)
const identity = { mode: 'application', tenantId: '00000000-0000-0000-0000-000000000001',
  clientId: '00000000-0000-0000-0000-000000000002', auth: 'client-secret' }

test.each([
  [{ clientSecret: { env: 'CANARY_SECRET' } }, true],
  [{ clientSecret: { file: '/tmp/credential' } }, true],
  [{ clientSecret: { file: 'relative-credential' } }, false],
  [{ clientSecret: 'CANARY-inline' }, false],
  [{ clientSecret: { stored: true } }, false],
  [{ clientSecret: { env: 'CANARY_SECRET' }, enabledPacks: ['entra', 'security'] }, true],
  [{ clientSecret: { env: 'CANARY_SECRET' }, enabledPacks: ['security'] }, false],
  [{ clientSecret: { env: 'CANARY_SECRET' }, enabledPacks: ['entra', 'unknown'] }, false],
  [{ mode: 'delegated', auth: undefined, token: { stored: true } }, false],
  [{ auth: 'certificate', privateKey: { env: 'CANARY_KEY' }, thumbprintSha256: 'a'.repeat(64) }, true],
  [{ auth: 'certificate', privateKey: { env: 'CANARY_KEY' }, thumbprintSha256: 'a'.repeat(40) }, false],
])('headless application schema validates %j: %s', (fields, accepted) => {
  expect(validate({ ...identity, ...fields })).toBe(accepted)
})
