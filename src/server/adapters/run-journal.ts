import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decode } from '@toon-format/toon'
import ldapInventory from '../../../tools/inventories/ldap-axi.json' with { type: 'json' }
import type { ToolName } from '../store/credential-store.js'
import type { PreparedCall } from './types.js'

export type RunAction = 'read' | 'write' | 'unknown'
interface RunJournal {
  environment: Record<string, string>
  action(succeeded: boolean, stdout?: string): Promise<RunAction>
  auditId?(): Promise<string>
}

// These pinned tools journal mutations after their native write gates.
const journalVariables = ['AZ_AXI_WRITE_LOG', 'MG_AXI_WRITE_LOG', 'VECTRA_AXI_WRITE_LOG', 'FALCON_AXI_WRITE_LOG']

export async function prepareRunJournal(environment: Record<string, string>, tool: ToolName, effect?: 'read' | 'write', write?: PreparedCall['write']): Promise<RunJournal> {
  if (tool === 'beyondtrust-axi') {
    const path = environment.BEYONDTRUST_AXI_WRITE_LOG
    if (!path || !effect) throw new TypeError('Missing native write journal contract')
    if (effect === 'read') return { environment, action: async succeeded => succeeded ? 'read' : 'unknown' }
    if (!write) throw new TypeError('Missing host write contract')
    const root = `${path}.runs`
    const firstCreated = await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(root, 'run-'))
    const auditId = randomUUID()
    const file = await open(join(directory, 'intent.json'), 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ auditId, operation: write.operation, state: 'intent', time: new Date().toISOString() }))
      await file.sync()
    } finally { await file.close() }
    const lastDirectory = firstCreated ? dirname(firstCreated) : root
    for (let current = directory;; current = dirname(current)) {
      const handle = await open(current, 'r')
      try { await handle.sync() } finally { await handle.close() }
      if (current === lastDirectory) break
    }
    const nativeDirectory = join(directory, 'beyondtrust-axi', 'writes')
    const nativeIntent = async (): Promise<string | undefined> => {
      try {
        const names = (await readdir(nativeDirectory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
        if (names.length !== 1) return
        const intent = JSON.parse(await readFile(join(nativeDirectory, names[0]), 'utf8'))
        if (intent.state === 'intent' && names[0] === `${intent.auditId}.json`) return intent.auditId
      } catch { return }
    }
    return { environment: { ...environment, BEYONDTRUST_AXI_WRITE_LOG: join(directory, 'writes.log') },
      auditId: async () => await nativeIntent() ?? auditId,
      action: async () => await nativeIntent() ? 'write' : 'unknown' }
  }
  if (tool === 'tenable-axi' || tool === 'hybrid-axi' || tool === 'checkpoint-axi') {
    const path = environment[`${tool.toUpperCase().replaceAll('-', '_')}_WRITE_LOG`]
    if (!path || !effect) throw new TypeError('Missing native write journal contract')
    return { environment, async action(succeeded: boolean, stdout?: string): Promise<RunAction> {
      if (effect === 'read') return succeeded ? 'read' : 'unknown'
      try {
        const output = decode(stdout ?? '') as { auditId?: string, error?: { auditId?: string } }
        const auditId = output?.auditId ?? output?.error?.auditId
        if (!auditId) return 'unknown'
        const content = await readFile(path, 'utf8')
        if (!content.endsWith('\n')) return 'unknown'
        const records = content.trim().split('\n').map(line => JSON.parse(line))
        return records.some(record => record.auditId === auditId && record.kind === 'intent') ? 'write' : 'unknown'
      } catch { return 'unknown' }
    } }
  }
  if (tool === 'ado-axi' || tool === 'awx-axi' || tool === 'gh-axi') {
    if (!effect) throw new TypeError('Missing host-classified effect')
    return { environment, action: async (succeeded: boolean): Promise<RunAction> => effect === 'read' ? 'read' : succeeded ? 'write' : 'unknown' }
  }
  const variable = journalVariables.find(name => environment[name])
  if (tool === 'falcon-axi' && effect === 'read' && variable === 'FALCON_AXI_WRITE_LOG') {
    return { environment, action: async (): Promise<RunAction> => 'read' }
  }
  if (!variable) {
    if (tool === 'ldap-axi' && ldapInventory.adapterBoundary.nativeWrites === 'read-only upstream design') {
      return { environment, action: async (): Promise<RunAction> => 'read' }
    }
    throw new TypeError('Missing native write journal contract')
  }
  const root = `${environment[variable]}.runs`
  await mkdir(root, { recursive: true, mode: 0o700 })
  // Keep the native evidence durable and isolate concurrent runs, including health reads.
  const directory = await mkdtemp(join(root, 'run-'))
  const path = join(directory, 'writes.log')
  return { environment: { ...environment, [variable]: path }, async action(succeeded: boolean): Promise<RunAction> {
    // Falcon search submissions do not emit RTR's native journal. Missing evidence
    // must not turn a classified submission into a confirmed read.
    const absent = succeeded && !(tool === 'falcon-axi' && variable === 'FALCON_AXI_WRITE_LOG' && effect === 'write') ? 'read' : 'unknown'
    try {
      const content = await readFile(path, 'utf8')
      if (!content.trim()) return absent
      if (!content.endsWith('\n')) return 'unknown'
      const records = content.trim().split('\n').map(line => JSON.parse(line))
      return records.every(record => record && typeof record === 'object' && !Array.isArray(record)) ? 'write' : 'unknown'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? absent : 'unknown'
    }
  } }
}

export async function retainRunJournals(writeLog: string, tool: Exclude<ToolName, 'falcon-axi' | 'tenable-axi' | 'hybrid-axi' | 'checkpoint-axi'>, now = Date.now()): Promise<void> {
  const root = `${writeLog}.runs`
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let failure: unknown
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue
    const path = join(root, entry.name)
    try {
      if ((await stat(path)).mtimeMs >= now - 90 * 24 * 60 * 60 * 1000) continue
      let content = ''
      try { content = await readFile(join(path, 'writes.log'), 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (content && !content.endsWith('\n')) throw new Error('Incomplete native write journal')
      for (const line of content.split('\n').filter(Boolean)) {
        const record = JSON.parse(line)
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time))) {
          throw new Error('Invalid native write journal')
        }
        if (tool === 'az-axi') {
          if (!['profile', 'identity', 'class', 'method', 'url', 'outcome'].every(field => typeof record[field] === 'string')
            || !Number.isInteger(record.httpStatus)) throw new Error('Invalid native write journal')
        } else if (!['intent', 'outcome'].includes(record.kind) || typeof record.intentKey !== 'string'
          || !/^[a-f0-9]{64}$/.test(record.intentKey)) throw new Error('Invalid native write journal')
      }
      await rm(path, { recursive: true })
    } catch (error) { failure ??= error }
  }
  if (failure) throw failure
}
