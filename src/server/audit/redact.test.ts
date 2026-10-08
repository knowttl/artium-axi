import { expect, test } from 'vitest'
import { redactArguments } from './redact.js'

test.each([
  [['read', '--password', 'CANARY-secret'], [], ['read', '--password', '[redacted]']],
  [['--password=CANARY-secret', '--password', 'CANARY-again'], [], ['--password=[redacted]', '--password', '[redacted]']],
  [['read', 'CANARY-positional', '--plain=value'], [1], ['read', '[redacted]', '--plain=value']],
  [['--password', '--password', 'visible'], [], ['--password', '[redacted]', 'visible']],
])('redacts sensitive argument forms: %j', (args, positions, expected) => {
  expect(redactArguments(args, { flags: ['--password'], positions })).toEqual(expected)
})

test('escapes controls and bounds recorded argument count and length', () => {
  const args = ['one\ntwo\t\u001b\u0085', 'x'.repeat(1024), ...Array<string>(64).fill('extra')]
  const result = redactArguments(args, { flags: [], positions: [] })
  expect(result[0]).toBe('one\\u000atwo\\u0009\\u001b\\u0085')
  expect(result[1]).toBe(`${'x'.repeat(509)}...`)
  expect(result).toHaveLength(64)
})
