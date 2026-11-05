import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { shodanProfile } from './adapters/shodan.js'
import { toolPaths } from './config.js'
import { ShodanWorker } from './shodan-worker.js'

const processBoundary = vi.hoisted(() => ({ spawned: undefined as (() => void) | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) => {
    const child = original.spawn(command, args, options)
    child.once('spawn', () => processBoundary.spawned?.())
    return child
  } }
})

let root: string
const previous = toolPaths['shodan-axi']
const input = { operation: 'OP-046', selector: {}, bounds: { limit: 10, maxBytes: 4096, timeout: 10000, idleTimeout: 5000 },
  limits: {}, acceptUnknownCost: true as const }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shodan-worker-'))
  mkdirSync(join(root, 'bin'))
  copyFileSync(fileURLToPath(new URL('../../test/fake-service/shodan-stream-worker.mjs', import.meta.url)), join(root, 'bin/shodan-stream-worker.js'))
  Object.assign(toolPaths, { 'shodan-axi': join(root, 'bin/shodan-axi.js') })
  process.env.CANARY_AMBIENT = 'must-not-inherit'
})
afterEach(() => {
  processBoundary.spawned = undefined
  Object.assign(toolPaths, { 'shodan-axi': previous })
  delete process.env.CANARY_AMBIENT
  delete process.env.NODE_EXTRA_CA_CERTS
  delete process.env.SSL_CERT_FILE
  rmSync(root, { recursive: true, force: true })
})

test.each([
  { configuredCaPem: undefined, expected: 'no-configured-ca' },
  { configuredCaPem: 'synthetic-configured-ca', expected: 'synthetic-configured-ca' },
])('worker uses only its configured CA bundle', async ({ configuredCaPem, expected }) => {
  process.env.NODE_EXTRA_CA_CERTS = join(root, 'ambient-ca')
  process.env.SSL_CERT_FILE = join(root, 'ambient-ca')
  const directory = join(root, 'private'), events: unknown[] = []
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const worker = new ShodanWorker({ directory, input, confirmation: 'trust', configuredCaPem, profile: profile(), signal: new AbortController().signal,
    authorize: () => {}, onEvent: event => events.push(event), onLoss: () => {}, onReady: ready })
  const running = worker.start()
  await started
  await worker.stop()
  await running
  expect(events).toEqual([{ profile: 'artium', isolated: true, value: expected }])
  expect(existsSync(directory)).toBe(false)
})

const profile = () => shodanProfile.prepare('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, undefined, false)

test.each(['idle-timeout', 'max-seconds'])('worker retains a %s summary before readiness', async reason => {
  const summaries: unknown[] = []
  const worker = new ShodanWorker({ directory: join(root, 'private'), input, confirmation: reason, profile: profile(), signal: new AbortController().signal,
    authorize: () => {}, onEvent: () => {}, onLoss: () => {}, onReady: () => { throw new Error('Unexpected readiness') },
    onClosed: summary => summaries.push(summary) })
  await worker.start()
  expect(summaries).toEqual([{ stopReason: reason, count: 0, bytes: 0, partialRecordCount: 0, debugDiscarded: 0 }])
})

test('worker accepts loss records within the upstream byte bound', async () => {
  const losses: number[] = []
  const worker = new ShodanWorker({ directory: join(root, 'private'), input: { ...input, bounds: { ...input.bounds, limit: 1, maxBytes: 65536 } },
    confirmation: 'many-losses', profile: profile(), signal: new AbortController().signal, authorize: () => {},
    onEvent: () => {}, onLoss: count => losses.push(count), onReady: () => {} })
  await worker.start()
  expect(losses).toEqual(Array(1100).fill(1))
})

test('stop before readiness preserves the cancellation summary without starting production', async () => {
  const directory = join(root, 'private'), events: unknown[] = [], summaries: unknown[] = []
  const spawned = new Promise<void>(resolve => { processBoundary.spawned = resolve })
  const worker = new ShodanWorker({ directory, input, confirmation: 'wait-for-stop', profile: profile(), signal: new AbortController().signal,
    authorize: () => {}, onEvent: event => events.push(event), onLoss: () => {}, onReady: () => { throw new Error('Unexpected readiness') },
    onClosed: summary => summaries.push(summary) })
  const running = worker.start()
  await spawned
  await worker.stop()
  await running
  expect(summaries).toEqual([{ stopReason: 'cancelled', count: 0, bytes: 0, partialRecordCount: 0, debugDiscarded: 0 }])
  expect(events).toEqual([])
  expect(existsSync(directory)).toBe(false)
})

test('stop before spawn cancels startup and cleans the private profile', async () => {
  const directory = join(root, 'private')
  const worker = new ShodanWorker({ directory, input, confirmation: 'synthetic', profile: profile(), signal: new AbortController().signal,
    authorize: () => {}, onEvent: () => {}, onLoss: () => {}, onReady: () => {} })
  const running = expect(worker.start()).rejects.toMatchObject({ code: 'CANCELLED' })
  await expect(worker.stop()).rejects.toMatchObject({ code: 'CANCELLED' })
  await running
  expect(existsSync(directory)).toBe(false)
})

test('worker uses the isolated profile and removes it before stop completes', async () => {
  const directory = join(root, 'private')
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const events: unknown[] = []
  const worker = new ShodanWorker({ directory, input, confirmation: 'synthetic', profile: profile(), signal: new AbortController().signal,
    authorize: () => {}, onEvent: event => events.push(event), onLoss: () => {}, onReady: ready })
  const running = worker.start()
  await started
  await worker.stop()
  await running
  expect(events).toEqual([{ profile: 'artium', isolated: true, value: 'synthetic' }])
  expect(existsSync(directory)).toBe(false)
})

test('worker output containing a managed secret is withheld and cleaned', async () => {
  const directory = join(root, 'private')
  const events: unknown[] = []
  const worker = new ShodanWorker({ directory, input, confirmation: 'leak', profile: profile(), signal: new AbortController().signal,
    authorize: () => {}, onEvent: event => events.push(event), onLoss: () => {}, onReady: () => {} })
  await expect(worker.start()).rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
  expect(events).toEqual([])
  expect(existsSync(directory)).toBe(false)
})

test('worker failure removes its private profile before returning', async () => {
  const directory = join(root, 'private')
  const worker = new ShodanWorker({ directory, input, confirmation: 'crash', profile: profile(), signal: new AbortController().signal,
    authorize: () => {}, onEvent: () => {}, onLoss: () => {}, onReady: () => {} })
  await expect(worker.start()).rejects.toThrow()
  expect(existsSync(directory)).toBe(false)
})
