import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import skill from '../../skill/artium-axi/SKILL.md'
import { ArtiumError } from '../shared/errors.js'
import { skillsResponseSchema, toolSchema } from '../shared/api.js'
import { Client } from './http.js'
import { encode } from '@toon-format/toon'

const hosts = {
  claude: ['.claude'],
  codex: ['.agents'],
  opencode: ['.config', 'opencode'],
  pi: ['.pi', 'agent'],
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

function replaceAtomically(changes: { path: string, content: string }[]) {
  const staged: { path: string, temporary: string, backup: string, previous: string | undefined, committed: boolean }[] = []
  try {
    for (const { path, content } of changes) {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      const backup = `${temporary}.backup`
      const previous = readOptional(path)
      staged.push({ path, temporary, backup, previous, committed: false })
      const mode = existsSync(path) ? statSync(path).mode : 0o600
      writeFileSync(temporary, content, { flag: 'wx', mode })
      if (previous !== undefined) writeFileSync(backup, previous, { flag: 'wx', mode })
    }
    for (const entry of staged) {
      renameSync(entry.temporary, entry.path)
      entry.committed = true
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) if (entry.committed) {
      if (entry.previous === undefined) rmSync(entry.path)
      else renameSync(entry.backup, entry.path)
    }
    throw error
  } finally {
    for (const { temporary, backup } of staged) {
      rmSync(temporary, { force: true })
      rmSync(backup, { force: true })
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function claudeSettings(path: string, executable: string): string {
  const previous = readOptional(path)
  let settings: unknown
  try { settings = previous === undefined ? {} : JSON.parse(previous) }
  catch { throw new ArtiumError('INVALID_INPUT', 'Claude settings are invalid JSON; no installation was written.', `Repair ${path}, then rerun setup.`) }
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

export async function setup(args: string[]): Promise<string> {
  let host: keyof typeof hosts | undefined
  let hook = false
  let force = false
  for (let index = 0; index < args.length; index++) {
    const option = args[index]
    if (option === '--host' && host === undefined && Object.hasOwn(hosts, args[index + 1] ?? '')) host = args[++index] as keyof typeof hosts
    else if (option === '--hook' && !hook) hook = true
    else if (option === '--force' && !force) force = true
    else throw new ArtiumError('INVALID_INPUT', 'Unknown setup host, argument or flag.', 'Use artium-axi setup --host <claude|codex|opencode|pi> [--hook] [--force].')
  }
  if (!host) throw new ArtiumError('INVALID_INPUT', 'Setup requires --host.', 'Use artium-axi setup --host <claude|codex|opencode|pi> [--hook] [--force].')
  if (hook && host !== 'claude') {
    throw new ArtiumError('INVALID_INPUT', `Hook installation is unsupported for ${host}: this installer has no verified ${host} hook implementation. No files were written.`, `Install the skill with artium-axi setup --host ${host} without --hook; Claude Code supports --hook.`)
  }
  const executable = resolve(process.argv[1])
  const invocation = process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' '${executable.replaceAll("'", "''")}'`
    : `${quote(process.execPath)} ${quote(executable)}`
  const content = skill.replace(/<!-- artium-axi executable -->[\s\S]*?<!-- \/artium-axi executable -->/, () => `<!-- artium-axi executable -->\n\n\`\`\`sh\n${invocation}\n\`\`\`\n\n<!-- /artium-axi executable -->`)
  const hostDirectory = host === 'claude' && process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : host === 'pi' && process.env.PI_CODING_AGENT_DIR
      ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, () => homedir()))
      : join(homedir(), ...hosts[host])
  const client = new Client()
  const response = skillsResponseSchema.safeParse(await client.authenticated('/v1/skills', 'GET'))
  if (!response.success) throw new ArtiumError('INVALID_RESPONSE')
  const skills = [{ name: 'artium-axi', content }, ...response.data.skills].map(({ name, content }) => {
    const path = join(hostDirectory, 'skills', name, 'SKILL.md')
    const installed = `${content}\n<!-- artium-axi sha256:${checksum(content)} -->\n`
    const previous = readOptional(path)
    if (previous !== undefined && previous !== installed && !force) {
      const match = previous.match(/^([\s\S]*)\n<!-- artium-axi sha256:([a-f0-9]{64}) -->\n$/)
      if (!match || checksum(match[1]) !== match[2]) {
        throw new ArtiumError('INVALID_INPUT', 'The installed skill was edited or is unmanaged; no installation was written.', `Use artium-axi setup --host ${host}${hook ? ' --hook' : ''} --force to explicitly replace ${path}.`)
      }
    }
    return { name, path, installed, previous }
  })
  const retained = toolSchema.options.filter(name => !response.data.skills.some(skill => skill.name === name))
    .filter(name => readOptional(join(hostDirectory, 'skills', name, 'SKILL.md')) !== undefined)
  const settingsPath = join(hostDirectory, 'settings.json')
  const settings = hook ? claudeSettings(settingsPath, executable) : undefined
  const changes = skills.filter(skill => skill.previous !== skill.installed).map(skill => ({ path: skill.path, content: skill.installed }))
  if (settings !== undefined && readOptional(settingsPath) !== settings) changes.push({ path: settingsPath, content: settings })
  replaceAtomically(changes)
  return encode({ skills: [...skills.map(skill => ({ name: skill.name, status: skill.previous === skill.installed ? 'unchanged' : 'installed' })),
    ...retained.map(name => ({ name, status: 'retained (no longer granted)' }))], ...(hook ? { hook: 'SessionStart' } : {}) }) + '\n'
}
