import { fstatSync, writeSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { encode } from '@toon-format/toon'
import { z } from 'zod'
import { createdDelegationSchema, deviceStartResponseSchema, reauthResponseSchema, ssoReauthResponseSchema, toolSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { Client } from './http.js'
import { readPassword } from './password.js'
import type { ManagedSession } from './managed-session.js'

export async function tokenCommand(args: string[], output: (text: string) => void, managed?: ManagedSession) {
  const action = args[0]
  if (args.includes('--help')) {
    output('usage: artium-axi token create --label <label> --tool <tool> --expires <ISO-date> [--write] [--reusable] [--command <tool:command>] [--exact <tool:command>] [--instance <tool:name>] [--token-fd <fd>] [--password-stdin|--sso]\n       artium-axi token list\n       artium-axi token revoke <id>\nCommand picks are exact. Wildcards are not supported yet.\n--instance limits every selection for a tool to the named instances; without it a tool selection covers every instance you can use. API and native selections are broad and require an exact pick.\nRead-only blocks writes, but some reads send data externally or incur costs.\nSSH write access reaches every host and sudo grant available to the creator.\n')
    return
  }
  if (managed) throw new ArtiumError('INVALID_INPUT', 'Token management is unavailable in managed mode.')
  if (action === 'list' && args.length === 1) {
    output(encode(await new Client().authenticated('/v1/account/tokens', 'GET')) + '\n')
    return
  }
  if (action === 'revoke' && args.length === 2 && z.uuid().safeParse(args[1]).success) {
    await new Client().authenticated(`/v1/account/tokens/${args[1]}/revoke`, 'POST')
    output('status: revoked\n')
    return
  }
  if (action === 'list' || action === 'revoke') throw new ArtiumError('INVALID_INPUT', 'Invalid token command arguments.',
    action === 'list' ? 'Use artium-axi token list; valid flags: --help.' : 'Use artium-axi token revoke <id>; valid flags: --help.')
  if (action !== 'create') throw new ArtiumError('INVALID_INPUT', 'Invalid token command.', 'Use artium-axi token --help.')
  const createFlags = ['--label', '--tool', '--expires', '--write', '--reusable', '--command', '--exact', '--instance', '--token-fd', '--password-stdin', '--sso']
  const flags = new Map<string, string[]>()
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]
    if (!createFlags.includes(flag)) throw new ArtiumError('INVALID_INPUT',
      flag.startsWith('-') && !/artd_[A-Za-z0-9_-]{43}/.test(flag) ? `Unknown flag ${flag.split('=')[0]} for token create.` : 'Unexpected argument for token create.',
      `Valid flags: --help, ${createFlags.join(', ')}.`)
    const values = flags.get(flag) ?? []
    if (values.length && !['--tool', '--command', '--exact', '--instance'].includes(flag)) throw new ArtiumError('INVALID_INPUT')
    const value = ['--write', '--reusable', '--password-stdin', '--sso'].includes(flag) ? 'true' : args[++index]
    if (!value || value.startsWith('--')) throw new ArtiumError('INVALID_INPUT')
    if (['--exact', '--command'].includes(flag) && value.includes('*')) throw new ArtiumError('INVALID_INPUT',
      'Wildcards are not supported yet.', 'Select exact commands or use --tool for tool-wide access.')
    values.push(value)
    flags.set(flag, values)
  }
  if (flags.has('--sso') && flags.has('--password-stdin')) throw new ArtiumError('INVALID_INPUT')
  const label = flags.get('--label')?.[0]
  const expiresAt = Date.parse(flags.get('--expires')?.[0] ?? '')
  const readTool = (value: string) => {
    const tool = toolSchema.safeParse(value)
    if (!tool.success) throw new ArtiumError('INVALID_INPUT', 'Unknown tool.', 'Use artium-axi tools to list available tools.')
    return tool.data
  }
  const tools = (flags.get('--tool') ?? []).map(tool => ({ tool: readTool(tool) }))
  const picks = [...flags.get('--exact') ?? [], ...flags.get('--command') ?? []].map(value => {
    const separator = value.indexOf(':')
    if (separator < 0) throw new ArtiumError('INVALID_INPUT')
    return { tool: readTool(value.slice(0, separator)), commands: [value.slice(separator + 1)] }
  })
  const instances = new Map<string, string[]>()
  for (const value of flags.get('--instance') ?? []) {
    const separator = value.indexOf(':')
    if (separator < 0) throw new ArtiumError('INVALID_INPUT', 'Invalid --instance value.', 'Use --instance <tool>:<name>.')
    const tool = readTool(value.slice(0, separator))
    instances.set(tool, [...instances.get(tool) ?? [], value.slice(separator + 1)])
  }
  const selections = [...tools, ...picks].map(item => ({ ...item, ...(instances.has(item.tool) ? { instances: instances.get(item.tool) } : {}) }))
  if (!label || !Number.isFinite(expiresAt) || !selections.length || [...instances.keys()].some(tool => !selections.some(item => item.tool === tool))) {
    throw new ArtiumError('INVALID_INPUT')
  }
  const fdText = flags.get('--token-fd')?.[0]
  if (!fdText && !process.stdout.isTTY) throw new ArtiumError('INVALID_INPUT', 'A private token destination is required.', 'Use --token-fd with an inherited pipe or socket.')
  const fd = fdText === undefined ? 1 : Number(fdText)
  if (fdText !== undefined) {
    if (!/^\d+$/.test(fdText) || fd < 3) throw new ArtiumError('INVALID_INPUT')
    try { const stat = fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) throw new Error(); writeSync(fd, Buffer.alloc(0)) }
    catch { throw new ArtiumError('INVALID_INPUT', 'The token descriptor must be a writable pipe or socket.') }
  }
  if (picks.length) output('warning: Exact selections may be broad or issue credentials that outlive this token. Revoke issued credentials separately.\n')
  if (flags.has('--write') && [...tools, ...picks].some(item => item.tool === 'ssh-axi')) {
    output('warning: SSH write access reaches every host and sudo grant available to the creator.\n')
  }
  const client = new Client()
  const { accessToken } = await client.freshSession()
  let proof: unknown
  if (flags.has('--sso')) {
    const start = deviceStartResponseSchema.parse(await client.request('/v1/auth/reauth', 'POST', {}, accessToken))
    if (start.verificationUri !== client.serverUrl + '/device') throw new ArtiumError('INVALID_RESPONSE')
    output(`status: approval-required\nopen: ${JSON.stringify(start.verificationUri)}\ncode: ${start.userCode}\n`)
    while (Date.now() < start.expiresAt) {
      try {
        proof = ssoReauthResponseSchema.parse(await client.request('/v1/auth/reauth', 'POST', { deviceCode: start.deviceCode }, accessToken))
        if (reauthResponseSchema.safeParse(proof).success) break
      } catch (error) { if (!(error instanceof ArtiumError) || error.code !== 'DEVICE_POLL_LIMITED') throw error }
      await delay(Math.min(start.intervalMs, Math.max(0, start.expiresAt - Date.now())))
    }
  } else {
    const password = await readPassword(flags.has('--password-stdin'))
    proof = await client.request('/v1/auth/reauth', 'POST', { password }, accessToken)
  }
  const { ticket } = reauthResponseSchema.parse(proof)
  const response = createdDelegationSchema.parse(await client.request('/v1/account/tokens', 'POST', { label, scope: { tools: selections },
      readOnly: !flags.has('--write'), reusable: flags.has('--reusable'), expiresAt }, accessToken, false, { 'x-artium-reauth-ticket': ticket }))
  writeSync(fd, `${response.token}\n`)
  output(`status: created\nid: ${response.id}\nexpiresAt: ${new Date(response.expiresAt).toISOString()}\n`)
}
