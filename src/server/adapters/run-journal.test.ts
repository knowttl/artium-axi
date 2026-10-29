import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { retainRunJournals } from './run-journal.js'

const directories: string[] = []
const now = Date.UTC(2026, 9, 29)
const cutoff = now - 90 * 24 * 60 * 60 * 1000
const time = new Date(cutoff - 1).toISOString()
const auditId = '11111111-1111-4111-8111-111111111111'
const host = { state: 'intent', auditId, operation: 'synthetic.write', time }
const falcon = { timestamp: time, run: 'synthetic-run', phase: 'outcome' }

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function journalRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'artium-run-retention-'))
  directories.push(directory)
  return join(directory, 'writes.log')
}

test.each(['falcon-axi', 'beyondtrust-axi'] as const)('%s expires whole run directories strictly older than 90 days', async tool => {
  const log = journalRoot()
  const expired = join(`${log}.runs`, 'run-expired')
  const boundary = join(`${log}.runs`, 'run-boundary')
  const recent = join(`${log}.runs`, 'run-recent')
  const other = join(`${log}.runs`, 'other')
  for (const path of [expired, boundary, recent, other]) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'writes.log'), `${JSON.stringify(falcon)}\n`)
    writeFileSync(join(path, 'intent.json'), JSON.stringify(host))
    const native = join(path, 'beyondtrust-axi', 'writes')
    mkdirSync(native, { recursive: true })
    writeFileSync(join(native, `${auditId}.json`), JSON.stringify(host))
    utimesSync(path, new Date(cutoff - 1), new Date(cutoff - 1))
  }
  utimesSync(boundary, new Date(cutoff), new Date(cutoff))
  utimesSync(recent, new Date(now), new Date(now))
  await retainRunJournals(log, tool, now)
  expect([expired, boundary, recent, other].map(existsSync)).toEqual([false, true, true, true])
})

test.each(['falcon-axi', 'beyondtrust-axi'] as const)('%s removes old pre-send directories without native evidence', async tool => {
  const log = journalRoot()
  const path = join(`${log}.runs`, 'run-no-native')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'intent.json'), JSON.stringify(host))
  utimesSync(path, new Date(cutoff - 1), new Date(cutoff - 1))
  await retainRunJournals(log, tool, now)
  expect(existsSync(path)).toBe(false)
})

test.each([
  ['falcon-axi', 'writes.log', 'CANARY-retention-secret'],
  ['falcon-axi', 'writes.log', '{"timestamp":"invalid","run":"synthetic","phase":"outcome"}\n'],
  ['beyondtrust-axi', 'intent.json', '{"state":"intent","time":"invalid"}'],
  ['beyondtrust-axi', `beyondtrust-axi/writes/${auditId}.json`, 'CANARY-retention-secret'],
  ['beyondtrust-axi', 'beyondtrust-axi/writes/unexpected.json', JSON.stringify(host)],
] as const)('%s preserves malformed %s and continues independent cleanup', async (tool, file, content) => {
  const log = journalRoot()
  const damaged = join(`${log}.runs`, 'run-a-damaged')
  const expired = join(`${log}.runs`, 'run-z-expired')
  mkdirSync(join(damaged, 'beyondtrust-axi', 'writes'), { recursive: true })
  mkdirSync(expired, { recursive: true })
  writeFileSync(join(damaged, 'intent.json'), JSON.stringify(host))
  writeFileSync(join(expired, 'intent.json'), JSON.stringify(host))
  writeFileSync(join(damaged, file), content)
  utimesSync(damaged, new Date(cutoff - 1), new Date(cutoff - 1))
  utimesSync(expired, new Date(cutoff - 1), new Date(cutoff - 1))
  await expect(retainRunJournals(log, tool, now)).rejects.toThrow()
  expect(readFileSync(join(damaged, file), 'utf8')).toBe(content)
  expect(existsSync(expired)).toBe(false)
})
