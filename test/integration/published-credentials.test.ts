import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { Runner } from '../../src/server/runner/runner.js'
import { withFakeService } from '../fake-service/fixture.js'

test('published LDAP resolves the hosted profile and SecretRef without a native provider or network', async () => {
  await withFakeService(async ({ directory }) => {
    const profile = loadCredentialProfile('ldap-axi', join(process.cwd(), 'tools/node_modules/@knowttl/ldap-axi/axi-credential.schema.json'))!
    const adapter = createLdapAdapter({ getCredential: async () => ({ url: 'ldaps://directory.test:636',
      auth: 'simple', bindDn: 'uid=reader', bindPassword: 'CANARY-ldap-password' }) }, profile)
    const call = await adapter.prepare(['auth', 'status', '--offline'], { id: 'synthetic-ldap', tool: 'ldap-axi', revision: 1 })
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const result = await runner.run('synthetic-user', process.execPath,
        [join(process.cwd(), 'tools/node_modules/@knowttl/ldap-axi/dist/src/cli.js'), ...call.args],
        call.environment, call.secrets, call.limits, {}, call.files)
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('auth: simple')
      expect(result.stdout).toContain('credentials: resolved')
      expect(result.stdout).toContain('connection: offline')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await runner.shutdown() }
  })
})

test.each([
  { kind: 'qux', apiVersion: '2.5', auth: 'token', token: 'CANARY-vectra-token' },
  { kind: 'qux', apiVersion: '2.5', auth: 'oauth', clientId: 'synthetic-vectra-id', clientSecret: 'CANARY-vectra-secret' },
  { kind: 'rux', apiVersion: '3.4', auth: 'oauth', clientId: 'synthetic-vectra-id', clientSecret: 'CANARY-vectra-secret' },
])('published Vectra reads the $kind $auth credential profile artium writes', async material => {
  await withFakeService(async ({ directory, port, send }) => {
    const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
    const credential = { ...material,
      origin: `https://localhost:${port}`, caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8') }
    const adapter = createVectraAdapter({ getCredential: async () => credential }, join(directory, 'writes.log'), profile)
    const call = await adapter.prepare(['detection', 'list'], { id: 'synthetic-vectra', tool: 'vectra-axi' })
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const result = await runner.run('synthetic-user', process.execPath,
        [join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/bin/vectra-axi.js'), ...call.args],
        call.environment, call.secrets, call.limits, {}, call.files)
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('0 detections')
      expect(JSON.parse(await send('/__evidence')).requests[0].canaryReceived).toBe(true)
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await runner.shutdown() }
  })
})

test.each([
  { auth: 'client-secret', clientSecret: 'CANARY-graph-secret' },
  { auth: 'certificate', privateKey: 'CANARY-graph-key', thumbprintSha256: 'a'.repeat(64) },
  { auth: 'federated', token: 'CANARY-graph-assertion' },
])('published Graph reads the $auth credential profile artium writes against fake Graph', async material => {
  await withFakeService(async ({ directory }) => {
    const profile = loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
    const credential = { mode: 'application', ...material,
      tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' }
    const adapter = createMgAdapter({ getCredential: async () => credential }, join(directory, 'writes.log'), profile)
    const call = await adapter.prepare(['entra', 'user', 'list'], { id: 'synthetic-graph', tool: 'mg-axi', revision: 1 })
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const result = await runner.run('synthetic-user', process.execPath,
        [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...call.args],
        call.environment, call.secrets, call.limits, {}, call.files)
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('Synthetic User')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await runner.shutdown() }
  })
})
