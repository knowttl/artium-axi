import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import falconInventory from '../../../tools/inventories/falcon-axi.json' with { type: 'json' }
import ldapInventory from '../../../tools/inventories/ldap-axi.json' with { type: 'json' }
import type { ToolName } from '../store/credential-store.js'

export type RunAction = 'read' | 'write' | 'unknown'

// These pinned tools journal mutations after their native write gates.
const journalVariables = ['AZ_AXI_WRITE_LOG', 'MG_AXI_WRITE_LOG', 'VECTRA_AXI_WRITE_LOG']

export async function prepareRunJournal(environment: Record<string, string>, tool: ToolName, effect?: 'read' | 'write') {
  if (tool === 'tenable-axi') {
    const path = environment.TENABLE_AXI_WRITE_LOG
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
  if (tool === 'ado-axi' || tool === 'awx-axi') {
    if (!effect) throw new TypeError('Missing host-classified effect')
    return { environment, action: async (succeeded: boolean): Promise<RunAction> => effect === 'read' ? 'read' : succeeded ? 'write' : 'unknown' }
  }
  const variable = journalVariables.find(name => environment[name])
  if (!variable) {
    if (tool === 'falcon-axi' && falconInventory.requirements.nativeWrites === 'read-only upstream design'
      || tool === 'ldap-axi' && ldapInventory.adapterBoundary.nativeWrites === 'read-only upstream design') {
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
    const absent = succeeded ? 'read' : 'unknown'
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

export async function retainRunJournals(writeLog: string, tool: Exclude<ToolName, 'falcon-axi' | 'tenable-axi'>, now = Date.now()): Promise<void> {
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
