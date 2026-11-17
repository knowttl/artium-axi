import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { browserDefaults } from '../config.js'

const key = randomBytes(32)

const sign = (sessionId: string, method: string, path: string, name: string, issuedAt: string) =>
  createHmac('sha256', key).update([sessionId, method.toUpperCase(), path, name, issuedAt].join('\0')).digest('base64url')

export function mintConfirmation(sessionId: string, method: string, path: string, name: string, now = Date.now()) {
  return `${now}.${sign(sessionId, method, path, name, String(now))}`
}

export function checkConfirmation(value: unknown, sessionId: string, method: string, path: string, name: string, now = Date.now()): 'confirmed' | 'lapsed' | 'invalid' {
  if (typeof value !== 'string') return 'invalid'
  const [issuedAt = '', signature = ''] = value.split('.')
  if (!/^\d{1,16}$/.test(issuedAt) || now - Number(issuedAt) < 0) return 'invalid'
  const expected = Buffer.from(sign(sessionId, method, path, name, issuedAt))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return 'invalid'
  return now - Number(issuedAt) > browserDefaults.idleMs ? 'lapsed' : 'confirmed'
}
