import { expect, test } from 'vitest'
import { redactArguments } from './redact.js'

test.each([
  [['read', '--password', 'CANARY-secret'], [], ['read', '--password', '[redacted]']],
  [['--password=CANARY-secret', '--password', 'CANARY-again'], [], ['--password=[redacted]', '--password', '[redacted]']],
  [['read', 'CANARY-positional', '--plain=value'], [1], ['read', '[redacted]', '--plain=value']],
  [['--password', '--password', 'CANARY-secret'], [], ['--password', '[redacted]', '[redacted]']],
])('redacts sensitive argument forms: %j', (args, positions, expected) => {
  expect(redactArguments(args, { flags: ['--password'], positions })).toEqual(expected)
})

test.each(['--client-secret', '--client-id'])('redacts the value after repeated %s flags', flag => {
  const result = redactArguments(['detection', 'list', flag, flag, 'CANARY-secret'],
    { flags: ['--client-id', '--client-secret'], positions: [] })
  expect(result).toEqual(['detection', 'list', flag, '[redacted]', '[redacted]'])
  expect(result.join('')).not.toContain('CANARY-')
})

test.each([
  [['--client-id', '--client-secret', 'CANARY-secret'], [], ['--client-id', '[redacted]', '[redacted]']],
  [['--client-secret', '--client-id', 'CANARY-id'], [], ['--client-secret', '[redacted]', '[redacted]']],
  [['--client-secret', 'CANARY-secret'], [0], ['[redacted]', '[redacted]']],
  [['--client-id', 'CANARY-id'], [0], ['[redacted]', '[redacted]']],
  [['--client-secret', '--client-secret=CANARY-secret', 'visible'], [], ['--client-secret', '[redacted]', 'visible']],
  [['--client-id=CANARY-id', 'visible'], [], ['--client-id=[redacted]', 'visible']],
])('redacts sensitive values across overlapping argument forms: %j', (args, positions, expected) => {
  const result = redactArguments(args, { flags: ['--client-id', '--client-secret'], positions })
  expect(result).toEqual(expected)
  expect(result.join('')).not.toContain('CANARY-')
})

test('escapes controls and bounds recorded argument count and length', () => {
  const args = ['one\ntwo\t\u001b\u0085', 'x'.repeat(1024), ...Array<string>(64).fill('extra')]
  const result = redactArguments(args, { flags: [], positions: [] })
  expect(result[0]).toBe('one\\u000atwo\\u0009\\u001b\\u0085')
  expect(result[1]).toBe(`${'x'.repeat(509)}...`)
  expect(result).toHaveLength(64)
})
