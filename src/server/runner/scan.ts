import { decode } from '@toon-format/toon'

type OutputStream = 'stdout' | 'stderr'

export const secretFieldPattern = /(?:passwords?|passphrase|token|secret|(?:api|access|private|ssh)[-_]?key(?:[-_]?data)?|ssh_key_unlock|authorization|key)$/i
export const protocolOutputFields = ['code', 'action', 'type', 'status', 'would_send', 'help', 'label']

export function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>()
  for (const secret of secrets) {
    if (secret.length === 0) throw new Error('Secret values must be nonempty')
    const bytes = Buffer.from(secret, 'utf8')
    forms.add(secret)
    forms.add(bytes.toString('base64'))
    forms.add(bytes.toString('base64url'))
    forms.add(encodeURIComponent(secret))
    forms.add(JSON.stringify(secret).slice(1, -1))
  }
  return [...forms]
}

export function secretTokenPatterns(secrets: readonly string[]): string[] {
  return secretForms(secrets).map(form => `(?<![\\p{L}\\p{N}_])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`)
}

// Prefix lengths let a mismatch reuse a partial match without retaining output bytes.
function prefixLengths(bytes: Uint8Array): Uint32Array {
  const lengths = new Uint32Array(bytes.length)
  let length = 0
  for (let index = 1; index < bytes.length; index++) {
    while (length > 0 && bytes[index] !== bytes[length]) length = lengths[length - 1]
    if (bytes[index] === bytes[length]) length++
    lengths[index] = length
  }
  return lengths
}

/** One scanner per call. Scan every byte before retention or rewriting, even after the cap.
 * A true result is permanent and requires the caller to discard both output streams.
 * Only supplied values and their canonical encodings are known, not upstream-minted tokens.
 */
export class SecretScanner {
  readonly #patterns: { bytes: Buffer, prefixes: Uint32Array }[]
  readonly #positions: Record<OutputStream, Uint32Array>
  #matched = false
  readonly #valuePatterns: readonly RegExp[]
  readonly #chunks: Record<OutputStream, Buffer[]> = { stdout: [], stderr: [] }

  constructor(secrets: readonly string[], valueSecrets: readonly string[] = []) {
    this.#valuePatterns = secretTokenPatterns(valueSecrets).map(pattern => new RegExp(pattern, 'u'))
    this.#patterns = secretForms(secrets).map(form => {
      const bytes = Buffer.from(form, 'utf8')
      return { bytes, prefixes: prefixLengths(bytes) }
    })
    this.#positions = {
      stdout: new Uint32Array(this.#patterns.length),
      stderr: new Uint32Array(this.#patterns.length),
    }
  }

  scan(stream: OutputStream, chunk: Uint8Array): boolean {
    if (this.#matched) return true
    if (this.#valuePatterns.length) this.#chunks[stream].push(Buffer.from(chunk))
    const positions = this.#positions[stream]
    for (let index = 0; index < this.#patterns.length; index++) {
      const { bytes, prefixes } = this.#patterns[index]
      let position = positions[index]
      for (const byte of chunk) {
        while (position > 0 && byte !== bytes[position]) position = prefixes[position - 1]
        if (byte === bytes[position]) position++
        if (position === bytes.length) {
          this.#matched = true
          return true
        }
      }
      positions[index] = position
    }
    return false
  }

  finish(): boolean {
    const containsSecret = (value: unknown, key = ''): boolean => {
      if (protocolOutputFields.includes(key)) return false
      if (secretFieldPattern.test(key) && value !== null && typeof value !== 'boolean' && typeof value !== 'number') return true
      if (typeof value === 'string') return this.#valuePatterns.some(pattern => pattern.test(value))
      if (Array.isArray(value)) return value.some(child => containsSecret(child))
      return value !== null && typeof value === 'object' && Object.entries(value).some(([name, child]) => containsSecret(child, name))
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const chunks = this.#chunks[stream]
      this.#chunks[stream] = []
      if (!chunks.length) continue
      try { this.#matched ||= containsSecret(decode(Buffer.concat(chunks).toString('utf8'))) }
      catch { this.#matched = true }
    }
    return this.#matched
  }
}
