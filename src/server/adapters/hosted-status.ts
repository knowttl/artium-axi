import { decode, encode } from '@toon-format/toon'
import { ArtiumError } from '../../shared/errors.js'
import type { RunnerResult } from '../runner/runner.js'

// Status metadata describes the hosted credential, never the server's local layout.
export function hostedStatus(tool: string, args: readonly string[], result: RunnerResult): RunnerResult {
  if (result.exitCode !== 0 || args.includes('--help')
    || !(args.length === 0 || args[0] === 'home' || args[0] === 'auth' && args[1] === 'status')) return result
  if (result.truncated.stdout) throw new ArtiumError('INVALID_RESPONSE', 'The hosted status output was truncated.')
  try {
    const json = result.stdout.trimStart().startsWith('{')
    const document = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as Record<string, unknown>
    delete document.config
    delete document.configPath
    if (Object.hasOwn(document, 'bin')) document.bin = `artium-axi ${tool}`
    if (document.setup && typeof document.setup === 'object') document.setup = 'Managed by artium.'
    for (const field of ['source', 'bind_password_source']) {
      const source = document[field]
      if (typeof source === 'string' && /^(env|file):/.test(source)) document[field] = source.split(':')[0]
    }
    for (const field of ['apiKey', 'accessKey', 'secretKey']) {
      const reference = document[field]
      if (reference && typeof reference === 'object') {
        if (Object.hasOwn(reference, 'env')) document[field] = 'env'
        else if (Object.hasOwn(reference, 'file')) document[field] = 'file'
        else throw new Error('Unknown secret source')
      }
    }
    return { ...result, stdout: (json ? JSON.stringify(document) : encode(document)) + '\n' }
  } catch { throw new ArtiumError('INVALID_RESPONSE', 'The hosted status output is invalid.') }
}
