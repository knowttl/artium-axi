import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const execute = promisify(execFile)
const directory = mkdtempSync(join(tmpdir(), "artium-setup-$&-$`-$'-$$-"))
const bundle = join(directory, 'standalone.mjs')
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'])
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function home() { return mkdtempSync(join(directory, 'home-')) }
function read(path: string) { return readFileSync(path, 'utf8') }
function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
async function cli(home: string, args: string[], executable = bundle, claudeConfigDir?: string) {
  try {
    return { ...await execute(process.execPath, [executable, ...args], { cwd: directory, timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeConfigDir } }), code: 0 }
  } catch (error) { return error as { stdout: string, stderr: string, code: number } }
}

test.each([
  ['claude', '.claude/skills'], ['codex', '.agents/skills'], ['opencode', '.config/opencode/skills'],
])('standalone setup installs only the embedded skill for %s and repeats without writes', async (host, location) => {
  const target = home()
  const args = ['setup', '--host', host]
  expect(await cli(target, args)).toMatchObject({ code: 0, stderr: '', stdout: expect.stringContaining('hook: not requested') })
  const path = join(target, location, 'artium-axi/SKILL.md')
  const content = read(path)
  expect(content).toContain('Use artium-axi tools first')
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
])('installed %s invocation executes from a replacement-sensitive bundle path', async (host, location) => {
  const target = home()
  expect(await cli(target, ['setup', '--host', host])).toMatchObject({ code: 0 })
  const content = read(join(target, location, 'artium-axi/SKILL.md'))
  const invocation = content.match(/```sh\n([^\n]+)\n```/)![1]
  const result = await execute(process.platform === 'win32' ? 'powershell.exe' : 'sh',
    process.platform === 'win32' ? ['-NoProfile', '-Command', `${invocation} --help`] : ['-c', `${invocation} --help`],
    { cwd: directory, timeout: 10_000, env: { PATH: process.env.PATH, HOME: target, USERPROFILE: target } })
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('usage: artium-axi')
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
  expect(settings.hooks).toEqual(hook ? { SessionStart: [{ hooks: [{ type: 'command', command: process.execPath,
    args: [bundle, 'tools'], statusMessage: 'artium-axi managed tools' }] }] } : undefined)
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
  const edited = read(path).replace('Use artium-axi tools first', 'Local customization')
  write(path, edited)
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'])).toMatchObject({ code: 2,
    stdout: expect.stringContaining('--force') })
  expect(read(path)).toBe(edited)
  expect(readdirSync(join(target, '.claude'))).toEqual(['skills'])
  expect(await cli(target, ['setup', '--host', 'claude', '--force'])).toMatchObject({ code: 0 })
  expect(read(path)).toContain('Use artium-axi tools first')
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
  expect(installed.hooks.SessionStart[1]).toEqual({ hooks: [{ type: 'command', command: process.execPath,
    args: [bundle, 'tools'], statusMessage: 'artium-axi managed tools' }] })
  const modified = statSync(path).mtimeMs
  const content = read(path)
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'])).toMatchObject({ code: 0 })
  expect(read(path)).toBe(content)
  expect(statSync(path).mtimeMs).toBe(modified)
})

test('setup repairs managed skill and hook paths after the bundle moves', async () => {
  const target = home()
  await cli(target, ['setup', '--host', 'claude', '--hook'])
  const relocated = join(directory, 'relocated.mjs')
  copyFileSync(bundle, relocated)
  expect(await cli(target, ['setup', '--host', 'claude', '--hook'], relocated)).toMatchObject({ code: 0 })
  const settings = JSON.parse(read(join(target, '.claude/settings.json')))
  expect(settings.hooks.SessionStart).toHaveLength(1)
  expect(settings.hooks.SessionStart[0].hooks[0].args).toEqual([relocated, 'tools'])
  expect(read(join(target, '.claude/skills/artium-axi/SKILL.md'))).toContain(relocated.replaceAll("'", "'\\''"))
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

test.each(['codex', 'opencode'])('unsupported %s hook explains the limit without writing a universal format', async host => {
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
