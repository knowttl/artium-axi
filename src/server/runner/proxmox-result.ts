import { z } from 'zod'
import { RunnerError } from './runner.js'

const bindingSchema = z.strictObject({ origin: z.string(), identity: z.string(), operation: z.string(),
  request: z.string(), actor: z.string(), credentialRevision: z.string() })
export type ProxmoxResultBinding = z.infer<typeof bindingSchema>
const frameSchema = z.strictObject({ version: z.literal(1), binding: bindingSchema, payload: z.json() })
const protectedField = /^(?:password|passwd|secret|token|ticket|otp|challenge|recovery|value|csrf[-_]?prevention[-_]?token|private[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie)$/i

// The published S4 channel contains exactly one bounded frame per native call.
export function proxmoxResult(bytes: Buffer, expected: ProxmoxResultBinding) {
  if (bytes.length < 5 || bytes.length > 65540 || bytes.readUInt32BE(0) !== bytes.length - 4) throw new RunnerError('UNKNOWN_OUTCOME')
  let value: unknown
  try { value = JSON.parse(bytes.subarray(4).toString('utf8')) } catch { throw new RunnerError('UNKNOWN_OUTCOME') }
  const parsed = frameSchema.safeParse(value)
  if (!parsed.success || Object.entries(expected).some(([key, value]) => parsed.data.binding[key as keyof ProxmoxResultBinding] !== value)) {
    throw new RunnerError('UNKNOWN_OUTCOME')
  }
  const secrets: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value) secrets.push(value)
    else if (Array.isArray(value)) for (const item of value) collect(item)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item)
  }
  const minted = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) minted(item)
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (protectedField.test(key)) collect(item)
      else minted(item)
    }
  }
  minted(parsed.data.payload)
  return { payload: parsed.data.payload, secrets }
}
