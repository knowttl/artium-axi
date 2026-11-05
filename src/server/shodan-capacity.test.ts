import { expect, test } from 'vitest'
import { ShodanCapacity } from './shodan-capacity.js'

const policy = { grants: {}, perUser: 1, perCredential: 2, total: 2, sessionEvents: 10, totalEvents: 20,
  sessionBytes: 100, totalBytes: 200, retentionSeconds: 60, leaseSeconds: 3600 }

test('session limits enforce user, credential and global ceilings', () => {
  const capacity = new ShodanCapacity()
  expect(capacity.reserve('one', 'first', 'credential', policy, {})).toEqual({ events: 10, bytes: 100, retentionSeconds: 60, leaseSeconds: 900 })
  expect(() => capacity.reserve('two', 'first', 'credential', policy, {})).toThrow(expect.objectContaining({ code: 'TOO_MANY_CALLS' }))
  capacity.reserve('two', 'second', 'credential', policy, {})
  expect(() => capacity.reserve('three', 'third', 'other', policy, {})).toThrow(expect.objectContaining({ code: 'TOO_MANY_CALLS' }))
})

test('retained output continues to reserve aggregate capacity after the worker stops', () => {
  const capacity = new ShodanCapacity()
  capacity.reserve('one', 'first', 'credential', policy, {})
  capacity.stopped('one')
  capacity.reserve('two', 'second', 'credential', policy, {})
  expect(() => capacity.reserve('three', 'third', 'other', policy, {})).toThrow(expect.objectContaining({ code: 'TOO_MANY_CALLS' }))
  capacity.release('one')
  expect(capacity.reserve('three', 'third', 'other', policy, { events: 1, bytes: 1, leaseSeconds: 1, retentionSeconds: 1 }))
    .toEqual({ events: 1, bytes: 1, retentionSeconds: 1, leaseSeconds: 1 })
})

test('caller bounds cannot increase an administrator ceiling', () => {
  const capacity = new ShodanCapacity()
  expect(() => capacity.reserve('one', 'first', 'credential', policy, { bytes: 101 })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})
