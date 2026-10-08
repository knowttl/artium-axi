import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { fakeTool } from '../../../test/fake-tool/tool.js'
import { SecretScanner } from './scan.js'

const streams = ['stdout', 'stderr'] as const
const canary = 'CANARY-☃ÿ?/+='
const forms = [
  ['raw', canary],
  ['base64', Buffer.from(canary).toString('base64')],
  ['base64url', Buffer.from(canary).toString('base64url')],
  ['url', encodeURIComponent(canary)],
] as const

test.each(streams)('security: detects every encoding at every byte split in %s', (stream) => {
  for (const [, form] of forms) {
    const bytes = Buffer.from(form)
    for (let offset = 0; offset <= bytes.length; offset++) {
      const scanner = new SecretScanner([canary])
      const first = scanner.scan(stream, bytes.subarray(0, offset))
      expect(first || scanner.scan(stream, bytes.subarray(offset))).toBe(true)
    }
  }
})

test.each(streams)('security: detects one-byte chunks across UTF-8 boundaries in %s', (stream) => {
  const scanner = new SecretScanner([canary])
  const bytes = Buffer.from(canary)
  for (const byte of bytes.subarray(0, -1)) {
    expect(scanner.scan(stream, Uint8Array.of(byte))).toBe(false)
  }
  expect(scanner.scan(stream, bytes.subarray(-1))).toBe(true)
})

test('security: partial matches stay separate when streams interleave', () => {
  const scanner = new SecretScanner(['CANARY-secret'])
  expect(scanner.scan('stdout', Buffer.from('CANARY-'))).toBe(false)
  expect(scanner.scan('stderr', Buffer.from('secret'))).toBe(false)
  expect(scanner.scan('stderr', Buffer.from('CANARY-'))).toBe(false)
  expect(scanner.scan('stdout', Buffer.from('secret'))).toBe(true)
  expect(scanner.scan('stderr', Buffer.from('safe'))).toBe(true)
  expect(scanner.scan('stdout', Buffer.alloc(0))).toBe(true)
})

test.each(['x', 'é', 'ab'])('security: scans short secret %s without a minimum length', (secret) => {
  for (const form of [secret, Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'), encodeURIComponent(secret)]) {
    expect(new SecretScanner([secret]).scan('stderr', Buffer.from(form))).toBe(true)
  }
})

test('security: rejects empty secret values without echoing supplied values', () => {
  expect(() => new SecretScanner([canary, ''])).toThrow('Secret values must be nonempty')
})

test('scan with no injected secrets accepts output', () => {
  expect(new SecretScanner([]).scan('stdout', Buffer.from('ordinary output'))).toBe(false)
})

test('security: scans multiple values and recovers overlapping partial matches', () => {
  const scanner = new SecretScanner(['unused-canary', 'ababac', 'ababac'])
  expect(scanner.scan('stdout', Buffer.from('ordinary abababa'))).toBe(false)
  expect(scanner.scan('stdout', Buffer.from('bac'))).toBe(true)
})

test('security: interrupted prefixes and near matches do not match', () => {
  const scanner = new SecretScanner([canary])
  expect(scanner.scan('stdout', Buffer.from('CANARY-other'))).toBe(false)
  expect(scanner.scan('stdout', Buffer.from(`${canary.slice(0, -1)}!`))).toBe(false)
  expect(scanner.scan('stderr', Buffer.from('ordinary diagnostics'))).toBe(false)
})

test.each(streams)('security: continues scanning %s across and after the 4 MiB cap', (stream) => {
  const cap = 4 * 1024 * 1024
  const block = Buffer.alloc(64 * 1024, 'x')
  for (const [, form] of forms) {
    for (const prefixBytes of [cap - 3, cap + block.length]) {
      const scanner = new SecretScanner([canary])
      let remaining = prefixBytes
      while (remaining > 0) {
        expect(scanner.scan(stream, block.subarray(0, Math.min(remaining, block.length)))).toBe(false)
        remaining -= Math.min(remaining, block.length)
      }
      const bytes = Buffer.from(form)
      expect(scanner.scan(stream, bytes.subarray(0, 3))).toBe(false)
      expect(scanner.scan(stream, bytes.subarray(3))).toBe(true)
    }
  }
})

test.each(streams)('security: scans fake-tool encoded leaks and split output in %s', async (stream) => {
  for (const [form, value] of forms) {
    for (const args of [['leak', form, stream], ['split', value, '8', stream]]) {
      const scanner = new SecretScanner([canary])
      const child = spawn(fakeTool.executable, [...fakeTool.args, ...args], {
        env: { ARTIUM_TEST_CANARY: canary }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let detected = false
      let otherBytes = 0
      child[stream].on('data', (chunk: Buffer) => { detected = scanner.scan(stream, chunk) || detected })
      child[stream === 'stdout' ? 'stderr' : 'stdout'].on('data', (chunk: Buffer) => {
        otherBytes += chunk.length
      })
      const [code, signal] = await once(child, 'close')
      expect({ code, signal, detected, otherBytes }).toEqual({ code: 0, signal: null, detected: true, otherBytes: 0 })
    }
  }
})
