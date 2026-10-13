import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type RunAction = 'read' | 'write' | 'unknown'

// These pinned tools journal mutations after their native write gates.
// Falcon has no verified journal contract and must remain unknown.
const journalVariables = ['AZ_AXI_WRITE_LOG', 'MG_AXI_WRITE_LOG', 'VECTRA_AXI_WRITE_LOG']

export async function prepareRunJournal(environment: Record<string, string>) {
  const variable = journalVariables.find(name => environment[name])
  if (!variable) return { environment, action: async (): Promise<RunAction> => 'unknown' }
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

export async function retainRunJournals(writeLog: string, now = Date.now()): Promise<void> {
  const root = `${writeLog}.runs`
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue
    const path = join(root, entry.name)
    if ((await stat(path)).mtimeMs < now - 90 * 24 * 60 * 60 * 1000) await rm(path, { recursive: true })
  }
}
