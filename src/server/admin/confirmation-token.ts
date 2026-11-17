import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const key = randomBytes(32)

const sign = (sessionId: string, method: string, path: string, issuedAt: string) =>
  createHmac('sha256', key).update([sessionId, method.toUpperCase(), path, issuedAt].join('\0')).digest('base64url')

export function mintConfirmation(sessionId: string, method: string, path: string, now = Date.now()) {
  return `${now}.${sign(sessionId, method, path, String(now))}`
}

export function isConfirmed(value: unknown, sessionId: string, method: string, path: string) {
  if (typeof value !== 'string') return false
  const [issuedAt = '', signature = ''] = value.split('.')
  if (!/^\d{1,16}$/.test(issuedAt)) return false
  const expected = Buffer.from(sign(sessionId, method, path, issuedAt))
  const actual = Buffer.from(signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
