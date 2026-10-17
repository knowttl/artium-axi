import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { withFakeService } from '../../../test/fake-service/fixture.js'
import { Runner } from '../runner/runner.js'
import { createVectraAdapter, vectraCredentialSchema, vectraManifest } from './vectra.js'

const reference = { id: 'synthetic', tool: 'vectra-axi' as const }
const base = { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test', auth: 'token', token: 'CANARY-vectra-token' } as const
const variants = [
  base,
  { kind: 'qux', apiVersion: '2.5', origin: base.origin, auth: 'oauth', clientId: 'synthetic-vectra-id', clientSecret: 'CANARY-vectra-secret' },
  { kind: 'rux', apiVersion: '3.4', origin: base.origin, auth: 'oauth', clientId: 'synthetic-vectra-id', clientSecret: 'CANARY-vectra-secret' },
] as const
const binary = join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/bin/vectra-axi.js')

test.each(variants)('preparation keeps the native %j profile and secrets separate', async credential => {
  const writes = { allowWrites: true, operations: ['qux.detection.tag.set'] }
  const adapter = createVectraAdapter({ getCredential: async () => ({ ...credential, writes, caBundle: 'CANARY-CA' }) }, '/data/tool-logs/vectra-axi/writes.log')
  const call = await adapter.prepare(['detection', 'list'], reference)
  const profile = JSON.parse(call.files[0].content as string).profiles.artium
  expect(profile).toMatchObject({ kind: credential.kind, auth: credential.auth, apiVersion: credential.apiVersion,
    origin: credential.origin, writes, caBundle: 'vectra-ca.pem' })
  expect(call.files[1]).toEqual({ name: 'vectra-ca.pem', content: 'CANARY-CA' })
  expect(call.environment.VECTRA_AXI_READ_ONLY).toBe('false')
  expect(call.environment[profile.tokenEnv ?? profile.secretEnv]).toBe(credential.auth === 'token' ? credential.token : credential.clientSecret)
  expect(call.files[0].content).not.toMatch(/CANARY-vectra/)
  expect(call.secrets).toContain(credential.auth === 'token' ? credential.token : credential.clientSecret)
})

test.each([
  { ...base, token: '' }, { ...base, token: ' ' }, { ...base, kind: 'rux' },
  { ...base, origin: 'http://appliance.test' }, { ...base, origin: 'https://appliance.test/path' },
  { ...base, origin: 'https://user:password@appliance.test' }, { ...base, caBundle: '' },
  { ...base, writes: { allowWrites: true, operations: [] } }, { ...base, rejectUnauthorized: false },
])('invalid credential fails safely: %j', async credential => {
  expect(vectraCredentialSchema.safeParse(credential).success).toBe(false)
  await expect(createVectraAdapter({ getCredential: async () => credential }, '/data/writes.log')
    .prepare([], reference)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
})

test('unsafe overrides and local management fail before retrieving a credential', async () => {
  const getCredential = vi.fn()
  const adapter = createVectraAdapter({ getCredential }, '/data/writes.log')
  for (const flag of vectraManifest.unsafeOverrides) {
    for (const args of [[`--${flag}`, 'synthetic'], [`--${flag}=synthetic`], [`--${flag}=synthetic`, `--${flag}=artium`]]) {
      await expect(adapter.prepare(['detection', 'list', ...args], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
    }
  }
  for (const args of [['--', '--config=synthetic'], ['setup'], ['setup', 'hooks']]) {
    await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  }
  for (const flag of vectraManifest.inputFileFlags) {
    await expect(adapter.prepare(['detection', 'tag', 'set', `--${flag}=/data/artium.db`], reference))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  }
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(variants)('pinned %j read uses the generated profile and private CA', async variant => {
  await withFakeService(async ({ directory, port, send }) => {
    const source = { getCredential: async () => ({ ...variant, origin: `https://localhost:${port}`,
      caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8') }) }
    const adapter = createVectraAdapter(source, join(directory, 'tool-logs', 'vectra-axi', 'writes.log'))
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const call = await adapter.prepare(['detection', 'list'], reference)
      const result = await runner.run('synthetic-user', process.execPath,
        [binary, ...call.args], call.environment, call.secrets, call.limits, {}, call.files)
      expect(result).toMatchObject({ exitCode: 0, stderr: '' })
      expect(result.stdout).toContain('0 detections')
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.requests.every((request: { canaryReceived: boolean }) => request.canaryReceived)).toBe(true)
      expect(evidence.requests.map((request: { path: string }) => request.path)).toEqual(variant.auth === 'token'
        ? ['/api/v2.5/detections'] : [variant.kind === 'rux' ? '/oauth2/token' : '/api/v2.5/oauth2/token',
          variant.kind === 'rux' ? '/api/v3.4/detections/' : '/api/v2.5/detections'])
      expect(evidence.mutations).toBe(0)
      const show = await adapter.prepare(['detection', 'show', '--id', '42'], reference)
      const redacted = await runner.run('synthetic-user', process.execPath, [binary, ...show.args],
        show.environment, show.secrets, show.limits, {}, show.files)
      expect(redacted.exitCode).toBe(0)
      expect(redacted.stdout).toContain('***redacted***')
      expect(redacted.stdout).not.toContain(variant.auth === 'token' ? variant.token : variant.clientSecret)
      if (variant.auth === 'oauth') {
        expect(redacted.stdout).not.toMatch(/CANARY-vectra-minted|CANARY-vectra-refresh/)
        const encoded = await adapter.prepare(['detection', 'show', '--id', '43'], reference)
        const unknown = await runner.run('synthetic-user', process.execPath, [binary, ...encoded.args],
          encoded.environment, encoded.secrets, encoded.limits, {}, encoded.files)
        expect(unknown.stdout).toContain(Buffer.from('CANARY-vectra-minted').toString('base64'))
      }
      const beforeUntrusted = JSON.parse(await send('/__evidence')).requests
      const withoutCA = await adapter.prepare(['detection', 'list'], reference)
      const profile = JSON.parse(withoutCA.files[0].content as string)
      delete profile.profiles.artium.caBundle
      withoutCA.files = [{ name: withoutCA.files[0].name, content: JSON.stringify(profile) }]
      const untrusted = await runner.run('synthetic-user', process.execPath,
        [binary, ...withoutCA.args], withoutCA.environment, withoutCA.secrets, withoutCA.limits, {}, withoutCA.files)
      expect(untrusted.exitCode).not.toBe(0)
      expect(untrusted.stdout).toContain('TLS_TRUST_ERROR')
      expect(JSON.parse(await send('/__evidence')).requests).toEqual(beforeUntrusted)
    } finally { await runner.shutdown() }
  })
}, 15_000)
