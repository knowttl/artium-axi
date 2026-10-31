import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { withFakeService } from '../fake-service/fixture.js'

const tokenArgs = ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--output', 'json']
const token = 'CANARY-AZURE-ACCESS-TOKEN'
const expiry = '2030-01-01 00:00:00'
const environment = { PATH: '/usr/bin:/bin', ARTIUM_SECRET_0: token, ARTIUM_ADO_EXPIRES_ON: expiry }

test('the pinned ado-axi requests exactly the supported six az arguments', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const profile = join(directory, 'profile.json')
    const record = join(directory, 'az-argv')
    writeFileSync(profile, JSON.stringify({ defaultProfile: 'artium', profiles: { artium: { org: 'synthetic-org', auth: 'az' } } }))
    const result = spawnSync(process.execPath, ['--import', join(process.cwd(), 'test/fake-service/ado-transport.mjs'),
      join(process.cwd(), 'tools/node_modules/@knowttl/ado-axi/dist/bin/ado-axi.js'), 'project', 'list'], {
      encoding: 'utf8', timeout: 10_000, cwd: directory,
      env: { PATH: `${join(process.cwd(), 'test/fixtures/ado-recording-az')}:/usr/bin:/bin`, HOME: directory,
        ADO_AXI_CONFIG: profile, ARTIUM_TEST_AZ_RECORD: record, ARTIUM_TEST_ADO_ORIGIN: `https://localhost:${port}`,
        NODE_EXTRA_CA_CERTS: join(directory, 'ca.crt') },
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(readFileSync(record, 'utf8').trimEnd().split('\n')).toEqual(tokenArgs)
    expect(JSON.parse(await send('/__evidence')).requests).toContainEqual(expect.objectContaining({
      method: 'GET', path: '/synthetic-org/_apis/projects', auth: 'Bearer', canaryReceived: true,
    }))
  })
})

test('the stand-in returns a Bearer token only for the exact supported request', () => {
  const result = spawnSync('libexec/ado-axi/az', tokenArgs, { env: environment, encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ accessToken: token, expiresOn: expiry, tokenType: 'Bearer' })
  expect(result.stderr).toBe('')
})

test.each([
  [], ['login'], ['account', 'show'], [...tokenArgs, '--tenant', 'synthetic-tenant'], tokenArgs.slice(0, -1),
  ['account', 'get-access-token', '--output', 'json', '--resource', tokenArgs[3]],
  ['account', 'get-access-token', '--resource', 'https://management.azure.com/', '--output', 'json'],
].map(args => [args]))('the stand-in refuses unsupported argv without disclosing the token: %j', args => {
  const result = spawnSync('libexec/ado-axi/az', args, { env: environment, encoding: 'utf8' })
  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('Unsupported token request.\n')
  expect(result.stderr).not.toMatch(/az login|not logged in|AADSTS|Please run/)
})

test.each(['', 'CANARY"token', 'CANARY\\token', 'CANARY\ntoken', 'CANARY token', 'CANARY+token', 'CANARY/token', 'CANARY=token', 'CANARY-☃'])(
  'the stand-in refuses invalid token bytes: %j', value => {
    const result = spawnSync('libexec/ado-axi/az', tokenArgs, { env: { ...environment, ARTIUM_SECRET_0: value }, encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Unsupported token request.\n')
  })

test.each(['', '2030-01-01"', '2030-01-01\nCANARY', '2030\\01\\01'])(
  'the stand-in refuses invalid expiry bytes: %j', value => {
    const result = spawnSync('libexec/ado-axi/az', tokenArgs, { env: { ...environment, ARTIUM_ADO_EXPIRES_ON: value }, encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Unsupported token request.\n')
  })
