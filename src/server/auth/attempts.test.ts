import { expect, test } from 'vitest'
import { AuthRateLimits } from './attempts.js'
import { authDefaults } from '../config.js'

test('canonical username limits apply across different addresses and expire exactly', () => {
  const limits = new AuthRateLimits()
  for (let index = 0; index < 5; index++) limits.admit(' Synthetic-USER ', `192.0.2.${index}`, 0)
  expect(() => limits.admit('synthetic-user', '192.0.2.10', 899_999)).toThrow(expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }))
  expect(() => limits.admit('synthetic-user', '192.0.2.10', 900_000)).not.toThrow()
})

test('clearing a canonical username preserves other username counters', () => {
  const limits = new AuthRateLimits()
  for (let index = 0; index < 5; index++) {
    limits.admit('synthetic-user', '192.0.2.1', 0)
    limits.admit('other-user', '192.0.2.1', 0)
  }
  limits.clearUsername(' Synthetic-USER ')
  expect(() => limits.admit('synthetic-user', '192.0.2.1', 1)).not.toThrow()
  expect(() => limits.admit('other-user', '192.0.2.1', 1)).toThrow(expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }))
})

test('clearing a username preserves the address counter', () => {
  const limits = new AuthRateLimits()
  for (let index = 0; index < authDefaults.addressAttempts; index++) {
    limits.admit('synthetic-user', '192.0.2.1', 0)
    limits.clearUsername('synthetic-user')
  }
  expect(() => limits.admit('synthetic-user', '192.0.2.1', 1)).toThrow(expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }))
  expect(() => limits.admit('synthetic-user', '192.0.2.2', 1)).not.toThrow()
})

test('unknown username counters refuse new keys at capacity without evicting active limits', () => {
  const limits = new AuthRateLimits()
  for (let index = 0; index < authDefaults.counterKeys; index++) limits.admit(`unknown-${index}`, `address-${Math.floor(index / 30)}`, 0)
  expect(() => limits.admit('one-more-unknown', 'fresh-address', 1)).toThrow(expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }))
  expect(() => limits.admit('unknown-0', 'fresh-address', 1)).not.toThrow()
  expect(() => limits.admit('one-more-unknown', 'fresh-address', 900_000)).not.toThrow()
})

test('address counters refuse new keys at capacity and recover after expiry', () => {
  const limits = new AuthRateLimits()
  for (let index = 0; index < authDefaults.counterKeys; index++) limits.admit(`unknown-${index}`, `address-${index}`, 0)
  expect(() => limits.admit('unknown-0', 'fresh-address', 1)).toThrow(expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }))
  expect(() => limits.admit('unknown-0', 'fresh-address', 900_000)).not.toThrow()
})
