import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { SessionStore } from '../src/cli/session.js'
import { ArtiumError, errorResponse } from '../src/shared/errors.js'
import { cliVersion } from '../src/shared/version.js'

const execute = promisify(execFile)
const directory = mkdtempSync(join(tmpdir(), 'artium-package-'))
let binary: string
let url: string
let refused = false
let granted = true
let requests: string[] = []
const server = createServer((request, reply) => {
  requests.push(request.url!)
  reply.setHeader('content-type', 'application/json')
  if (refused) { reply.writeHead(401).end(JSON.stringify(errorResponse(new ArtiumError('TOKEN_INVALID'), 'synthetic-request'))); return }
  if (request.url === '/v1/auth/login') {
    reply.end(JSON.stringify({ status: 'authenticated', accessToken: 'CANARY-package-access', refreshToken: 'CANARY-package-refresh',
      accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 }))
  } else if (request.headers.authorization !== 'Bearer CANARY-package-access') {
    reply.writeHead(401).end(JSON.stringify(errorResponse(new ArtiumError('TOKEN_INVALID'), 'synthetic-request')))
  } else if (request.url === '/v1/skills') reply.end(JSON.stringify({ skills: [] }))
  else if (request.url === '/v1/tools') reply.end(JSON.stringify({ tools: granted ? [{ name: 'az-axi', version: 'synthetic', status: 'ok', readOnly: true }] : [] }))
  else if (request.url === '/v1/me') reply.end(JSON.stringify({ username: 'synthetic-user', displayName: 'Synthetic User',
    administrator: false, roles: [], accessExpiresAt: Date.now() + 3_600_000, sessionExpiresAt: Date.now() + 43_200_000 }))
  else reply.writeHead(404).end('{}')
})

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-npm.mjs'])
  const npmEnv = { PATH: process.env.PATH, HOME: directory, NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_UPDATE_NOTIFIER: 'false' }
  const packed = JSON.parse(execFileSync('npm', ['pack', './dist/npm', '--json', '--pack-destination', directory], { encoding: 'utf8', env: npmEnv }))[0]
  const prefix = join(directory, 'install')
  execFileSync('npm', ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', join(directory, 'cache'), join(directory, packed.filename)],
  { env: npmEnv, encoding: 'utf8' })
  binary = join(prefix, 'bin/artium-axi')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 30_000)
beforeEach(() => { refused = false; granted = true; requests = [] })
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

function environment() {
  const home = mkdtempSync(join(directory, 'home-'))
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'),
    CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), OPENCODE_CONFIG_DIR: join(home, 'opencode'),
    ARTIUM_AXI_TEST_HTTP: '1' }
}
function signedIn() {
  const env = { ...environment(), ARTIUM_AXI_URL: url }
  const store = new SessionStore(url, join(env.XDG_CONFIG_HOME, 'artium-axi/session.json'))
  store.write({ status: 'authenticated', accessToken: 'CANARY-package-access', refreshToken: 'CANARY-package-refresh',
    accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 })
  return env
}
async function run(args: string[], env: NodeJS.ProcessEnv, executable = binary, input?: string) {
  try {
    const pending = execute(process.execPath, [executable, ...args], { env, cwd: directory, timeout: 12_000 })
    if (input !== undefined) pending.child.stdin!.end(input)
    return { ...await pending, code: 0 }
  } catch (error) { return error as { code: number, stdout: string, stderr: string } }
}
function read(path: string) { return readFileSync(path, 'utf8') }
function write(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function hookPath(host: string, env: ReturnType<typeof environment>) {
  return host === 'codex' ? join(env.CODEX_HOME, 'hooks.json') : host === 'claude'
    ? join(env.CLAUDE_CONFIG_DIR, 'settings.json') : join(env.OPENCODE_CONFIG_DIR, 'plugins/artium-axi.js')
}
async function ambient(host: string, env: ReturnType<typeof environment>) {
  const path = hookPath(host, env)
  if (host !== 'opencode') {
    const hook = JSON.parse(read(path)).hooks.SessionStart.at(-1).hooks[0]
    return (await execute('sh', ['-c', hook.command], { env, cwd: directory, timeout: 12_000 })).stdout
  }
  const script = `const { Artium } = await import(${JSON.stringify(path)}); const hooks = await Artium({directory: process.cwd()});
    const output = {system: ['existing system context']}; await hooks['experimental.chat.system.transform']({}, output);
    console.log(JSON.stringify(output));`
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { env, cwd: directory, timeout: 12_000 })
  const output = JSON.parse(stdout)
  expect(output.system[0]).toBe('existing system context')
  return output.system[1] as string
}

test.each(['--version', '-v', '-V'])('installed public package prints only its version for %s with no configuration or writes', async flag => {
  const env = environment()
  expect(await run([flag], env)).toEqual({ code: 0, stdout: `${cliVersion}\n`, stderr: '' })
  expect(readdirSync(env.HOME)).toEqual([])
  expect(requests).toEqual([])
})

test.each(['configuration', 'authentication', 'connectivity'])('installed home identifies itself before a %s failure without session data', async failure => {
  const env = failure === 'configuration' ? environment() : signedIn()
  if (failure === 'authentication') refused = true
  if (failure === 'connectivity') {
    const closed = createServer()
    closed.listen(0, '127.0.0.1')
    await once(closed, 'listening')
    const offline = `http://127.0.0.1:${(closed.address() as { port: number }).port}`
    await new Promise<void>(resolve => closed.close(() => resolve()))
    Object.assign(env, { ARTIUM_AXI_URL: offline })
    new SessionStore(offline, join(env.XDG_CONFIG_HOME, 'artium-axi/session.json')).write({ status: 'authenticated',
      accessToken: 'CANARY-package-access', refreshToken: 'CANARY-package-refresh', accessExpiresAt: Date.now() + 3_600_000,
      familyExpiresAt: Date.now() + 43_200_000 })
  }
  const result = await run([], env)
  expect(result.code).toBe(failure === 'configuration' ? 2 : 1)
  expect(result.stderr).toBe('')
  expect(result.stdout).toMatch(/^bin: "\/[^\n]+"\ndescription: Run managed upstream tools through one local sign-in\.\nerror:\n/)
  expect(result.stdout).toContain({ configuration: 'CLIENT_CONFIG_INVALID', authentication: 'TOKEN_INVALID', connectivity: 'SERVER_UNAVAILABLE' }[failure]!)
  expect(result.stdout).not.toMatch(/CANARY|user:|roles\[|sessionExpiresAt:|accessExpiresAt:/)
})

test('clean offline package install signs in and discovers with saved connection settings', async () => {
  const env = { ...environment(), ARTIUM_AXI_URL: url }
  expect(await run(['login', '--username', 'synthetic-user', '--password-stdin'], env, binary, 'CANARY-password\n'))
    .toEqual({ code: 0, stdout: 'status: authenticated\nnext: artium-axi tools\n', stderr: '' })
  const saved = { ...env, ARTIUM_AXI_URL: undefined }
  const home = await run([], saved)
  expect(home).toMatchObject({ code: 0, stderr: '', stdout: expect.stringContaining('user: "synthetic-user"') })
  expect(home.stdout).toContain('az-axi,ok,"synthetic",true')
  expect((await run(['tools'], saved)).stdout).toContain('az-axi,ok,"synthetic",true')
  expect(readdirSync(env.HOME)).toEqual(['config'])
})

test.each(['claude', 'codex', 'opencode'])('%s ambient integration executes current grants and discloses authentication and offline failures', async host => {
  const env = signedIn()
  expect(await run(['setup', '--host', host, '--hook'], env)).toMatchObject({ code: 0, stderr: '' })
  requests = []
  expect(await ambient(host, env)).toBe('artium: available\ntools[1]{name,status,readOnly}:\n  az-axi,ok,true\nnext: artium-axi tools\nnote: Server roles and write gates still apply.\n')
  expect(requests).toEqual(['/v1/tools'])
  granted = false
  expect(await ambient(host, env)).toBe('artium: available\ntools[0]{name,status,readOnly}:\n\nnext: artium-axi tools\nnote: Server roles and write gates still apply.\n')
  refused = true
  expect(await ambient(host, env)).toBe('artium: unavailable\nreason: TOKEN_INVALID\nnote: Current tool access could not be verified; no cached grants are shown.\nnext: artium-axi doctor\n')
  env.ARTIUM_AXI_URL = 'http://127.0.0.1:1'
  new SessionStore(env.ARTIUM_AXI_URL, join(env.XDG_CONFIG_HOME, 'artium-axi/session.json')).write({ status: 'authenticated',
    accessToken: 'CANARY-package-access', refreshToken: 'CANARY-package-refresh', accessExpiresAt: Date.now() + 3_600_000,
    familyExpiresAt: Date.now() + 43_200_000 })
  expect(await ambient(host, env)).toBe('artium: unavailable\nreason: SERVER_UNAVAILABLE\nnote: Current tool access could not be verified; no cached grants are shown.\nnext: artium-axi doctor\n')
})

test.each(['codex', 'opencode'])('%s setup repeats without writes and repairs the relocated executable', async host => {
  const env = signedIn()
  const args = ['setup', '--host', host, '--hook']
  expect(await run(args, env)).toMatchObject({ code: 0 })
  const path = hookPath(host, env)
  const content = read(path)
  const modified = statSync(path).mtimeMs
  expect(await run(args, env)).toMatchObject({ code: 0 })
  expect(read(path)).toBe(content)
  expect(statSync(path).mtimeMs).toBe(modified)
  const relocated = join(directory, `${host}-relocated.mjs`)
  copyFileSync(binary, relocated)
  expect(await run(args, env, relocated)).toMatchObject({ code: 0 })
  expect(await ambient(host, env)).toContain('az-axi,ok,true')
  expect(read(path)).not.toBe(content)
})

test('Codex setup preserves other hooks and settings and refuses invalid hooks without partial skill writes', async () => {
  const env = signedIn()
  const path = hookPath('codex', env)
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }], Stop: [] }, description: 'local hooks' }
  write(path, JSON.stringify(settings))
  const config = join(env.CODEX_HOME, 'config.toml')
  write(config, '[features]\nhooks = false\n')
  expect(await run(['setup', '--host', 'codex', '--hook'], env)).toMatchObject({ code: 0, stdout: expect.stringContaining('must be enabled') })
  expect(read(config)).toBe('[features]\nhooks = false\n')
  const installed = JSON.parse(read(path))
  expect(installed.description).toBe('local hooks')
  expect(installed.hooks.SessionStart[0]).toEqual(settings.hooks.SessionStart[0])
  expect(installed.hooks.Stop).toEqual([])
  const invalid = signedIn()
  write(hookPath('codex', invalid), 'invalid json')
  expect(await run(['setup', '--host', 'codex', '--hook'], invalid)).toMatchObject({ code: 2 })
  expect(read(hookPath('codex', invalid))).toBe('invalid json')
  expect(readdirSync(invalid.HOME).sort()).toEqual(['codex', 'config'])
})

test('OpenCode setup refuses unmanaged plugins and repairs only with explicit force', async () => {
  const env = signedIn()
  const path = hookPath('opencode', env)
  write(path, 'export const Local = async () => ({})\n')
  const args = ['setup', '--host', 'opencode', '--hook']
  expect(await run(args, env)).toMatchObject({ code: 2, stdout: expect.stringContaining('unmanaged') })
  expect(read(path)).toBe('export const Local = async () => ({})\n')
  expect(readdirSync(env.OPENCODE_CONFIG_DIR)).toEqual(['plugins'])
  expect(await run([...args, '--force'], env)).toMatchObject({ code: 0 })
  expect(await ambient('opencode', env)).toContain('az-axi,ok,true')
})

test('OpenCode setup refuses an invalid plugin directory without writing skills', async () => {
  const env = signedIn()
  write(join(env.OPENCODE_CONFIG_DIR, 'plugins'), 'local file')
  expect(await run(['setup', '--host', 'opencode', '--hook'], env)).toMatchObject({ code: 1 })
  expect(read(join(env.OPENCODE_CONFIG_DIR, 'plugins'))).toBe('local file')
  expect(readdirSync(env.OPENCODE_CONFIG_DIR)).toEqual(['plugins'])
})

test.each(['claude', 'codex', 'opencode'])('%s discovery preserves installed host files and authentication failure prevents setup writes', async host => {
  const env = signedIn()
  const path = hookPath(host, env)
  expect(await run(['setup', '--host', host, '--hook'], env)).toMatchObject({ code: 0 })
  const previous = read(path)
  const modified = statSync(path).mtimeMs
  expect(await run([], env)).toMatchObject({ code: 0 })
  expect(await run(['tools'], env)).toMatchObject({ code: 0 })
  expect(await run(['--help'], env)).toMatchObject({ code: 0 })
  expect(read(path)).toBe(previous)
  expect(statSync(path).mtimeMs).toBe(modified)
  refused = true
  expect(await run(['setup', '--host', host, '--hook'], env)).toMatchObject({ code: 1, stdout: expect.stringContaining('TOKEN_INVALID') })
  expect(read(path)).toBe(previous)
  expect(statSync(path).mtimeMs).toBe(modified)
})

test.each(['codex', 'opencode'])('%s uses a matching PATH binary but never skips an earlier different binary', async host => {
  const env = signedIn()
  const bin = join(env.HOME, 'bin')
  mkdirSync(bin)
  symlinkSync(binary, join(bin, 'artium-axi'))
  env.PATH = `${bin}:${process.env.PATH}`
  expect(await run(['setup', '--host', host, '--hook'], env)).toMatchObject({ code: 0 })
  expect(await ambient(host, env)).toContain('az-axi,ok,true')
  const other = join(env.HOME, 'other/artium-axi')
  write(other, '#!/bin/sh\nprintf "wrong binary\\n"\n')
  chmodSync(other, 0o700)
  env.PATH = `${dirname(other)}:${env.PATH}`
  expect(await run(['setup', '--host', host, '--hook'], env)).toMatchObject({ code: 0 })
  expect(await ambient(host, env)).toContain('az-axi,ok,true')
})

test('OpenCode setup honors XDG configuration when its explicit directory override is absent', async () => {
  const env = { ...signedIn(), OPENCODE_CONFIG_DIR: undefined }
  expect(await run(['setup', '--host', 'opencode', '--hook'], env)).toMatchObject({ code: 0 })
  const path = join(env.XDG_CONFIG_HOME, 'opencode/plugins/artium-axi.js')
  const active = { ...env, OPENCODE_CONFIG_DIR: join(env.XDG_CONFIG_HOME, 'opencode') }
  expect(await ambient('opencode', active)).toContain('az-axi,ok,true')
  const previous = read(path) + '// local edit\n'
  write(path, previous)
  expect(await run(['setup', '--host', 'opencode', '--hook'], env)).toMatchObject({ code: 2 })
  expect(read(path)).toBe(previous)
})

test('OpenCode reports a missing relocated executable as unavailable context', async () => {
  const env = signedIn()
  const relocated = join(directory, 'removed-client.mjs')
  copyFileSync(binary, relocated)
  expect(await run(['setup', '--host', 'opencode', '--hook'], env, relocated)).toMatchObject({ code: 0 })
  rmSync(relocated)
  expect(await ambient('opencode', env)).toBe('artium: unavailable\nreason: CLIENT_START_FAILED\nnote: Current tool access could not be verified.\nnext: artium-axi doctor\n')
})
