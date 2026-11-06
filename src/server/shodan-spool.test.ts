import { expect, test } from 'vitest'
import { ShodanSpool } from './shodan-spool.js'

test('bounded reads reject stale and forged continuations', () => {
  const spool = new ShodanSpool(3, 1024, 1000)
  spool.append({ id: 'first' }); spool.append({ id: 'second' })
  const first = spool.read(undefined, 1, false)
  expect(first).toMatchObject({ items: [{ sequence: 1, value: { id: 'first' } }], lost: [], complete: false })
  expect(spool.available(first.continuation)).toBe(true)
  expect(() => spool.read(undefined, 1, false)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  expect(() => spool.read('forged', 1, false)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  const second = spool.read(first.continuation, 1, true)
  expect(second).toMatchObject({ items: [{ sequence: 2, value: { id: 'second' } }], lost: [], complete: true })
  expect(spool.available(second.continuation)).toBe(false)
  expect(() => spool.read(first.continuation, 1, true)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

test('eviction, upstream loss and expiry are reported without claiming completeness', () => {
  let now = 0
  const spool = new ShodanSpool(2, 1024, 100, () => now)
  spool.append({ id: 'evicted' }); spool.append({ id: 'retained' }); spool.append({ id: 'newer' })
  spool.upstreamLoss(2, 'debug')
  const first = spool.read(undefined, 2, false)
  expect(first).toMatchObject({ items: [{ sequence: 2, value: { id: 'retained' } }, { sequence: 3, value: { id: 'newer' } }],
    lost: [{ from: 1, to: 1, reason: 'evicted' }], complete: false })
  now = 101
  spool.append({ id: 'last' })
  const second = spool.read(first.continuation, 2, true)
  expect(second).toMatchObject({ items: [{ sequence: 4, value: { id: 'last' } }],
    lost: [], upstreamLoss: { debug: 2 }, complete: false })
})

test('events expiring before a read are disclosed', () => {
  let now = 0
  const spool = new ShodanSpool(2, 1024, 100, () => now)
  spool.append({ id: 'expired' })
  now = 101
  expect(spool.read(undefined, 1, true)).toMatchObject({ items: [], lost: [{ from: 1, to: 1, reason: 'expired' }], complete: false })
})

test('new upstream loss wakes a reader even when no event arrives', () => {
  const spool = new ShodanSpool(2, 1024, 1000)
  const first = spool.read(undefined, 1, false)
  expect(spool.available(first.continuation)).toBe(false)
  spool.upstreamLoss(3, 'upstream-discarded')
  expect(spool.available(first.continuation)).toBe(true)
  expect(spool.read(first.continuation, 1, false)).toMatchObject({ items: [], lost: [], upstreamLoss: { 'upstream-discarded': 3 } })
})
