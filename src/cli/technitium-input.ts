import { constants } from 'node:fs'
import { open, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { inputLimits, runRequestSchema } from '../shared/api.js'
import type { RunInput } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { technitiumInput, technitiumObject, technitiumSecretNames } from '../shared/technitium-input.js'
import inventory from '../../tools/inventories/technitium-axi.json' with { type: 'json' }

async function readPrivate(path: string): Promise<Buffer> {
  try {
    if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new ArtiumError('INVALID_INPUT')
    const before = await lstat(path)
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > inputLimits.fileBytes) throw new ArtiumError('INVALID_INPUT')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const after = await handle.stat()
      if (after.ino !== before.ino || after.dev !== before.dev) throw new ArtiumError('INVALID_INPUT')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length
        if (size > inputLimits.fileBytes) throw new ArtiumError('INVALID_INPUT')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    } finally { await handle.close() }
  } catch { throw new ArtiumError('INVALID_INPUT', 'Use an owned private regular file with a direct absolute path within the upload limit.') }
}

export async function technitiumToolInput(original: string[]) {
  const args = [...original]
  const index = args.findIndex(arg => arg === '--input-file' || arg.startsWith('--input-file='))
  if (index < 0 || args.includes('--help')) return undefined
  if (args.filter(arg => arg === '--input-file' || arg.startsWith('--input-file=')).length !== 1) throw new ArtiumError('INVALID_INPUT')
  const route = inventory.commands.find(route => route.command.split(' ').every((word, offset) => args[offset] === word))
  if (!route?.operation || !route.nativeInput) throw new ArtiumError('FLAG_BLOCKED')
  const inline = args[index].includes('=')
  const path = inline ? args[index].slice('--input-file='.length) : args[index + 1]
  if (!path || path.startsWith('-')) throw new ArtiumError('INVALID_INPUT')
  let value: unknown
  try { value = JSON.parse((await readPrivate(path)).toString('utf8')) } catch { throw new ArtiumError('INVALID_INPUT') }
  if (!technitiumObject(value) || !technitiumObject(value.parameters)) throw new ArtiumError('INVALID_INPUT')
  const parameters = value.parameters
  if (route.operation === 'OP-003' && ['user', 'pass', 'totp'].some(key => Object.hasOwn(parameters, key))) throw new ArtiumError('FLAG_BLOCKED')
  if (value.secrets !== undefined && !technitiumObject(value.secrets)) throw new ArtiumError('INVALID_INPUT')
  const secrets: Record<string, string> = technitiumObject(value.secrets) ? { ...value.secrets } as Record<string, string> : {}
  const files: NonNullable<RunInput['files']> = []
  const upload = async (path: unknown, name: string) => {
    if (typeof path !== 'string') throw new ArtiumError('INVALID_INPUT')
    const content = await readPrivate(path)
    files.push({ name, size: content.length, contentBase64: content.toString('base64') })
  }
  if (technitiumObject(value.upload)) { await upload(value.upload.file, 'upload.bin'); value.upload.file = 'upload.bin' }
  if (route.operation === 'OP-076' && technitiumObject(value.parameters.config)) {
    await upload(value.parameters.config.file, 'config.bin'); value.parameters.config.file = 'config.bin'
  }
  const reserved = new Set(Object.keys(secrets))
  let nextSecret = 0
  const visit = async (node: unknown, materialize: boolean, key = '', depth = 0): Promise<void> => {
    if (depth > 24) throw new ArtiumError('INVALID_INPUT')
    if (technitiumSecretNames.has(key)) {
      if (!technitiumObject(node) || Object.keys(node).length !== 1) throw new ArtiumError('FLAG_BLOCKED')
      if (typeof node.env === 'string' && /^TECHNITIUM_INPUT_[A-Z0-9_]+$/.test(node.env)) {
        reserved.add(node.env)
        if (!materialize) return
        const secret = secrets[node.env] ?? process.env[node.env]
        if (secret === undefined) throw new ArtiumError('INVALID_INPUT')
        secrets[node.env] = secret
      } else if (typeof node.file === 'string') {
        if (!materialize) return
        let name: string
        do { name = 'TECHNITIUM_INPUT_FILE_' + nextSecret++ } while (reserved.has(name))
        reserved.add(name)
        secrets[name] = (await readPrivate(node.file)).toString('utf8')
        delete node.file; node.env = name
      } else throw new ArtiumError('FLAG_BLOCKED')
    } else if (Array.isArray(node)) for (const item of node) await visit(item, materialize, '', depth + 1)
    else if (technitiumObject(node)) for (const [name, child] of Object.entries(node)) {
      if (route.operation === 'OP-076' && key === '' && name === 'config') continue
      await visit(child, materialize, name, depth + 1)
    }
  }
  for (const materialize of [false, true]) {
    await visit(value.parameters, materialize)
    if (value.baseline !== undefined) await visit(value.baseline, materialize)
  }
  value.secrets = secrets
  const content = Buffer.from(JSON.stringify(value))
  files.unshift({ name: 'input.json', size: content.length, contentBase64: content.toString('base64') })
  args.splice(index, inline ? 1 : 2, '--input-file', 'input.json')
  const parsed = runRequestSchema.safeParse({ args, files })
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  technitiumInput(route.operation, 'input.json', parsed.data)
  return parsed.data
}
