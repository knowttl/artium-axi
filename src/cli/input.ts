import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }
import hybrid from '../../tools/inventories/hybrid-axi.json' with { type: 'json' }
import tenable from '../../tools/inventories/tenable-axi.json' with { type: 'json' }
import checkpoint from '../../tools/inventories/checkpoint-axi.json' with { type: 'json' }
import { inputLimits, runRequestSchema } from '../shared/api.js'
import type { RunInput } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'

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
  const args = [...original]
  const input: RunInput = {}
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
  if ((tool === 'checkpoint-axi' || tool === 'az-axi' || tool === 'hybrid-axi' || tool === 'tenable-axi' || mgUpload) && !args.some(arg => ['--help', '-h', '--version', '-v', '-V'].includes(arg))) {
    const fileFlags = mgUpload ? ['file'] : tool === 'checkpoint-axi' ? checkpoint.adapterBoundary.inputFileFlags : tool === 'tenable-axi' ? tenable.adapterBoundary.inputFileFlags
      : tool === 'hybrid-axi' ? hybrid.adapterBoundary.inputFileFlags : az.adapterBoundary.inputFileFlags
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--') break
      const [flag] = args[index].split('=')
      if (!fileFlags.some(name => flag === `--${name}`)) continue
      const equals = args[index].indexOf('=')
      const path = equals < 0 ? args[++index] : args[index].slice(equals + 1)
      if (path === '-' && (tool === 'tenable-axi' || tool === 'hybrid-axi' && flag === '--body-file')) {
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
      input.files.push({ name, contentBase64: content.toString('base64') })
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
  return parsed.data
}
