import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { withFakeService } from './fake-service/fixture.js'

test('fake TLS certificates verify at a fixed time before issuance', async () => {
  await withFakeService(async ({ directory }) => {
    const result = spawnSync('openssl', ['verify', '-attime', '1735689600',
      '-CAfile', join(directory, 'ca.crt'), '-purpose', 'sslserver', '-verify_hostname', 'localhost',
      join(directory, 'server.crt')], { encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
})

test('fake HTTPS service trusts only its test CA and records ambiguous mutations', async () => {
  await withFakeService(async ({ port, send }) => {
    await expect(send('/', 'GET', false)).rejects.toThrow()
    expect(JSON.parse(await send('/'))).toEqual({ value: [] })
    expect(JSON.parse(await send('/synthetic', 'PATCH')).error.code).toBe('SyntheticAmbiguousWrite')
    expect(JSON.parse(await send('/__evidence'))).toEqual({ mutations: 1, requests: [
      { method: 'GET', host: `localhost:${port}`, path: '/', canaryReceived: true },
      { method: 'PATCH', host: `localhost:${port}`, path: '/synthetic', canaryReceived: true },
    ] })
  })
})

test('fake pagination serves distinct items and a terminal second page', async () => {
  await withFakeService(async ({ send }) => {
    const first = JSON.parse(await send('/page'))
    expect(first).toEqual({ value: [{ id: 'synthetic-page-1' }],
      nextLink: 'https://management.azure.com/page-next?api-version=2022-12-01' })
    const second = JSON.parse(await send(new URL(first.nextLink).pathname))
    expect(second).toEqual({ value: [{ id: 'synthetic-page-2' }] })
  })
})

test.each([
  [false, '42', [], 1, 0, 'WRITES_DISABLED', false],
  [true, '42', [], 0, 0, 'current:', false],
  [true, '42', ['--execute', '--confirm', 'detection 42'], 0, 1, 'audit:', true],
  [true, '43', ['--execute', '--confirm', 'detection 43'], 1, 1, 'error:', true],
] as const)('Vectra native gates: writes %s, target %s, execution %j', async (enabled, id, execution, status, mutations, output, logged) => {
  await withFakeService(async ({ directory, port, send }) => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const config = join(directory, 'profile.json')
    const log = join(directory, 'writes.log')
    writeFileSync(config, JSON.stringify({ version: 1, defaultProfile: 'synthetic', profiles: { synthetic: {
      kind: 'qux', origin: `https://localhost:${port}`, apiVersion: '2.5', auth: 'token',
      token: { env: 'CANARY_TOKEN' }, caBundle: join(directory, 'ca.crt'),
      ...(enabled ? { writes: { allowWrites: true, operations: ['qux.detection.tag.set'] } } : {}),
    } } }), { mode: 0o600 })
    const result = spawnSync(process.execPath, [join(root, 'tools/node_modules/@knowttl/vectra-axi/bin/vectra-axi.js'),
      'detection', 'tag', 'set', '--config', config, '--id', id, '--tags', 'synthetic', ...execution], {
      encoding: 'utf8', timeout: 3000, env: { HOME: directory, PATH: process.env.PATH,
        CANARY_TOKEN: 'CANARY-synthetic', VECTRA_AXI_WRITE_LOG: log },
    })
    expect(result.status, result.stdout + result.stderr).toBe(status)
    const evidence = JSON.parse(await send('/__evidence'))
    expect(evidence.mutations).toBe(mutations)
    expect(result.stdout).toContain(output)
    expect(existsSync(log)).toBe(logged)
  })
})
