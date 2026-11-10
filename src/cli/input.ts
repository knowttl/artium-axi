import { createReadStream } from 'node:fs'
import { parseArgs } from 'node:util'
import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }
import awx from '../../tools/inventories/awx-axi.json' with { type: 'json' }
import gitea from '../../tools/inventories/gitea-axi.json' with { type: 'json' }
import { inputLimits, runRequestSchema } from '../shared/api.js'
import type { RunInput } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { inputFileFlags, normalizeGiteaFileArguments, validateFileInput } from '../shared/file-input.js'
import { technitiumToolInput } from './technitium-input.js'

async function readBounded(stream: Readable, limit: number, stdinAlternative?: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  // Keep the deadline referenced: an idle pipe must fail rather than exit silently.
  const deadline = stdinAlternative === undefined ? undefined : setTimeout(() => {
    stream.destroy(new ArtiumError('INVALID_INPUT', `no stdin EOF after 5 s; close stdin or pass ${stdinAlternative}`))
  }, 5000)
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > limit) throw new ArtiumError('INVALID_INPUT', 'Tool input exceeds the upload limit.')
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    throw new ArtiumError('INVALID_INPUT', 'Tool input could not be read.', 'Check the local input file or stdin.')
  } finally { clearTimeout(deadline) }
  return Buffer.concat(chunks)
}

// Only reviewed file flags upload local contents; other paths remain arguments.
export async function toolInput(tool: string, original: string[]) {
  if (!runRequestSchema.safeParse({ args: original }).success) throw new ArtiumError('INVALID_INPUT')
  if (tool === 'technitium-axi') {
    const prepared = await technitiumToolInput(original)
    if (prepared) return prepared
  }
  const args = tool === 'gitea-axi' ? normalizeGiteaFileArguments(original) : [...original]
  const input: RunInput = {}
  if (tool === 'proxmox-axi' && args.includes('--protected-input') && !args.includes('--help')) {
    if (process.stdin.isTTY) throw new ArtiumError('UNSUPPORTED_INPUT', 'Pipe a private JSON object with api and secrets fields on stdin.')
    input.stdin = (await readBounded(process.stdin, 65536, '--protected-input with closed stdin')).toString('utf8')
  }
  let totalFileBytes = 0
  if (tool === 'gh-axi' && ['gist create', 'gist edit'].includes(args.slice(0, 2).join(' '))
    && args.some(arg => arg === '--filename' || arg.startsWith('--filename='))
    && !args.some(arg => ['--help', '-h'].includes(arg))) {
    if (process.stdin.isTTY) throw new ArtiumError('UNSUPPORTED_INPUT', 'Pipe gist content on stdin.')
    input.stdin = (await readBounded(process.stdin, inputLimits.stdinBytes, '--filename with closed stdin')).toString('utf8')
  }
  const hunting = tool === 'mg-axi' && args.slice(0, 3).join(' ') === 'security hunting query'
  const rule = tool === 'mg-axi' && ['mail rule create', 'mail rule update'].includes(args.slice(0, 3).join(' '))
  const mgUpload = hunting || rule
  const fileFlags = inputFileFlags(tool, original)
  let giteaFiles: Map<number, { name: string, value: string, inline: boolean }> | undefined
  if (tool === 'gitea-axi' && fileFlags.length) {
    const route = gitea.commands.find(route => route.command && route.command.split(' ').every((word, index) => args[index] === word))!
    const length = route.command.split(' ').length
    try {
      const flags: Record<string, string | undefined> = route.flags
      const shorts: Record<string, string | undefined> = route.shortFlags
      const repeatable: readonly string[] = route.repeatableFlags
      const parsed = parseArgs({ args: args.slice(length).map(arg => {
        const match = /^--([^=]+)=(true|false)$/.exec(arg)
        return match && flags[match[1]] === 'boolean' ? '--' + match[1] : arg
      }), allowPositionals: true, strict: true, tokens: true, options: Object.fromEntries(Object.entries(flags).map(([name, type]) => {
        const short = Object.entries(shorts).find(([, target]) => target === name)?.[0]
        return [name, { type: type === 'boolean' ? 'boolean' : 'string', multiple: repeatable.includes(name), ...(short ? { short } : {}) }]
      })) })
      giteaFiles = new Map(parsed.tokens.flatMap(token => token.kind === 'option' && fileFlags.includes(token.name)
        && !(parsed.values.help && !args.includes('--help=false')) ? [[length + token.index, { name: token.name, value: token.value!, inline: token.inlineValue === true }]] : []))
    } catch { throw new ArtiumError('INVALID_INPUT') }
  }
  if ((fileFlags.length || tool === 'az-axi') && !args.some(arg => ['--help', '-h', '--version', '-v', '-V'].includes(arg))) {
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--') break
      const selected = giteaFiles?.get(index)
      if (giteaFiles && !selected) continue
      const flag = selected ? '--' + selected.name : args[index].split('=')[0]
      if (!fileFlags.some(name => flag === `--${name}`)) continue
      const equals = selected ? selected.inline ? 0 : -1 : args[index].indexOf('=')
      let path = selected?.value ?? (equals < 0 ? args[index + 1] : args[index].slice(equals + 1))
      if (equals < 0) index++
      if (selected && !selected.inline) args[index - 1] = flag
      if (tool === 'awx-axi' && awx.adapterBoundary.structuredInputFlags.includes(flag.slice(2))) {
        if (!path?.startsWith('@')) continue
        path = path.slice(1)
      }
      if (path === '-' && (tool === 'gitea-axi' && ['--input', '--body-file', '--notes-file'].includes(flag) || tool === 'tenable-axi' || tool === 'falcon-axi' || tool === 'hybrid-axi' && flag === '--body-file'
        || tool === 'awx-axi' && (flag === '--password-file' || flag === '--inputs-file' && args[0] === 'credential'))) {
        if (input.stdin !== undefined) throw new ArtiumError('INVALID_INPUT')
        input.stdin = (await readBounded(process.stdin, inputLimits.stdinBytes, flag)).toString('utf8')
        continue
      }
      if (!path || path === '-') throw new ArtiumError('UNSUPPORTED_INPUT', 'A file flag requires a local file path.')
      if (mgUpload && (path.split(/[\\/]/).includes('..') || input.files?.length)) throw new ArtiumError('INVALID_INPUT')
      const name = mgUpload ? hunting ? 'query.kql' : 'rule.json' : basename(path)
      if (input.files?.some(file => file.name === name)) throw new ArtiumError('INVALID_INPUT', 'Upload file names must be distinct.')
      if ((input.files?.length ?? 0) >= inputLimits.files) throw new ArtiumError('INVALID_INPUT', 'Too many upload files.')
      const content = await readBounded(createReadStream(path), mgUpload ? 65536 : inputLimits.fileBytes)
      totalFileBytes += content.length
      if (totalFileBytes > inputLimits.totalFileBytes) throw new ArtiumError('INVALID_INPUT', 'Uploads exceed the total byte limit.')
      input.files ??= []
      input.files.push({ name, size: content.length, contentBase64: content.toString('base64') })
      args[index] = equals < 0 ? name : `${flag}=${name}`
    }
    let leading = 0
    while (args[leading]?.startsWith('-')) {
      const token = args[leading]
      const name = token.split('=')[0] === '-s' ? 'subscription' : token.slice(2).split('=')[0]
      if (!az.adapterBoundary.globalFlags.some(flag => flag.name === name) || name === 'help') break
      leading++
      if (!token.includes('=') && (name !== 'full' || ['true', 'false'].includes(args[leading]))) leading++
    }
    const route = az.commands.find(route => ['rg query', 'logs query', 'api'].includes(route.handlerCommand) &&
      route.command.split(' ').every((word, index) => args[leading + index] === word))
    let positional = false
    let explicitInput = false
    if (route) {
      for (let index = leading + route.command.split(' ').length; index < args.length; index++) {
        const token = args[index]
        if (token === '--') { positional ||= index + 1 < args.length; break }
        if (!token.startsWith('-') || token === '-') { positional = true; continue }
        const raw = token.slice(token.startsWith('--') ? 2 : 1).split('=')[0]
        const expanded = token.startsWith('--') ? raw : (route.shortFlags as Partial<Record<string, string>>)[raw] ?? raw
        const name = (route.flagAliases as Partial<Record<string, string>>)[expanded] ?? expanded
        if ((route.handlerCommand === 'api' ? ['body', 'body-file', 'data'] : ['graph-query', 'analytics-query']).includes(name)) explicitInput = true
        const kind = (route.flags as Partial<Record<string, string>>)[name]
        if (token.includes('=') || !kind) continue
        if (kind === 'boolean') {
          if (['true', 'false'].includes(args[index + 1])) index++
        } else {
          while (args[index + 1] !== undefined && (!args[index + 1].startsWith('-') || /^-\d/.test(args[index + 1]) ||
            (az.adapterBoundary.inputFileFlags.includes(name) && input.files?.some(file => file.name === args[index + 1])))) {
            index++
            if (!['list', 'literal-list'].includes(kind) || route.positionalInput) break
          }
        }
      }
    }
    if (tool === 'az-axi' && route && !input.files?.length && !explicitInput &&
      (route.handlerCommand === 'api' || !positional) && !process.stdin.isTTY) {
      const stdin = await readBounded(process.stdin, inputLimits.stdinBytes, route.handlerCommand === 'api' ? '--data (supported body flag: --body)' : '--file')
      if (stdin.length) input.stdin = stdin.toString('utf8')
    }
  }
  const parsed = runRequestSchema.safeParse({ args, ...input })
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  validateFileInput(tool, parsed.data.args, parsed.data)
  return parsed.data
}
