import { decode } from '@toon-format/toon'

type OutputStream = 'stdout' | 'stderr'

export const protocolOutputFields = ['code', 'action', 'type', 'status', 'would_send', 'help', 'label']

export interface PrivateOutput {
  fields: Record<string, string>
  patterns: [string, string][]
}

export type PublicContent = (stdout: string, stderr: string) => readonly string[]

function secretForms(secrets: readonly string[]): string[] {
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

function secretTokenPatterns(secrets: readonly string[]): string[] {
  return secretForms(secrets).map(form => `(?<![\\p{L}\\p{N}_])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`)
}

export function privateOutput(inputs: readonly { field: string, content: string }[]): PrivateOutput {
  const fields: Record<string, string> = {}
  const patterns: [string, string][] = []
  let totalBytes = 0
  for (const { field, content } of inputs) {
    const bytes = Buffer.byteLength(content, 'utf8')
    const mask = `[structured input redacted, ${bytes} bytes]`
    fields[field] ??= mask
    totalBytes += bytes
    if (content.length) patterns.push(...secretTokenPatterns([content]).map(pattern => [pattern, mask] as [string, string]))
  }
  if (inputs.length) fields.payload = `[structured input redacted, ${totalBytes} bytes]`
  return { fields, patterns }
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

/** One scanner per call. Check output before persistence or delivery, even after the cap.
 * A true result is permanent and requires the caller to discard both output streams.
 * Only supplied values and their canonical encodings are known, not upstream-minted tokens.
 */
export class SecretScanner {
  readonly #patterns: { bytes: Buffer, prefixes: Uint32Array }[]
  readonly #positions: Record<OutputStream, Uint32Array>
  #matched = false
  readonly #valuePatterns: readonly RegExp[]
  readonly #chunks: Record<OutputStream, Buffer[]> = { stdout: [], stderr: [] }
  #projectedBytes = 0
  readonly #mintedSecrets: string[] = []

  constructor(private readonly secrets: readonly string[], private readonly output?: PrivateOutput,
    private readonly publicContent?: PublicContent) {
    this.#valuePatterns = (output?.patterns ?? []).map(([pattern]) => new RegExp(pattern, 'u'))
    this.#patterns = secretForms(secrets).map(form => {
      const bytes = Buffer.from(form, 'utf8')
      return { bytes, prefixes: prefixLengths(bytes) }
    })
    this.#positions = {
      stdout: new Uint32Array(this.#patterns.length),
      stderr: new Uint32Array(this.#patterns.length),
    }
  }

  registerSecrets(values: readonly string[]): void { this.#mintedSecrets.push(...values) }

  scan(stream: OutputStream, chunk: Uint8Array): boolean {
    if (this.#matched) return true
    if (this.output || this.publicContent) this.#chunks[stream].push(Buffer.from(chunk))
    if (this.publicContent) {
      // A reviewed structured protocol must be complete before its provider values can be selected.
      this.#projectedBytes += chunk.length
      this.#matched = this.#projectedBytes > 1024 * 1024
      return this.#matched
    }
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
    if (this.publicContent) {
      try {
        const values = this.publicContent(Buffer.concat(this.#chunks.stdout).toString('utf8'), Buffer.concat(this.#chunks.stderr).toString('utf8'))
        this.#matched ||= values.some(value => new SecretScanner([...this.secrets, ...this.#mintedSecrets]).scan('stdout', Buffer.from(value)))
      } catch { this.#matched = true }
      this.#chunks.stdout = []; this.#chunks.stderr = []
      return this.#matched
    }
    const fields = this.output?.fields ?? {}
    const masks = new Set([...Object.values(fields), ...(this.output?.patterns ?? []).map(([, mask]) => mask)])
    const containsSecret = (value: unknown, key = '', depth = 0): boolean => {
      if ((depth > 1 || key === 'payload') && Object.hasOwn(fields, key)) return value !== fields[key]
      if (protocolOutputFields.includes(key)) return false
      if (typeof value === 'string') return !masks.has(value) && this.#valuePatterns.some(pattern => pattern.test(value))
      if (Array.isArray(value)) return value.some(child => containsSecret(child, '', depth + 1))
      return value !== null && typeof value === 'object' && Object.entries(value).some(([name, child]) => containsSecret(child, name, depth + 1))
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
