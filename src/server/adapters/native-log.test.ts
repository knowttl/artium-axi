import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { retainNativeWriteLog } from './native-log.js'

test('native retention preserves format and pairs crossing the 90-day boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-native-log-'))
  const path = join(directory, 'writes.log')
  const now = Date.UTC(2026, 9, 8)
  const cutoff = now - 90 * 24 * 60 * 60 * 1000
  const line = (kind: string, key: string, time: number) => JSON.stringify({ kind, intentKey: key.repeat(64), time: new Date(time).toISOString(), synthetic: 'preserved' })
  const old = [line('intent', 'a', cutoff - 2), line('outcome', 'a', cutoff - 1)]
  const recent = [line('intent', 'b', cutoff - 1), line('outcome', 'b', cutoff), line('intent', 'c', now)]
  try {
    writeFileSync(path, `${[...old, ...recent].join('\n')}\n`, { mode: 0o600 })
    writeFileSync(`${path}.lock`, '')
    retainNativeWriteLog(path, now)
    expect(readFileSync(path, 'utf8')).toBe(`${[...old, ...recent].join('\n')}\n`)
    rmSync(`${path}.lock`)
    retainNativeWriteLog(path, now)
    expect(readFileSync(path, 'utf8')).toBe(`${recent.join('\n')}\n`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    retainNativeWriteLog(path, now)
    expect(readFileSync(path, 'utf8')).toBe(`${recent.join('\n')}\n`)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test.each(['partial', '{invalid}\n', '{"kind":"intent"}\n'])('invalid native journal is preserved: %s', content => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-native-log-'))
  const path = join(directory, 'writes.log')
  try {
    writeFileSync(path, content)
    expect(() => retainNativeWriteLog(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(content)
    expect(() => statSync(`${path}.lock`)).toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
