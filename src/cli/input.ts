import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }
import { inputLimits, runRequestSchema } from '../shared/api.js'
import type { RunInput } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'

async function readBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
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
  }
  return Buffer.concat(chunks)
}

// Only the reviewed Azure file flags upload local contents; other paths remain arguments.
export async function toolInput(tool: string, original: string[]) {
  if (!runRequestSchema.safeParse({ args: original }).success) throw new ArtiumError('INVALID_INPUT')
  const args = [...original]
  const input: RunInput = {}
  let totalFileBytes = 0
  if (tool === 'az-axi' && !args.some(arg => ['--help', '-h', '--version', '-v', '-V'].includes(arg))) {
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--') break
      const [flag] = args[index].split('=')
      if (!az.adapterBoundary.inputFileFlags.some(name => flag === `--${name}`)) continue
      const equals = args[index].indexOf('=')
      const path = equals < 0 ? args[++index] : args[index].slice(equals + 1)
      if (!path || path === '-') throw new ArtiumError('UNSUPPORTED_INPUT', 'A file flag requires a local file path.')
      const name = basename(path)
      if (input.files?.some(file => file.name === name)) throw new ArtiumError('INVALID_INPUT', 'Upload file names must be distinct.')
      if ((input.files?.length ?? 0) >= inputLimits.files) throw new ArtiumError('INVALID_INPUT', 'Too many upload files.')
      const content = await readBounded(createReadStream(path), inputLimits.fileBytes)
      totalFileBytes += content.length
      if (totalFileBytes > inputLimits.totalFileBytes) throw new ArtiumError('INVALID_INPUT', 'Uploads exceed the total byte limit.')
      input.files ??= []
      input.files.push({ name, contentBase64: content.toString('base64') })
      args[index] = equals < 0 ? name : `${flag}=${name}`
    }
    if (!process.stdin.isTTY) {
      const stdin = await readBounded(process.stdin, inputLimits.stdinBytes)
      if (stdin.length) input.stdin = stdin.toString('utf8')
    }
  }
  const parsed = runRequestSchema.safeParse({ args, ...input })
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  return parsed.data
}
