import { afterEach, expect, test, vi } from 'vitest'
import { ProtectedResults } from './protected-results.js'
import { buildSync } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const scope = { userId: 'synthetic-reader', credential: { id: 'synthetic-credential', tool: 'technitium-axi' as const, revision: 1 }, operation: 'OP-006' }
afterEach(() => { vi.useRealTimers() })

test('consumption releases confidential bytes after garbage collection', async () => {
  const bundle = buildSync({ entryPoints: ['src/server/protected-results.ts'], bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
  const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', bundle + `
    const results = new ProtectedResults();
    const scope = ${JSON.stringify(scope)};
    const consumed = (() => {
      const pending = results.reserve(scope);
      const reference = pending.commit(Buffer.alloc(1024 * 1024));
      return new WeakRef(results.take(reference.id, scope));
    })();
    const control = (() => new WeakRef(Buffer.alloc(1024 * 1024)))();
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
    console.log(JSON.stringify({ retained: consumed.deref() !== undefined, control: control.deref() !== undefined }));
  `])
  expect(JSON.parse(stdout)).toEqual({ retained: false, control: false })
})

test.each(['take', 'cancel', 'clear', 'prune'])('%s releases expiration resources', action => {
  vi.useFakeTimers()
  const results = new ProtectedResults()
  const pending = results.reserve(scope)
  const reference = pending.commit(Buffer.from('confidential'))
  expect(vi.getTimerCount()).toBe(1)
  if (action === 'take') results.take(reference.id, scope)
  if (action === 'cancel') pending.cancel()
  if (action === 'clear') results.clear()
  if (action === 'prune') {
    vi.setSystemTime(Date.now() + 300001)
    results.reserve(scope).cancel()
  }
  expect(vi.getTimerCount()).toBe(0)
  expect(() => results.take(reference.id, scope)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
})

test('protected result references expire after five minutes', () => {
  vi.useFakeTimers()
  const results = new ProtectedResults()
  const reference = results.reserve(scope).commit(Buffer.from('confidential'))
  vi.advanceTimersByTime(5 * 60 * 1000)
  expect(() => results.take(reference.id, scope)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
})

test('a different sign-in family cannot consume the issuing family private result', () => {
  const results = new ProtectedResults()
  const issuer = { ...scope, credential: { ...scope.credential, tool: 'kubernetes-axi' as const }, operation: 'token-create', familyId: 'issuing-family' }
  const reference = results.reserve(issuer).commit(Buffer.from('CANARY-issued-credential'))
  expect(() => results.take(reference.id, { ...issuer, familyId: 'different-family' }))
    .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  expect(results.take(reference.id, issuer)).toEqual(Buffer.from('CANARY-issued-credential'))
})

test('delegated sessions and the creator cannot consume each other’s private results', () => {
  const results = new ProtectedResults()
  const delegated = { ...scope, familyId: 'delegated-family', delegated: true, familyOnly: true }
  const ownerResult = results.reserve(scope).commit(Buffer.from('owner result'))
  const delegatedResult = results.reserve(delegated).commit(Buffer.from('delegated result'))
  expect(() => results.take(ownerResult.id, delegated)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  expect(() => results.take(delegatedResult.id, scope)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  expect(results.take(ownerResult.id, scope)).toEqual(Buffer.from('owner result'))
  expect(results.take(delegatedResult.id, delegated)).toEqual(Buffer.from('delegated result'))
})

test('delegated result reservations leave capacity for the creator', () => {
  const results = new ProtectedResults()
  const delegated = { ...scope, familyId: 'delegated-family', delegated: true }
  const first = results.reserve(delegated)
  const second = results.reserve(delegated)
  expect(() => results.reserve(delegated)).toThrow(expect.objectContaining({ code: 'TOO_MANY_CALLS' }))
  const owner = results.reserve(scope)
  first.cancel(); second.cancel(); owner.cancel()
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

test('result bytes over the four MiB bound cannot be published', () => {
  vi.useFakeTimers()
  const results = new ProtectedResults()
  const pending = results.reserve(scope)
  expect(() => pending.commit(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow(expect.objectContaining({ code: 'OUTPUT_LIMIT' }))
  pending.cancel()
  const next = results.reserve(scope).commit(Buffer.from('bounded'))
  expect(results.take(next.id, scope)).toEqual(Buffer.from('bounded'))
})
