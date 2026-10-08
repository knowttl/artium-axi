import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { withFakeService } from './fake-service/fixture.js'

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

test.each([
  [false, '42', [], 1, 0],
  [true, '42', [], 0, 0],
  [true, '42', ['--execute', '--confirm', 'detection 42'], 0, 1],
  [true, '43', ['--execute', '--confirm', 'detection 43'], 1, 1],
] as const)('Vectra native gates: writes %s, target %s, execution %j', async (enabled, id, execution, status, mutations) => {
  await withFakeService(async ({ directory, port, send }) => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const config = join(directory, 'profile.json')
    const log = join(directory, 'writes.log')
    writeFileSync(config, JSON.stringify({ defaultProfile: 'synthetic', profiles: { synthetic: {
      kind: 'qux', origin: `https://localhost:${port}`, apiVersion: '2.5', auth: 'token',
      tokenEnv: 'CANARY_TOKEN', caBundle: join(directory, 'ca.crt'),
      ...(enabled ? { writes: { allowWrites: true, operations: ['qux.detection.tag.set'] } } : {}),
    } } }))
    const result = spawnSync(process.execPath, [join(root, 'tools/node_modules/@knowttl/vectra-axi/bin/vectra-axi.js'),
      'detection', 'tag', 'set', '--config', config, '--id', id, '--tags', 'synthetic', ...execution], {
      encoding: 'utf8', timeout: 3000, env: { HOME: directory, PATH: process.env.PATH,
        CANARY_TOKEN: 'CANARY-synthetic', VECTRA_AXI_WRITE_LOG: log },
    })
    expect(result.status, result.stdout + result.stderr).toBe(status)
    const evidence = JSON.parse(await send('/__evidence'))
    expect(evidence.mutations).toBe(mutations)
    if (!enabled) expect(result.stdout).toContain('WRITES_DISABLED')
    if (mutations) expect(readFileSync(log, 'utf8')).not.toContain('CANARY-synthetic')
  })
})
