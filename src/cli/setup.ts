import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import skill from '../../skill/artium-axi/SKILL.md'
import { ArtiumError } from '../shared/errors.js'

const hosts = {
  claude: ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
  opencode: ['.config', 'opencode', 'skills'],
} as const
const hookName = 'artium-axi managed tools'
const checksum = (content: string) => createHash('sha256').update(content).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function replaceAtomically(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: existsSync(path) ? statSync(path).mode : 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function claudeSettings(path: string, executable: string): string {
  const previous = readOptional(path)
  let settings: unknown
  try { settings = previous === undefined ? {} : JSON.parse(previous) }
  catch { throw new ArtiumError('INVALID_INPUT', 'Claude settings are invalid JSON; no installation was written.', 'Repair ~/.claude/settings.json, then rerun setup.') }
  if (!object(settings) || settings.hooks !== undefined && !object(settings.hooks)) {
    throw new ArtiumError('INVALID_INPUT', 'Claude settings and hooks must be objects; no installation was written.')
  }
  const hooks = settings.hooks ?? {}
  const sessions = hooks.SessionStart === undefined ? [] : hooks.SessionStart
  if (!Array.isArray(sessions) || sessions.some(entry => !object(entry) || !Array.isArray(entry.hooks) || entry.hooks.some(hook => !object(hook)))) {
    throw new ArtiumError('INVALID_INPUT', 'Claude SessionStart hooks have an unsupported shape; no installation was written.')
  }
  const managed = { type: 'command', command: process.execPath, args: [executable, 'tools'], statusMessage: hookName }
  let found = false
  const merged = sessions.map(entry => ({ ...entry, hooks: entry.hooks.flatMap((hook: Record<string, unknown>) => {
    if (hook.statusMessage !== hookName) return [hook]
    if (found) return []
    found = true
    return [managed]
  }) }))
  if (!found) merged.push({ hooks: [managed] })
  settings.hooks = { ...hooks, SessionStart: merged }
  return JSON.stringify(settings, null, 2) + '\n'
}

export function setup(args: string[]): string {
  let host: keyof typeof hosts | undefined
  let hook = false
  let force = false
  for (let index = 0; index < args.length; index++) {
    const option = args[index]
    if (option === '--host' && host === undefined && Object.hasOwn(hosts, args[index + 1] ?? '')) host = args[++index] as keyof typeof hosts
    else if (option === '--hook' && !hook) hook = true
    else if (option === '--force' && !force) force = true
    else throw new ArtiumError('INVALID_INPUT', 'Unknown setup host, argument or flag.', 'Use artium-axi setup --host <claude|codex|opencode> [--hook] [--force].')
  }
  if (!host) throw new ArtiumError('INVALID_INPUT', 'Setup requires --host.', 'Use artium-axi setup --host <claude|codex|opencode> [--hook] [--force].')
  if (hook && host !== 'claude') {
    throw new ArtiumError('INVALID_INPUT', `Hook installation is unsupported for ${host}: this installer has no verified ${host} hook implementation. No files were written.`, `Install the skill with artium-axi setup --host ${host} without --hook; Claude Code supports --hook.`)
  }
  const executable = resolve(process.argv[1])
  const invocation = process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' '${executable.replaceAll("'", "''")}'`
    : `${quote(process.execPath)} ${quote(executable)}`
  const content = skill.replace(/<!-- artium-axi executable -->[\s\S]*?<!-- \/artium-axi executable -->/, `<!-- artium-axi executable -->\n\n\`\`\`sh\n${invocation}\n\`\`\`\n\n<!-- /artium-axi executable -->`)
  const installed = `${content}\n<!-- artium-axi sha256:${checksum(content)} -->\n`
  const skillPath = join(homedir(), ...hosts[host], 'artium-axi', 'SKILL.md')
  const previous = readOptional(skillPath)
  if (previous !== undefined && previous !== installed && !force) {
    const match = previous.match(/^([\s\S]*)\n<!-- artium-axi sha256:([a-f0-9]{64}) -->\n$/)
    if (!match || checksum(match[1]) !== match[2]) {
      throw new ArtiumError('INVALID_INPUT', 'The installed skill was edited or is unmanaged; no installation was written.', `Use artium-axi setup --host ${host}${hook ? ' --hook' : ''} --force to explicitly replace it.`)
    }
  }
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  const settings = hook ? claudeSettings(settingsPath, executable) : undefined
  if (previous !== installed) replaceAtomically(skillPath, installed)
  if (settings !== undefined && readOptional(settingsPath) !== settings) replaceAtomically(settingsPath, settings)
  return `status: installed\nhost: ${host}\nskill: ${JSON.stringify(skillPath)}\nhook: ${hook ? 'SessionStart' : 'not requested'}\n`
}
