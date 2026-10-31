import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { Client } from '../src/cli/http.js'
import { setup } from '../src/cli/setup.js'
import { SessionStore } from '../src/cli/session.js'
import { loadToolSkill } from '../src/server/tool-skills.js'
import { toolSchema } from '../src/shared/api.js'
import type { ToolName } from '../src/server/store/credential-store.js'

vi.mock('../skill/artium-axi/SKILL.md', () => ({ default: readFileSync('skill/artium-axi/SKILL.md', 'utf8') }))

const execute = promisify(execFile)
const directory = mkdtempSync(join(tmpdir(), "artium-setup-$&-$`-$'-$$-"))
const bundle = join(directory, 'standalone.mjs')
let granted: ToolName[] = []
let skillResponse: unknown
let url: string
const sessions = new Map<string, string>()
const server = createServer((request, reply) => {
  if (request.url !== '/v1/skills' || request.headers.authorization !== 'Bearer CANARY-access') {
    reply.writeHead(401).end()
    return
  }
  reply.setHeader('content-type', 'application/json')
  reply.end(JSON.stringify(skillResponse ?? { skills: granted.map(name => ({ name,
    content: loadToolSkill(name, name === 'gh-axi' ? 'tools/node_modules/gh-axi/skills/gh-axi/SKILL.md' : name === 'falcon-axi' ? 'test/fixtures/falcon-SKILL.md' : name === 'awx-axi' ? 'tools/skills/awx-axi/SKILL.md' : name === 'ado-axi' ? 'tools/node_modules/@jeffreyhaen/ado-axi/SKILL.md' : `tools/node_modules/@knowttl/${name}/skills/${name}/SKILL.md`) })) }))
})
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'])
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
beforeEach(() => { granted = []; skillResponse = undefined })
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  rmSync(directory, { recursive: true, force: true })
})

function home() { return mkdtempSync(join(directory, 'home-')) }
function read(path: string) { return readFileSync(path, 'utf8') }
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

test('Windows setup installs labelled PowerShell and Git Bash invocations in every skill', async () => {
  const target = home()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')!
  const executable = process.argv[1]
  vi.stubEnv('CLAUDE_CONFIG_DIR', target)
  vi.stubEnv('ARTIUM_AXI_URL', 'https://synthetic.invalid')
  vi.stubEnv('APPDATA', target)
  vi.spyOn(Client.prototype, 'authenticated').mockResolvedValue({ skills: [{ name: 'az-axi',
    content: '---\nname: az-axi\n---\n\nSynthetic tool skill.\n' }] })
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'execPath', { value: 'C:\\Program Files\\nodejs\\node.exe' })
    process.argv[1] = '/synthetic/artium-axi.mjs'
    await setup(['--host', 'claude'])
    for (const name of ['artium-axi', 'az-axi']) {
      const content = read(join(target, 'skills', name, 'SKILL.md'))
      expect(content.match(/<!-- artium-axi executable -->[\s\S]*?<!-- \/artium-axi executable -->/)?.[0]).toMatchInlineSnapshot(`
        "<!-- artium-axi executable -->

        PowerShell:

        \`\`\`powershell
        & 'C:\\Program Files\\nodejs\\node.exe' '/synthetic/artium-axi.mjs'
        \`\`\`

        Git Bash:

        \`\`\`sh
        \"C:/Program Files/nodejs/node.exe\" \"/synthetic/artium-axi.mjs\"
        \`\`\`

        <!-- /artium-axi executable -->"
      `)
    }
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'execPath', execPath)
    process.argv[1] = executable
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
})
async function cli(home: string, args: string[], executable = bundle, claudeConfigDir?: string, piAgentDir?: string) {
  if (!sessions.has(home)) {
    const config = mkdtempSync(join(directory, 'session-'))
    sessions.set(home, config)
    new SessionStore(url, join(config, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: 'CANARY-access',
      refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 })
  }
  try {
    return { ...await execute(process.execPath, [executable, ...args], { cwd: directory, timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: sessions.get(home), ARTIUM_AXI_URL: url,
        ARTIUM_AXI_TEST_HTTP: '1', CLAUDE_CONFIG_DIR: claudeConfigDir, PI_CODING_AGENT_DIR: piAgentDir,
        OPENCODE_CONFIG_DIR: join(home, '.config/opencode') } }), code: 0 }
  } catch (error) { return error as { stdout: string, stderr: string, code: number } }
}

test.each([
  ['claude', '.claude/skills'], ['codex', '.agents/skills'], ['opencode', '.config/opencode/skills'],
  ['pi', '.pi/agent/skills'],
])('standalone setup installs the base skill with no grants for %s and repeats without writes', async (host, location) => {
  const target = home()
  const args = ['setup', '--host', host]
  expect(await cli(target, args)).toMatchObject({ code: 0, stderr: '', stdout: expect.stringContaining('artium-axi,installed') })
  const path = join(target, location, 'artium-axi/SKILL.md')
  const content = read(path)
  expect(content).toContain('## Investigation quick guide')
  expect(content).toContain(bundle.replaceAll("'", "'\\''"))
  expect(content).not.toContain('The setup command records')
  expect(readdirSync(dirname(path))).toEqual(['SKILL.md'])
  expect(readdirSync(target, { recursive: true }).filter(entry => statSync(join(target, entry.toString())).isFile()))
    .toEqual([join(location, 'artium-axi/SKILL.md')])
  const modified = statSync(path).mtimeMs
  expect(await cli(target, args)).toMatchObject({ code: 0 })
  expect(statSync(path).mtimeMs).toBe(modified)
  expect(read(path)).toBe(content)
})

test.each([
  ['claude', '.claude/skills'], ['codex', '.agents/skills'], ['opencode', '.config/opencode/skills'],
  ['pi', '.pi/agent/skills'],
].map(([host, location]) => ({ host, location })))
('installed $host invocations execute from a replacement-sensitive bundle path', async ({ host, location }) => {
  const target = home()
  granted = [...toolSchema.options]
  expect(await cli(target, ['setup', '--host', host])).toMatchObject({ code: 0 })
  for (const tool of ['artium-axi', ...toolSchema.options]) {
    const content = read(join(target, location, tool, 'SKILL.md'))
    expect(content).toContain('in place of `artium-axi` in every example')
    const invocation = content.match(process.platform === 'win32' ? /```powershell\n([^\n]+)\n```/ : /```sh\n([^\n]+)\n```/)![1]
    const result = await execute(process.platform === 'win32' ? 'powershell.exe' : 'sh',
      process.platform === 'win32' ? ['-NoProfile', '-Command', `${invocation} --help`] : ['-c', `${invocation} --help`],
      { cwd: directory, timeout: 10_000, env: { PATH: process.env.PATH, HOME: target, USERPROFILE: target } })
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('usage: artium-axi')
  }
})

test.each([false, true])('Claude setup uses the active configuration directory with hook=%s', async hook => {
  const target = home()
  const config = home()
  const path = join(config, 'settings.json')
  write(path, JSON.stringify({ custom: { keep: true } }))
  const args = hook ? ['setup', '--host', 'claude', '--hook'] : ['setup', '--host', 'claude']
  expect(await cli(target, args, bundle, config)).toMatchObject({ code: 0 })
  const skillPath = join(config, 'skills/artium-axi/SKILL.md')
  expect(read(skillPath)).toContain(bundle.replaceAll("'", "'\\''"))
  expect(readdirSync(target)).toEqual([])
  const settings = JSON.parse(read(path))
  expect(settings.custom).toEqual({ keep: true })
  expect(settings.hooks).toEqual(hook ? { SessionStart: [{ hooks: [{ type: 'command',
    command: `${shellQuote(process.execPath)} ${shellQuote(bundle)} session-context`, statusMessage: 'artium-axi managed tools' }] }] } : undefined)
  const modified = [statSync(skillPath).mtimeMs, statSync(path).mtimeMs]
  expect(await cli(target, args, bundle, config)).toMatchObject({ code: 0 })
  expect([statSync(skillPath).mtimeMs, statSync(path).mtimeMs]).toEqual(modified)
})

test('invalid relocated Claude settings identify the active file without installing a skill', async () => {
  const target = home()
  const config = home()
  const path = join(config, 'settings.json')
  write(path, 'invalid json')
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'], bundle, config)).toMatchObject({ code: 2,
    stdout: expect.stringContaining(`Repair ${path}, then rerun setup.`) })
  expect(read(path)).toBe('invalid json')
  expect(readdirSync(config)).toEqual(['settings.json'])
  expect(readdirSync(target)).toEqual([])
})

test('setup refuses an edited skill unless replacement is explicit', async () => {
  const target = home()
  const path = join(target, '.claude/skills/artium-axi/SKILL.md')
  await cli(target, ['setup', '--host', 'claude'])
  const edited = read(path).replace('## Investigation quick guide', 'Local customization')
  write(path, edited)
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'])).toMatchObject({ code: 2,
    stdout: expect.stringContaining('--force') })
  expect(read(path)).toBe(edited)
  expect(readdirSync(join(target, '.claude'))).toEqual(['skills'])
  expect(await cli(target, ['setup', '--host', 'claude', '--force'])).toMatchObject({ code: 0 })
  expect(read(path)).toContain('## Investigation quick guide')
})

test('setup refuses an unmanaged skill without explicit replacement', async () => {
  const target = home()
  const path = join(target, '.agents/skills/artium-axi/SKILL.md')
  write(path, 'local skill\n')
  expect(await cli(target, ['setup', '--host', 'codex'])).toMatchObject({ code: 2 })
  expect(read(path)).toBe('local skill\n')
  expect(await cli(target, ['setup', '--host', 'codex', '--force'])).toMatchObject({ code: 0 })
})

test('Claude hook installation preserves unrelated settings and hooks and is idempotent', async () => {
  const target = home()
  const path = join(target, '.claude/settings.json')
  const existing = { permissions: { allow: ['Bash(synthetic *)'] }, custom: { keep: true },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'synthetic-stop' }] }],
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'synthetic-start' }] }] } }
  write(path, JSON.stringify(existing))
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'])).toMatchObject({ code: 0 })
  const installed = JSON.parse(read(path))
  expect(installed.permissions).toEqual(existing.permissions)
  expect(installed.custom).toEqual(existing.custom)
  expect(installed.hooks.Stop).toEqual(existing.hooks.Stop)
  expect(installed.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0])
  expect(installed.hooks.SessionStart).toHaveLength(2)
  expect(installed.hooks.SessionStart[1]).toEqual({ hooks: [{ type: 'command',
    command: `${shellQuote(process.execPath)} ${shellQuote(bundle)} session-context`, statusMessage: 'artium-axi managed tools' }] })
  const modified = statSync(path).mtimeMs
  const content = read(path)
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'])).toMatchObject({ code: 0 })
  expect(read(path)).toBe(content)
  expect(statSync(path).mtimeMs).toBe(modified)
})

test('setup repairs managed skill and hook paths after the bundle moves', async () => {
  const target = home()
  granted = ['az-axi']
  await cli(target, ['setup', '--host', 'claude', '--hook'])
  const relocated = join(directory, 'relocated.mjs')
  copyFileSync(bundle, relocated)
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'], relocated)).toMatchObject({ code: 0 })
  const settings = JSON.parse(read(join(target, '.claude/settings.json')))
  expect(settings.hooks.SessionStart).toHaveLength(1)
  expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(`${shellQuote(process.execPath)} ${shellQuote(relocated)} session-context`)
  expect(read(join(target, '.claude/skills/artium-axi/SKILL.md'))).toContain(relocated.replaceAll("'", "'\\''"))
  expect(read(join(target, '.claude/skills/az-axi/SKILL.md'))).toContain(relocated.replaceAll("'", "'\\''"))
})

test.each(['invalid json', '[]', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":null}}', '{"hooks":{"SessionStart":[{"hooks":"invalid"}]}}'])
('invalid Claude settings refuse installation without changing files: %s', async content => {
  const target = home()
  const path = join(target, '.claude/settings.json')
  write(path, content)
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'])).toMatchObject({ code: 2 })
  expect(read(path)).toBe(content)
  expect(readdirSync(join(target, '.claude'))).toEqual(['settings.json'])
})

test.each(['pi'])('unsupported %s hook explains the limit without writing a universal format', async host => {
  const target = home()
  expect(await cli(target, ['setup', '--host', host, '--hook'])).toMatchObject({ code: 2, stderr: '',
    stdout: expect.stringContaining(`no verified ${host} hook implementation`) })
  expect(readdirSync(target)).toEqual([])
})

test.each([[], ['--host', 'unknown'], ['--host', 'claude', '--unknown'], ['--host', 'claude', '--force', '--force']].map(args => ({ args })))
('setup rejects invalid arguments before writing: $args', async ({ args }) => {
  const target = home()
  expect(await cli(target, ['setup', ...args])).toMatchObject({ code: 2 })
  expect(readdirSync(target)).toEqual([])
})

test('setup help is available without server configuration or writes', async () => {
  const target = home()
  expect(await cli(target, ['setup', '--help'])).toMatchObject({ code: 0,
    stdout: expect.stringContaining('usage: artium-axi setup --host') })
  expect(readdirSync(target)).toEqual([])
})

test.each(['absolute', 'relative', 'tilde'])('Pi setup honors a %s PI_CODING_AGENT_DIR', async kind => {
  const target = home()
  const config = kind === 'absolute' ? home() : kind === 'relative' ? 'pi-config' : '~/pi-config'
  const resolved = kind === 'absolute' ? config : kind === 'relative' ? join(directory, config) : join(target, 'pi-config')
  try {
    expect(await cli(target, ['setup', '--host', 'pi'], bundle, undefined, config)).toMatchObject({ code: 0 })
    const path = join(resolved, 'skills/artium-axi/SKILL.md')
    expect(read(path)).toContain('## Investigation quick guide')
    const modified = statSync(path).mtimeMs
    expect(await cli(target, ['setup', '--host', 'pi'], bundle, undefined, config)).toMatchObject({ code: 0 })
    expect(statSync(path).mtimeMs).toBe(modified)
    expect(readdirSync(target)).toEqual(kind === 'tilde' ? ['pi-config'] : [])
  } finally { rmSync(resolved, { recursive: true, force: true }) }
})

test.each(['edited', 'unmanaged'])('Pi setup refuses an %s skill until --force is explicit', async kind => {
  const target = home()
  const path = join(target, '.pi/agent/skills/artium-axi/SKILL.md')
  expect(await cli(target, ['setup', '--host', 'pi'])).toMatchObject({ code: 0 })
  const content = kind === 'edited' ? read(path).replace('## Investigation quick guide', 'Local customization') : 'local skill\n'
  write(path, content)
  expect(await cli(target, ['setup', '--host', 'pi'])).toMatchObject({ code: 2,
    stdout: expect.stringContaining('The installed skill was edited or is unmanaged; no installation was written.') })
  expect(read(path)).toBe(content)
  expect(await cli(target, ['setup', '--host', 'pi', '--force'])).toMatchObject({ code: 0 })
  expect(read(path)).toContain('## Investigation quick guide')
})

test('Pi setup help identifies Pi without installing', async () => {
  const target = home()
  expect(await cli(target, ['setup', '--host', 'pi', '--help'])).toMatchObject({ code: 0,
    stdout: expect.stringContaining('<claude|codex|opencode|pi>') })
  expect(readdirSync(target)).toEqual([])
})

test.each([
  ['claude', '.claude/skills'], ['codex', '.agents/skills'], ['opencode', '.config/opencode/skills'], ['pi', '.pi/agent/skills'],
])('setup installs grants and adds newly granted skills on re-run for %s', async (host, location) => {
  const target = home()
  const args = ['setup', '--host', host]
  granted = ['az-axi']
  expect(await cli(target, args)).toMatchObject({ code: 0, stdout: expect.stringContaining('az-axi,installed') })
  const path = join(target, location, 'az-axi/SKILL.md')
  const previous = read(path)
  const modified = statSync(path).mtimeMs
  expect(previous).toContain('artium-axi az-axi rg query --file query.kql')
  granted = ['az-axi', 'ldap-axi']
  const result = await cli(target, args)
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('az-axi,unchanged')
  expect(result.stdout).toContain('ldap-axi,installed')
  expect(statSync(path).mtimeMs).toBe(modified)
  expect(readdirSync(join(target, location)).sort()).toEqual(['artium-axi', 'az-axi', 'ldap-axi'])
  granted = ['ldap-axi']
  expect(await cli(target, args)).toMatchObject({ code: 0, stdout: expect.stringContaining('az-axi,retained (no longer granted)') })
  expect(read(path)).toBe(previous)
  const edited = previous + 'Local edit\n'
  write(path, edited)
  expect(await cli(target, args)).toMatchObject({ code: 0, stdout: expect.stringContaining('az-axi,retained (no longer granted)') })
  expect(read(path)).toBe(edited)
})

test.each([
  ['claude', '.claude/skills'], ['codex', '.agents/skills'], ['opencode', '.config/opencode/skills'], ['pi', '.pi/agent/skills'],
])('setup leaves unmanaged standalone skills untouched and unreported for %s', async (host, location) => {
  const target = home()
  const path = join(target, location, 'az-axi/SKILL.md')
  const standalone = read('tools/node_modules/@knowttl/az-axi/skills/az-axi/SKILL.md')
  write(path, standalone)
  const modified = statSync(path).mtimeMs
  expect(await cli(target, ['setup', '--host', host])).toMatchObject({ code: 0, stderr: '',
    stdout: 'skills[1]{name,status}:\n  artium-axi,installed\n' })
  expect(read(path)).toBe(standalone)
  expect(statSync(path).mtimeMs).toBe(modified)
})

test.each(['edited', 'unmanaged'])('a later %s tool skill refuses the entire installation until --force', async kind => {
  const target = home()
  const path = join(target, '.claude/skills/ldap-axi/SKILL.md')
  granted = ['ldap-axi']
  await cli(target, ['setup', '--host', 'claude'])
  const content = kind === 'edited' ? read(path) + 'Local edit\n' : 'Local skill\n'
  write(path, content)
  const base = join(target, '.claude/skills/artium-axi/SKILL.md')
  const modified = statSync(base).mtimeMs
  granted = ['az-axi', 'ldap-axi']
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'])).toMatchObject({ code: 2,
    stdout: expect.stringContaining('--force') })
  expect(read(path)).toBe(content)
  expect(statSync(base).mtimeMs).toBe(modified)
  expect(readdirSync(join(target, '.claude'))).toEqual(['skills'])
  expect(readdirSync(join(target, '.claude/skills')).sort()).toEqual(['artium-axi', 'ldap-axi'])
  expect(await cli(target, ['setup', '--host', 'claude', '--hook', '--force'])).toMatchObject({ code: 0 })
  expect(read(path)).toContain('artium-axi ldap-axi user list')
})

test('setup without a signed-in session writes no host files', async () => {
  const target = home()
  await expect(execute(process.execPath, [bundle, 'setup', '--host', 'codex'], {
    env: { PATH: process.env.PATH, HOME: target, USERPROFILE: target, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' }, timeout: 10_000,
  })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('TOKEN_INVALID') })
  expect(readdirSync(target)).toEqual([])
})

test('invalid skill snapshots refuse installation before writing the base skill', async () => {
  const target = home()
  skillResponse = { skills: [{ name: 'unknown-tool', content: 'unreviewed' }] }
  expect(await cli(target, ['setup', '--host', 'codex'])).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE') })
  expect(readdirSync(target)).toEqual([])
})

test('setup installs every granted tool with one compact output row per skill', async () => {
  const target = home()
  granted = ['falcon-axi', 'vectra-axi', 'az-axi', 'mg-axi', 'ldap-axi']
  const result = await cli(target, ['setup', '--host', 'codex'])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout.trim().split('\n')).toEqual(['skills[6]{name,status}:',
    '  artium-axi,installed', '  falcon-axi,installed', '  vectra-axi,installed', '  az-axi,installed', '  mg-axi,installed', '  ldap-axi,installed'])
  expect(readdirSync(join(target, '.agents/skills')).sort()).toEqual(['artium-axi', ...granted].sort())
})
