import { afterEach, expect, test, vi } from 'vitest'
import { ProtectedResults } from './protected-results.js'

const scope = { userId: 'synthetic-reader', credential: { id: 'synthetic-credential', tool: 'technitium-axi' as const, revision: 1 }, operation: 'OP-006' }
afterEach(() => { vi.useRealTimers() })

test('protected result references expire after five minutes', () => {
  vi.useFakeTimers()
  const results = new ProtectedResults()
  const reference = results.reserve(scope).commit(Buffer.from('confidential'))
  vi.advanceTimersByTime(5 * 60 * 1000)
  expect(() => results.take(reference.id, scope)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
})

test('per-user capacity is reserved before execution and released by cancellation or consumption', () => {
  vi.useFakeTimers()
  const results = new ProtectedResults()
  const first = results.reserve(scope)
  results.reserve(scope)
  results.reserve(scope)
  results.reserve(scope)
  expect(() => results.reserve(scope)).toThrow(expect.objectContaining({ code: 'TOO_MANY_CALLS' }))
  first.cancel()
  const next = results.reserve(scope).commit(Buffer.from('confidential'))
  expect(results.take(next.id, scope)).toEqual(Buffer.from('confidential'))
  const final = results.reserve(scope).commit(Buffer.from('next'))
  expect(results.take(final.id, scope)).toEqual(Buffer.from('next'))
})

test('result bytes over the one MiB bound cannot be published', () => {
  vi.useFakeTimers()
  const results = new ProtectedResults()
  const pending = results.reserve(scope)
  expect(() => pending.commit(Buffer.alloc(1024 * 1024 + 1))).toThrow(expect.objectContaining({ code: 'OUTPUT_LIMIT' }))
  pending.cancel()
  const next = results.reserve(scope).commit(Buffer.from('bounded'))
  expect(results.take(next.id, scope)).toEqual(Buffer.from('bounded'))
})
