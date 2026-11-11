import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { encode } from '@toon-format/toon'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import { shodanBulkWriteCommands, shodanBulkWriteDeadlineMs, shodanNotifierBody, shodanWriteBodyLimit, shodanWriteCommands, type ShodanWriteCommand } from '../shared/shodan-write.js'
import { shodanWriteInput } from '../shared/shodan-stream.js'
import type { Client } from './http.js'

const prefix = '/v1/tools/shodan-axi/writes'
const notifierBodyLimit = 65536
const valueFlags = ['--allow-operation', '--query-credit-budget', '--max-requests', '--confirm', '--expires', '--vulns', '--triggers', '--body-file']
const switchFlags = ['--json', '--accept-unknown-cost', '--execute', '--silent']
const common = ['--allow-operation', '--query-credit-budget', '--max-requests', '--confirm', '--json', '--accept-unknown-cost', '--execute']

export const shodanWriteHelp = `usage: artium-axi shodan-axi <alert|notifier|org> <write command> [options]
Commands: alert create <name> <networks> [--expires <seconds>], alert update <id> <networks>, alert remove <id>, alert enable|disable <id> <trigger>,
alert ignore [--vulns <CVE,...>]|unignore <id> <trigger> <ip:port>, alert notifier add|remove <id> <notifier>,
notifier create --body-file <path>, notifier update <id> --body-file <path>, notifier remove <id>, org add <email> [--silent], org remove <email>,
alert clear, alert domain <domain> [--triggers <names>], alert import <path>.
Every command needs the exact --allow-operation grants, --query-credit-budget, --max-requests and --accept-unknown-cost.
Run without --execute to preview. Apply with the same arguments plus --execute --confirm <token>; the token expires after 15 minutes and works once.
Notifier and import files are read locally, must be private (mode 0600) and are sent in the request. The server never reads a path.
Add --json for JSON output. A result with status OUTCOME_UNKNOWN or READBACK_UNVERIFIED exits 1; inspect before retrying.
`

async function readPrivateFile(path: string, limit: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ArtiumError('INVALID_INPUT', 'The input file cannot be opened.', 'Pass a readable regular file that is not a symbolic link.')
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new ArtiumError('INVALID_INPUT', 'The input file must be a private regular file within the size limit.', `Use a non-empty file of at most ${limit} bytes and run chmod 600 on it.`)
    }
    return await handle.readFile()
  } finally { await handle.close() }
}

export async function shodanWrite(args: string[], createClient: () => Client, output: (stream: 'stdout' | 'stderr', text: string) => void, instance?: string) {
  const command = [args.slice(0, 3).join(' '), args.slice(0, 2).join(' ')].find((name): name is ShodanWriteCommand => Object.hasOwn(shodanWriteCommands, name))
  if (!command) return false
  if (args.includes('--help') || args.includes('-h')) { output('stdout', shodanWriteHelp); return true }
  const spec: { positional: number, grants: readonly string[], flags: readonly string[] } = shodanWriteCommands[command]
  const values = new Map<string, string>(), switches = new Set<string>(), positional: string[] = []
  for (let index = command.split(' ').length; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positional.push(token); continue }
    if (!common.includes(token) && !spec.flags.includes(token)) throw new ArtiumError('INVALID_INPUT')
    if (switchFlags.includes(token)) {
      if (switches.has(token)) throw new ArtiumError('INVALID_INPUT')
      switches.add(token)
    } else if (valueFlags.includes(token) && !values.has(token) && args[index + 1] && !args[index + 1].startsWith('--')) values.set(token, args[++index])
    else throw new ArtiumError('INVALID_INPUT')
  }
  const execute = switches.has('--execute')
  const confirm = values.get('--confirm')
  const grants = values.get('--allow-operation')?.split(',') ?? []
  const required = command === 'alert ignore' && values.has('--vulns') ? ['OP-070'] : spec.grants
  const exactGrants = command === 'alert import' ? grants.every(grant => required.includes(grant)) && grants.includes('OP-013')
    : grants.length === required.length && required.every(grant => grants.includes(grant))
  const integer = (name: string) => {
    const value = values.get(name)
    if (value === undefined) return undefined
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ArtiumError('INVALID_INPUT')
    return Number(value)
  }
  if (positional.length !== spec.positional || execute !== (confirm !== undefined) || confirm !== undefined && !z.uuid().safeParse(confirm).success
    || !exactGrants || new Set(grants).size !== grants.length || !switches.has('--accept-unknown-cost')
    || spec.flags.includes('--body-file') !== values.has('--body-file')) throw new ArtiumError('INVALID_INPUT')
  const importFile = command === 'alert import'
  const bodyPath = importFile ? positional.pop() : values.get('--body-file')
  const body = bodyPath === undefined ? undefined : await readPrivateFile(bodyPath, importFile ? shodanWriteBodyLimit : notifierBodyLimit)
  let secrets: string[] = []
  let notifierBody: z.infer<typeof shodanNotifierBody> | undefined
  if (body !== undefined && !importFile) {
    let parsed: z.ZodSafeParseResult<z.infer<typeof shodanNotifierBody>>
    try { parsed = shodanNotifierBody.safeParse(JSON.parse(body.toString('utf8'))) } catch { throw new ArtiumError('INVALID_INPUT', 'The notifier file is not valid JSON.') }
    if (!parsed.success || command === 'notifier create' && !parsed.data.provider) throw new ArtiumError('INVALID_INPUT', 'The notifier file needs an args object, and a provider for create.')
    notifierBody = parsed.data
    secrets = Object.values(parsed.data.args).map(String).filter(Boolean)
  }
  const parsed = shodanWriteInput.safeParse({ command, arguments: positional, queryCreditBudget: integer('--query-credit-budget'), maxRequests: integer('--max-requests'),
    expires: integer('--expires'), vulns: values.get('--vulns'), silent: switches.has('--silent') || undefined, triggers: values.get('--triggers'), body: notifierBody,
    ...(importFile ? { importBody: body?.toString('base64'), allowOperations: grants } : {}) })
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  const client = createClient()
  await client.authenticated('/v1/me', 'GET')
  const request = { ...parsed.data, ...(execute ? { confirm } : {}), ...(instance === undefined ? {} : { instance }) }
  const bulk = (shodanBulkWriteCommands as readonly string[]).includes(command)
  const response = await client.transferSession(token => client.request(`${prefix}/${execute ? 'execute' : 'preview'}`, 'POST', request, token,
    false, undefined, bulk ? shodanBulkWriteDeadlineMs + 90_000 : undefined)).catch(error => {
    if (bulk && execute && error instanceof ArtiumError && (error.code === 'SERVER_UNAVAILABLE' || error.code === 'INVALID_RESPONSE'))
      throw new ArtiumError(error.code, undefined, 'The write may have changed state. Inspect affected objects before retrying.')
    if (secrets.length) throw new ArtiumError(error instanceof ArtiumError ? error.code : 'SERVER_UNAVAILABLE', undefined,
      execute ? 'The write may have changed state. Inspect the notifier before retrying.' : undefined)
    throw error
  })
  const result = z.record(z.string(), z.unknown()).safeParse(response)
  if (!result.success) throw new ArtiumError('INVALID_RESPONSE')
  const redact = (value: unknown, key = ''): unknown => {
    if (['confirm', 'status', 'error', 'command', 'operation', 'method', 'target', 'id', 'completed', 'uncertain', 'unsent', 'steps', 'instance', 'expires', 'expiresAt', 'expiresIn', 'expiry', 'recovery'].includes(key)) return value
    if (typeof value === 'string') return secrets.includes(value) ? '[REDACTED]' : value
    if (Array.isArray(value)) return value.map(item => redact(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]))
    return value
  }
  const safe = redact(result.data)
  const rendered = switches.has('--json') ? JSON.stringify(safe) : encode(safe)
  output('stdout', rendered + '\n')
  if (result.data.status === 'OUTCOME_UNKNOWN' || result.data.status === 'READBACK_UNVERIFIED') process.exitCode = 1
  return true
}
