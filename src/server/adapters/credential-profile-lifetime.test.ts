import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import schema from '../../../test/fixtures/axi-credential.schema.json' with { type: 'json' }
import { CredentialProfile } from './credential-profile.js'
import { Runner } from '../runner/runner.js'

// Proposed contract custody checks only. No tool is admitted for this lifetime.
const worker = fileURLToPath(new URL('../../../test/fixtures/credential-worker.mjs', import.meta.url))
const credential = { mode: 'application', auth: 'client-secret',
  tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222',
  clientSecret: 'CANARY-selected secret"/+' }
let root: string
let runner: Runner
let prepared: ReturnType<CredentialProfile['prepare']>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artium-lifetime-contract-'))
  runner = await Runner.create(root)
  prepared = new CredentialProfile(schema).prepare('mg-axi', credential, join(root, 'writes.log'), true)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await runner.shutdown()
  await rm(root, { recursive: true, force: true })
})

function run(commands: string) {
  return runner.run('synthetic-owner', process.execPath, [worker], prepared.environment, prepared.secrets,
    {}, { stdin: commands }, prepared.files)
}

test('connection worker resolves the same private artium profile across commands until close', async () => {
  const result = await run('inspect\ninspect\nclose\n')
  expect(result.exitCode).toBe(0)
  const [first, second] = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(second).toEqual(first)
  expect(first.profile).toEqual({ version: 1, defaultProfile: 'artium', profiles: { artium: {
    ...credential, clientSecret: { env: 'ARTIUM_SECRET_0' },
  } } })
  expect(first.resolved).toBe(true)
  expect(first.profileMode).toBe(0o600)
  expect(first.homeFiles).toEqual([])
  const directory = dirname(first.directories.HOME.path)
  expect(first.directories).toEqual(Object.fromEntries(Object.entries({ HOME: 'home', TMPDIR: 'tmp',
    XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state',
    XDG_RUNTIME_DIR: 'runtime' }).map(([name, leaf]) => [name, { path: join(directory, leaf), mode: 0o700 }])))
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(root)).toEqual([])
})

test('worker crash removes its private profile and directories', async () => {
  await expect(run('inspect\ncrash\n')).rejects.toMatchObject({ code: 'PROCESS_SIGNAL' })
  expect(await readdir(root)).toEqual([])
})

test('restart removes abandoned connection profiles before the first new worker is admitted', async () => {
  await runner.shutdown()
  const abandoned = join(root, 'artium-call-abandoned', 'config', 'mg-axi')
  await mkdir(abandoned, { recursive: true, mode: 0o700 })
  await writeFile(join(abandoned, 'config.json'), prepared.files[0].content, { mode: 0o600 })
  runner = await Runner.create(root)
  await expect(readFile(join(abandoned, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(root)).toEqual([])
  expect(await run('inspect\nclose\n')).toMatchObject({ exitCode: 0 })
})

test('worker receives only the selected credential and trusted runtime environment without ambient fallback', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/synthetic/agent')
  vi.stubEnv('SSH_AGENT_PID', '123')
  vi.stubEnv('MG_AXI_CONFIG', '/synthetic/developer/config.json')
  vi.stubEnv('ARTIUM_SECRET_99', 'CANARY-unselected')
  const result = await run('inspect\nclose\n')
  const snapshot = JSON.parse(result.stdout)
  expect(snapshot.environmentNames).toEqual(['ARTIUM_SECRET_0', 'HOME', 'MG_AXI_READ_ONLY', 'MG_AXI_WRITE_LOG',
    'NODE_OPTIONS', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR', 'XDG_STATE_HOME'])
  expect(snapshot.resolved).toBe(true)
  expect(() => new CredentialProfile(schema).prepare('mg-axi', { ...credential, clientSecret: undefined },
    join(root, 'writes.log'), true)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
})

test.each([
  ['stdout', 'raw', ''], ['stderr', 'raw', 'inspect\n'],
  ['stdout', 'url', 'inspect\n'], ['stderr', 'base64', 'inspect\n'], ['stdout', 'json', 'inspect\n'],
])('parent discards %s %s canary output across the worker lifetime after %j', async (stream, form, preceding) => {
  const failure = await run(`${preceding}${stream}:${form}\nclose\n`).catch(error => error)
  expect(failure).toMatchObject({ code: 'SECRET_IN_OUTPUT' })
  expect(failure.stdout).toBeUndefined()
  expect(failure.stderr).toBeUndefined()
  expect(JSON.stringify(failure)).not.toContain('CANARY')
  expect(await readdir(root)).toEqual([])
})
