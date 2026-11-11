import { ArtiumError } from '../../shared/errors.js'
import { canonicalizePath } from '../policy/raw-api.js'

export const ADO_API_BODY_MAX_BYTES = 64 * 1024
const methods = ['POST', 'PATCH', 'PUT', 'DELETE']

export function normalizeAdoApiPath(path: string): string {
  if (!path || path.startsWith('/') || /[?#\\\s:]/.test(path)) throw new ArtiumError('FLAG_BLOCKED')
  return canonicalizePath(path)
}

export function checkAdoApiWrite(method: string, flags: Map<string, string>): void {
  if (!methods.includes(method) || flags.has('host') || flags.has('query')) throw new ArtiumError('FLAG_BLOCKED')
  const body = flags.get('body')
  if (body === undefined) throw new ArtiumError('FLAG_BLOCKED')
  if (Buffer.byteLength(body) > ADO_API_BODY_MAX_BYTES) throw new ArtiumError('INVALID_INPUT')
  try { JSON.parse(body) } catch { throw new ArtiumError('INVALID_INPUT') }
  if (flags.has('content-type') && !['json', 'json-patch', 'merge-patch', 'application/json', 'application/json-patch+json', 'application/merge-patch+json'].includes(flags.get('content-type')!)) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
}
