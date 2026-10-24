import { decode, encode } from '@toon-format/toon'
import { ArtiumError } from '../../shared/errors.js'
import type { RunnerResult } from '../runner/runner.js'
import type { PreparedCall } from './types.js'

// Status metadata describes the hosted credential, never the server's local layout.
export function hostedStatus(tool: string, invocation: PreparedCall['invocation'], result: RunnerResult): RunnerResult {
  if (!invocation || invocation.help || !['home', 'auth status'].includes(invocation.command)) return result
  if (result.truncated.stdout || result.truncated.stderr) throw new ArtiumError('INVALID_RESPONSE', 'The hosted status output was truncated.')
  try {
    const json = result.stdout.trimStart().startsWith('{')
    const document = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as Record<string, unknown>
    const references = new Map<string, string>()
    const replace = (value: unknown, kind: string) => {
      if (typeof value === 'string' && value.length > kind.length) references.set(value, kind)
      return kind
    }
    const sourceKind = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const match = /^(env|file|stored):(.+)$/.exec(value)
        if (match) {
          const kind = match[1] === 'stored' ? 'file' : match[1]
          replace(match[2], kind)
          return replace(value, kind)
        }
        return value === 'stored' ? 'file' : value
      }
      if (value && typeof value === 'object') {
        const reference = value as Record<string, unknown>
        if (Object.hasOwn(reference, 'env')) return replace(reference.env, 'env')
        if (Object.hasOwn(reference, 'file')) return replace(reference.file, 'file')
        if (Object.hasOwn(reference, 'stored')) return 'file'
        throw new Error('Unknown secret source')
      }
      return value
    }
    for (const field of ['config', 'configPath', 'credential_path']) {
      replace(document[field], 'file')
      delete document[field]
    }
    if (Object.hasOwn(document, 'bin')) document.bin = replace(document.bin, `artium-axi ${tool}`)
    if (document.setup && typeof document.setup === 'object') document.setup = 'Managed by artium.'
    for (const field of ['source', 'bind_password_source', 'client_secret_source', 'apiKey', 'accessKey', 'secretKey']) {
      if (Object.hasOwn(document, field)) document[field] = sourceKind(document[field])
    }
    if (document.secrets && typeof document.secrets === 'object') {
      const secrets = document.secrets as Record<string, unknown>
      for (const field of Object.keys(secrets)) secrets[field] = sourceKind(secrets[field])
    }
    if (tool === 'awx-axi' && document.auth && typeof document.auth === 'object') {
      const auth = document.auth as Record<string, unknown>
      if (typeof auth.source === 'string' && auth.source !== 'none') {
        auth.source = replace(auth.source, /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.source) && !['file', 'stored'].includes(auth.source) ? 'env' : 'file')
      }
    }
    if (Array.isArray(document.sources)) {
      for (const source of document.sources as Record<string, unknown>[]) {
        if (Object.hasOwn(source, 'source')) source.source = sourceKind(source.source)
        if (Object.hasOwn(source, 'location')) {
          source.kind = sourceKind(source.kind)
          replace(source.location, source.kind === 'env' ? 'env' : 'file')
          delete source.location
        }
      }
    }
    const sanitize = (text: string) => {
      for (const [reference, kind] of [...references].sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(reference, kind)
      return text
    }
    for (const field of ['error', 'help']) {
      if (Object.hasOwn(document, field)) document[field] = JSON.parse(JSON.stringify(document[field], (_, value: unknown) =>
        typeof value === 'string' ? sanitize(value) : value))
    }
    return { ...result, stdout: (json ? JSON.stringify(document) : encode(document)) + '\n', stderr: sanitize(result.stderr) }
  } catch { throw new ArtiumError('INVALID_RESPONSE', 'The hosted status output is invalid.') }
}
