import { createHash } from 'node:crypto'
import inventory from '../../../tools/inventories/ado-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'

export const ADO_API_BODY_MAX_BYTES = 64 * 1024
const methods = ['POST', 'PATCH', 'PUT', 'DELETE']

// Reject ambiguous encodings instead of relying on URL resolution to remove them.
export function normalizeAdoApiPath(path: string): string {
  if (!path || path.startsWith('/') || /[?#\\\s:]/.test(path)) throw new ArtiumError('FLAG_BLOCKED')
  return path.split('/').map(segment => {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { throw new ArtiumError('FLAG_BLOCKED') }
    if (!decoded || ['.', '..'].includes(decoded) || /[/%?#\\:\x00-\x1f\x7f]/.test(decoded)) throw new ArtiumError('FLAG_BLOCKED')
    try { return encodeURIComponent(decoded) } catch { throw new ArtiumError('FLAG_BLOCKED') }
  }).join('/')
}

export function checkAdoApiWrite(method: string, path: string, flags: Map<string, string>): void {
  if (!methods.includes(method) || flags.has('host') || flags.has('query')) throw new ArtiumError('FLAG_BLOCKED')
  const body = flags.get('body')
  if (body === undefined) throw new ArtiumError('FLAG_BLOCKED')
  if (Buffer.byteLength(body) > ADO_API_BODY_MAX_BYTES) throw new ArtiumError('INVALID_INPUT')
  try { JSON.parse(body) } catch { throw new ArtiumError('INVALID_INPUT') }
  if (flags.has('content-type') && !['json', 'json-patch', 'merge-patch', 'application/json', 'application/json-patch+json', 'application/merge-patch+json'].includes(flags.get('content-type')!)) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
  let rules: unknown
  try { rules = JSON.parse(process.env.ARTIUM_AXI_ADO_API_WRITE_PATHS ?? '{}') } catch { throw new ArtiumError('FLAG_BLOCKED') }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new ArtiumError('FLAG_BLOCKED')
  const patterns = (rules as Record<string, unknown>)[method]
  if (!Array.isArray(patterns) || !patterns.some((pattern: unknown) => {
    if (typeof pattern !== 'string') return false
    try {
      const segments = pattern.split('/')
      const canonical = segments.map(segment => segment === '*' ? '*' : normalizeAdoApiPath(segment))
      const actual = path.split('/')
      return canonical.length === actual.length && canonical.every((segment, index) => segments[index] === '*' || segment === actual[index])
    } catch { return false }
  })) throw new ArtiumError('FLAG_BLOCKED')
}

// Also recognizes refused calls, before policy or strict argument validation.
export function adoApiAudit(args: readonly string[]) {
  const known = Object.assign({}, ...inventory.commands.map(route => route.flags)) as Record<string, string>
  const positionals: string[] = []
  const verbs: string[] = []
  let body = ''
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positionals.push(token); continue }
    const [name, ...inline] = token.replace(/^--/, '').split('=')
    const value = inline.length ? inline.join('=') : known[name] === 'boolean' ?
      ['true', 'false'].includes(args[index + 1]) ? args[++index] : 'true' : args[++index]
    if (name === 'method' || token === '-X') verbs.push((value ?? '').toUpperCase())
    if (name === 'body') body = value ?? ''
  }
  if (positionals[0] !== 'api') return undefined
  const positionalVerb = /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/i.test(positionals[1] ?? '')
  if (positionalVerb) verbs.push(positionals[1].toUpperCase())
  const method = verbs.find(verb => verb !== 'GET')
  if (!method) return undefined
  let path: string | null = null
  try { path = normalizeAdoApiPath(positionals[positionalVerb ? 2 : 1] ?? '') } catch { /* No safe path exists. */ }
  return { method, path, bodySha256: createHash('sha256').update(body).digest('hex'), bodyBytes: Buffer.byteLength(body) }
}
